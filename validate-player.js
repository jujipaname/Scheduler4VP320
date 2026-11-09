/*
 * validate-player.js - Live validation against a real VP320/VP330 player.
 *
 * Pure Node (no external deps). Requires network access to the player.
 *
 * Checks:
 *   1. HTTP reachability of the embedded web server.
 *   2. Digest auth (RFC 2617) against the official REST API (api.js):
 *        - POST /api/auth/login
 *   3. GET /api/system/attributes  -> model, serial, firmware version
 *      (fails when firmware < 1.13.1, the first release supporting scheduler.tm2)
 *   4. GET  /api/system/state      (informational)
 *   5. GET  /api/storages          (informational: mounted storages)
 *   6. Optional FTP (-upload): download the existing /SYSTEM/scheduler.tm2 as a
 *      backup, then upload the generated one. --file selects the local .tm2 to
 *      send (default: scheduler2.tm2). Separate FTP credentials can be given
 *      with --ftp-user / --ftp-pass (the FTP account may differ from the
 *      REST/Digest account). The remote directory is resolved against the
 *      account's FTP root (absolute, relative, case-insensitive), and --mkdir
 *      creates SYSTEM when it does not exist yet.
 *   7. Always writes a full JSON snapshot (player-state.json) so firmware,
 *      storages and FTP banner can be inspected offline.
 *
 * Usage:
 *   node validate-player.js --host=192.168.1.100 [--user=admin] [--pass=admin]
 *                            [--http-port=80] [--ftp-port=21]
 *                            [--ftp-user=...] [--ftp-pass=...]
 *                            [--upload] [--file=scheduler2.tm2] [--dir=/SYSTEM]
 *                            [--mkdir] [--no-backup]
 *                            [--out=report-live.json] [--snapshot=player-state.json]
 *
 * Environment: FTP_DEBUG=1 traces every FTP exchange.
 * Exit code: 0 = all checks OK, 1 = at least one failure.
 */

'use strict';

const fs = require('fs');
const net = require('net');

const TM2 = require('./tm2.js');
const API = require('./api.js');

// ------------------------------------------------------------------- args
function arg(key, def) {
  const p = '--' + key + '=';
  const a = process.argv.find(s => s.startsWith(p));
  // slice (not split) so values may contain '=' (e.g. passwords)
  return a ? a.slice(p.length) : def;
}

// bare switch: --name, --name=1, --name=true ; --name=0 / =false disables it
function flag(key) {
  const p = '--' + key;
  const a = process.argv.find(s => s === p || s.startsWith(p + '='));
  if (!a) return false;
  return !/=(0|false|no)$/i.test(a);
}

const HOST = arg('host', '192.168.1.100');
const HTTP_PORT = Number(arg('http-port', 80));
const USER = arg('user', 'admin');
const PASS = arg('pass', 'admin');
const FTP_PORT = Number(arg('ftp-port', 21));
const FTP_USER = arg('ftp-user', '') || USER;
const FTP_PASS = arg('ftp-pass', '') || PASS;
const TM2_FILE = arg('file', 'scheduler2.tm2');
const REMOTE_DIR = arg('dir', '/SYSTEM');
const DO_UPLOAD = flag('upload');
const DO_BACKUP = !flag('no-backup');
const DO_MKDIR = flag('mkdir');
const OUT = arg('out', 'report-live.json');
const SNAPSHOT = arg('snapshot', 'player-state.json');
const BASE = 'http://' + HOST + (HTTP_PORT === 80 ? '' : ':' + HTTP_PORT);
const MIN_FIRMWARE = '1.13.1'; // first release that interprets /SYSTEM/scheduler.tm2

const results = [];
function add(name, pass, detail) {
  results.push({ name, pass, detail: detail || '' });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}  ${detail || ''}`);
}

// Full JSON bodies kept aside: the report only shows a truncated detail line.
const snapshot = {
  host: HOST,
  generatedAt: new Date().toISOString(),
  attributes: null,
  state: null,
  storages: null,
  storageCurrent: null,
  folders: null,
  ftp: null
};

// Node.js 18+ is required: native fetch, AbortSignal.timeout (17.3+).
if (typeof fetch !== 'function' || typeof AbortSignal === 'undefined' ||
    typeof AbortSignal.timeout !== 'function') {
  const msg = 'Node.js ' + process.version + ' trop ancien : Node.js 18+ requis (fetch natif).';
  console.error('  [FAIL] Environnement Node.js  ' + msg);
  fs.writeFileSync(OUT, JSON.stringify({
    suite: 'live', host: HOST, generatedAt: new Date().toISOString(),
    total: 1, passed: 0, failed: 1,
    results: [{ name: 'Environnement Node.js', pass: false, detail: msg }]
  }, null, 2));
  process.exit(1);
}

function withTimeout(promise, ms, what) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('Timeout (' + ms + 'ms) pendant ' + what)), ms);
    promise.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); });
  });
}

// ----------------------------------------------------------- version check
function parseVersion(v) {
  const m = String(v == null ? '' : v).match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : null;
}

// null when unparsable, true/false otherwise
function versionAtLeast(v, min) {
  const a = parseVersion(v);
  const b = parseVersion(min);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

// ------------------------------------------------------------------- FTP
const FTP_HINTS = {
  '421': 'le serveur FTP ferme la session (trop de connexions ?)',
  '425': 'connexion de donnees impossible : mode passif bloque (pare-feu / routeur)',
  '500': 'commande inconnue du serveur FTP du player',
  '502': 'commande non supportee par le serveur FTP du player',
  '530': "identifiants FTP refuses. Le compte FTP peut differer du compte REST : " +
         'essayer -FtpUser/-FtpPass (ou "anonymous"), et verifier que le serveur FTP ' +
         'est active dans les reglages du player',
  '550': "chemin refuse ou inexistant : le dossier /SYSTEM doit exister sur le stockage cible"
};

function ftpHint(text) {
  const h = FTP_HINTS[String(text || '').slice(0, 3)];
  return h ? ' -> ' + h : '';
}

// Open the control connection and expose a tiny pipelined-command API.
function ftpConnect(host, port, timeoutMs) {
  const task = new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    let buf = '';
    let multi = null;
    const pending = [];   // awaiting readers
    const queue = [];     // replies received before anyone asked (banner, fast servers)

    function deliver(r) {
      const w = pending.shift();
      if (w) w(r); else queue.push(r);
    }

    sock.setEncoding('utf8');
    sock.on('data', chunk => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        const code = line.slice(0, 3);
        const sep = line.charAt(3);
        if (multi) {
          // continuation of a multi-line reply such as "220-Welcome"
          multi.text += '\n' + line;
          if (code === multi.code && sep === ' ') {
            const done = multi;
            multi = null;
            deliver(done);
          }
          continue;
        }
        if (/^\d{3}-$/.test(code + sep)) { multi = { code, text: line }; continue; }
        deliver({ code, text: line });
      }
    });
    function fail(text) { while (pending.length) deliver({ code: '000', text }); }
    sock.on('error', err => { fail('erreur socket : ' + err.message); reject(err); });
    sock.on('close', () => { fail('connexion FTP fermee par le serveur'); });

    const session = {
      reply() {
        if (queue.length) return Promise.resolve(queue.shift());
        return new Promise(res => pending.push(res));
      },
      // next definitive (non 1xx) reply
      async final() {
        let r = await session.reply();
        while (/^1/.test(r.code)) r = await session.reply();
        return r;
      },
      raw(s) { sock.write(s + '\r\n'); },
      async cmd(line, okRe, what) {
        if (process.env.FTP_DEBUG) console.error('  ftp>', line);
        session.raw(line);
        const r = await session.final();
        if (process.env.FTP_DEBUG) console.error('  ftp<', r.text);
        if (okRe && !okRe.test(r.code)) {
          throw new Error((what || line) + ' : ' + r.text + ftpHint(r.text));
        }
        return r;
      },
      async pasv() {
        const r = await session.cmd('PASV', /^227/, 'PASV');
        const m = /\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/.exec(r.text);
        if (!m) throw new Error('PASV invalide : ' + r.text);
        return Number(m[5]) * 256 + Number(m[6]);
      },
      openData(dataPort) {
        return withTimeout(new Promise((res, rej) => {
          const ds = net.createConnection({ host, port: dataPort });
          ds.once('connect', () => res(ds));
          ds.once('error', rej);
        }), timeoutMs, 'connexion de donnees FTP');
      },
      close() { try { sock.destroy(); } catch (_) {} }
    };
    resolve(session);
  });
  return withTimeout(task, timeoutMs, 'connexion FTP ' + host + ':' + port);
}

// Parse a LIST payload into directory/file names (UNIX and DOS formats).
function parseListNames(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !/^total\s/i.test(l))
    .map(line => {
      let m = /^\S+\s+\d+\s+\S+\s+\S+\s+\d+\s+\S+\s+\S+\s+\S+\s+(.+)$/.exec(line);
      if (m) return m[1].trim();                                  // UNIX
      m = /^\d{2}-\d{2}-\d{2,4}\s+\S+\s+(?:<DIR>|\d+)\s+(.+)$/i.exec(line);
      if (m) return m[1].trim();                                  // DOS
      const parts = line.split(/\s+/);
      return parts[parts.length - 1];
    })
    .filter(n => n && n !== '.' && n !== '..');
}

async function ftpList(session, timeoutMs) {
  const dataPort = await session.pasv();
  const ds = await session.openData(dataPort);
  session.raw('LIST');
  const first = await session.reply();
  if (!/^(125|150)$/.test(first.code)) {
    ds.destroy();
    return { entries: [], reply: first.text };
  }
  const chunks = [];
  await withTimeout(new Promise((res, rej) => {
    ds.on('data', c => chunks.push(Buffer.from(c)));
    ds.on('end', res);
    ds.on('error', rej);
  }), timeoutMs, 'reception de LIST');
  const last = await session.reply();
  return { entries: parseListNames(Buffer.concat(chunks).toString('utf8')), reply: last.text };
}

// Enter remoteDir, adapting to the server layout. The FTP root is not always
// the storage root: on a VP320 the account may see e.g.
//   /Internal shared storage/SYSTEM
// so we try the given path, relative forms, the storage names reported by the
// REST API, and finally one level down from the root listing.
async function ftpResolveDir(session, wanted, opts, timeoutMs) {
  const tried = [];
  const base = wanted.replace(/^\/+/, '');
  const push = (arr, d) => { if (d && arr.indexOf(d) === -1) arr.push(d); };

  async function tryCwd(dir) {
    const r = await session.cmd('CWD ' + dir, null, 'CWD');
    tried.push({ dir, reply: r.text });
    return /^2/.test(r.code);
  }

  const cands = [];
  push(cands, wanted);
  push(cands, base);
  push(cands, './' + base);
  for (const hint of (opts.dirHints || [])) {
    push(cands, '/' + hint + '/' + base);
    push(cands, hint + '/' + base);
  }
  for (const dir of cands) {
    if (await tryCwd(dir)) return { dir, tried, entries: [] };
  }

  // Still failing: inspect the FTP root and try <entry>/SYSTEM for each entry.
  const list = await ftpList(session, timeoutMs);
  const entries = list.entries;
  const exact = entries.filter(e => e.replace(/\/$/, '').toLowerCase() === base.toLowerCase())[0];
  if (exact && await tryCwd(exact)) return { dir: exact, tried, entries };
  for (const e of entries.slice(0, 10)) {
    const dir = e.replace(/\/$/, '');
    if (await tryCwd(dir + '/' + base)) return { dir: dir + '/' + base, tried, entries };
  }

  if (opts.mkdir) {
    for (const parent of [''].concat(entries.slice(0, 10))) {
      const target = parent ? parent.replace(/\/$/, '') + '/' + base : base;
      const mk = await session.cmd('MKD ' + target, null, 'MKD');
      tried.push({ dir: 'MKD ' + target, reply: mk.text });
      if (/^2/.test(mk.code) || /^550/.test(mk.code)) {
        if (await tryCwd(target)) return { dir: target, tried, entries };
      }
    }
  }

  const lastReply = tried.length ? tried[tried.length - 1].reply : 'aucune reponse';
  const shownTried = tried.slice(0, 6).map(t => t.dir).join(', ');
  let msg = 'CWD ' + wanted + ' impossible (' + lastReply + ')';
  msg += ' ; essais = [' + shownTried + ']';
  if (entries.length) msg += ' ; racine FTP = [' + entries.slice(0, 10).join(', ') + ']';
  else msg += ' ; racine FTP vide ou LIST non supporte par le serveur';
  msg += ' -> indiquer le bon chemin avec -RemoteDir';
  const err = new Error(msg);
  err.ftpTried = tried;
  err.ftpEntries = entries;
  throw err;
}

async function ftpRetr(session, name, timeoutMs) {
  const dataPort = await session.pasv();
  const ds = await session.openData(dataPort);
  session.raw('RETR ' + name);
  const first = await session.reply();
  if (!/^(125|150)$/.test(first.code)) {
    ds.destroy();
    // 550 on RETR simply means "no existing file": nothing to back up.
    if (/^550/.test(first.code)) return null;
    throw new Error('RETR ' + name + ' : ' + first.text + ftpHint(first.text));
  }
  const chunks = [];
  await withTimeout(new Promise((res, rej) => {
    ds.on('data', c => chunks.push(Buffer.from(c)));
    ds.on('end', res);
    ds.on('error', rej);
  }), timeoutMs, 'reception des donnees FTP');
  const last = await session.reply();
  if (!/^226/.test(last.code)) throw new Error('RETR ' + name + ' : ' + last.text);
  return Buffer.concat(chunks);
}

async function ftpPut(host, port, user, pass, remoteDir, name, data, opts) {
  const T = 15000;
  const session = await ftpConnect(host, port, T);
  const info = { banner: '', dir: '', rootEntries: [], backup: null, backupError: '' };
  try {
    const b = await session.final();
    info.banner = b.text;
    if (!/^220/.test(b.code)) throw new Error('Banniere inattendue : ' + b.text);
    await session.cmd('USER ' + user, /^(331|230)$/, 'USER');
    await session.cmd('PASS ' + pass, /^230$/, 'PASS');
    await session.cmd('TYPE I', /^200$/, 'TYPE I');

    const resolved = await ftpResolveDir(session, remoteDir, opts, T);
    info.dir = resolved.dir;
    info.rootEntries = resolved.entries;

    if (opts.backup) {
      try { info.backup = await ftpRetr(session, name, T); }
      catch (e) { info.backupError = e.message; }
    }

    const dataPort = await session.pasv();
    const ds = await session.openData(dataPort);
    if (process.env.FTP_DEBUG) console.error('  ftp> (data) STOR', name);
    session.raw('STOR ' + name);
    const first = await session.reply();
    if (!/^(125|150)$/.test(first.code)) {
      ds.destroy();
      throw new Error('STOR ' + name + ' : ' + first.text + ftpHint(first.text));
    }
    await withTimeout(new Promise((res, rej) => {
      ds.on('error', rej);
      ds.end(data, res);
    }), T, 'envoi des donnees FTP');
    const last = await session.reply();
    if (!/^226/.test(last.code)) throw new Error('STOR ' + name + ' : ' + last.text + ftpHint(last.text));
    session.raw('QUIT');
  } finally {
    session.close();
  }
  return info;
}

// ------------------------------------------------------------------- main
async function run() {
  console.log('='.repeat(60));
  console.log(`  Scheduler4VP320 - Validation live du player ${HOST}`);
  console.log('='.repeat(60));

  const T = 8000; // per-request timeout ms
  const to = () => AbortSignal.timeout(T);

  // 1. reachability
  const reachable = await fetch(BASE + '/api/system/state', { method: 'GET', signal: to() })
    .then(() => true).catch(() => false);
  add('Serveur web joignable', reachable, reachable ? BASE : 'pas de reponse HTTP');

  // 2. Digest auth
  try {
    const login = await withTimeout(API.login({ base: BASE, username: USER, password: PASS }), T, 'login');
    add('Auth Digest /api/auth/login', login.ok, login.ok ? 'HTTP 200' : 'reponse != 200');
  } catch (e) {
    add('Auth Digest /api/auth/login', false, 'exception: ' + e.message);
  }

  const client = API.createClient({ base: BASE, username: USER, password: PASS });

  // 3. system attributes: model, serial, firmware version
  try {
    const r = await withTimeout(client.request('/api/system/attributes', 'GET'), T, 'system/attributes');
    let body = null;
    try { body = await r.json(); } catch (_) {}
    const attrs = (body && body.data) || body;
    if (attrs) snapshot.attributes = body;

    let detail = 'HTTP ' + r.status;
    let ok = r.status === 200;
    if (attrs) {
      if (attrs.model) detail += ' - ' + attrs.model;
      if (attrs.serialnumber) detail += ' / ' + attrs.serialnumber;
      const fw = attrs.firmware && attrs.firmware.version;
      if (fw) {
        detail += ' / firmware ' + fw;
        if (attrs.firmware.date) detail += ' (' + String(attrs.firmware.date).slice(0, 10) + ')';
        const recent = versionAtLeast(fw, MIN_FIRMWARE);
        if (recent === false) {
          ok = false;
          detail += ' - firmware < ' + MIN_FIRMWARE + ' : scheduler.tm2 non interprete';
        }
        if (recent === null) detail += ' - version non comparable';
      } else {
        detail += ' - version firmware absente de la reponse';
      }
    }
    add('GET /api/system/attributes (firmware)', ok, detail);
  } catch (e) {
    add('GET /api/system/attributes (firmware)', false, 'exception: ' + e.message);
  }

  // 4. system state (informational)
  try {
    const r = await withTimeout(client.request('/api/system/state', 'GET'), T, 'system/state');
    let body = null;
    try { body = await r.json(); } catch (_) {}
    if (body) snapshot.state = body;
    let detail = 'HTTP ' + r.status;
    if (body) detail += ' - ' + JSON.stringify(body).slice(0, 120);
    add('GET /api/system/state', r.status === 200, detail);
  } catch (e) {
    add('GET /api/system/state', false, 'exception: ' + e.message);
  }

  // 5. storages (informational): where /SYSTEM lives
  let firstStorage = null;
  let storageNames = [];
  try {
    const r = await withTimeout(client.request('/api/storages', 'GET'), T, 'storages');
    let body = null;
    try { body = await r.json(); } catch (_) {}
    if (body) snapshot.storages = body;
    const list = (body && (body.data || body)) || [];
    if (Array.isArray(list) && list.length) firstStorage = list[0];
    const names = (Array.isArray(list) ? list : []).map(s => {
      const label = (s.type ? s.type + ':' : '') + (s.name || s.id || '?');
      return label;
    });
    if (Array.isArray(list)) {
      storageNames = list.map(s => s.name).filter(Boolean);
    }
    add('GET /api/storages', r.status === 200, 'HTTP ' + r.status + (names.length ? ' - ' + names.join(', ') : ''));
  } catch (e) {
    add('GET /api/storages', false, 'exception: ' + e.message);
  }

  // 5b. current storage + its media folders (snapshot only, never fails)
  try {
    const r = await withTimeout(client.request('/api/storages/current', 'GET'), T, 'storages/current');
    let body = null;
    try { body = await r.json(); } catch (_) {}
    if (body) {
      snapshot.storageCurrent = body;
      const cur = body.data || body;
      if (cur && cur.id) firstStorage = cur;
    }
    const f = await withTimeout(client.request('/api/storages/current/folders', 'GET'), T, 'storages/current/folders');
    let fbody = null;
    try { fbody = await f.json(); } catch (_) {}
    if (fbody) {
      snapshot.folders = fbody;
      const folders = fbody.data || fbody;
      if (Array.isArray(folders)) {
        console.log('  (dossiers medias : ' + folders.slice(0, 8).map(x => x.number || x.name).join(', ') +
                    (folders.length > 8 ? ' ...' : '') + ')');
      }
    }
  } catch (_) { /* informational only */ }

  // 6. FTP upload (optional), with backup of the existing file
  const ftpTarget = 'scheduler.tm2';
  if (DO_UPLOAD) {
    try {
      if (!fs.existsSync(TM2_FILE)) throw new Error('fichier .tm2 introuvable : ' + TM2_FILE);
      const model = TM2.parse(fs.readFileSync(TM2_FILE));
      const data = Buffer.from(TM2.encode(model));
      const info = await withTimeout(
        ftpPut(HOST, FTP_PORT, FTP_USER, FTP_PASS, REMOTE_DIR, ftpTarget, data,
               { backup: DO_BACKUP, mkdir: DO_MKDIR, dirHints: storageNames }),
        45000, 'upload FTP complet');
      snapshot.ftp = { banner: info.banner, dir: info.dir, root: info.rootEntries };
      let detail = 'envoye ' + data.length + ' octets (' + TM2_FILE + ')';
      if (FTP_USER !== USER) detail += ' (compte FTP: ' + FTP_USER + ')';
      if (info.backup) {
        const backupName = ftpTarget + '.backup';
        try {
          fs.writeFileSync(backupName, info.backup);
          detail += ' ; ancien fichier sauvegarde (' + info.backup.length + ' octets -> ' + backupName + ')';
        } catch (e) {
          detail += ' ; ancien fichier recupere mais non ecrit (' + e.message + ')';
        }
      } else if (info.backupError) {
        detail += ' ; pas de sauvegarde (' + info.backupError + ')';
      } else {
        detail += ' ; aucun ' + ftpTarget + ' existant a sauvegarder';
      }
      if (info.dir && info.dir.replace(/^\/+/, '') !== REMOTE_DIR.replace(/^\/+/, '')) {
        detail += ' ; dossier distant = ' + info.dir;
      }
      add('FTP upload ' + (info.dir || REMOTE_DIR) + '/' + ftpTarget, true, detail);
    } catch (e) {
      add('FTP upload /SYSTEM/' + ftpTarget, false, 'exception: ' + e.message);
    }
  } else {
    add('FTP upload /SYSTEM/' + ftpTarget, true, 'ignore (ajouter --upload)');
  }

  if (firstStorage) {
    console.log('  (stockage cible : ' + (firstStorage.name || firstStorage.id) + ')');
  }

  // 7. full snapshot, for offline inspection
  try {
    fs.writeFileSync(SNAPSHOT, JSON.stringify(snapshot, null, 2));
    console.log('  (snapshot complet : ' + SNAPSHOT + ')');
  } catch (e) {
    console.error('  (snapshot non ecrit : ' + e.message + ')');
  }

  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log('-'.repeat(60));
  console.log(`  ${passed} succes, ${failed} echec(s) sur ${results.length}`);
  fs.writeFileSync(OUT, JSON.stringify({
    suite: 'live',
    host: HOST,
    generatedAt: new Date().toISOString(),
    total: results.length,
    passed,
    failed,
    results
  }, null, 2));
  process.exit(failed ? 1 : 0);
}

// Safety net: NOT unref'd on purpose. If something hangs, the process must
// report a failure instead of exiting silently with status 0.
setTimeout(() => {
  console.error('Garde-temps global (90s) - arret force');
  try {
    fs.writeFileSync(OUT, JSON.stringify({
      suite: 'live', host: HOST, generatedAt: new Date().toISOString(),
      total: 1, passed: 0, failed: 1,
      results: [{ name: 'Garde-temps global', pass: false, detail: 'blocage > 90s (FTP ou reseau)' }]
    }, null, 2));
  } catch (_) {}
  process.exit(1);
}, 90000);

run().catch(e => { console.error('Erreur fatale:', e.message); process.exit(1); });
