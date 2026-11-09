/*
 * ftp.js - Minimal FTP client for the VP320/VP330 (pure Node, no dependency).
 *
 * Supports: USER/PASS, TYPE I, CWD (absolute, relative, one level of LIST),
 * MKD, LIST, RETR and STOR through passive mode (PASV). Multi-line replies and
 * replies arriving before they are awaited are handled.
 *
 * On a VP320 the FTP root lists the storages, so the real path is e.g.
 * "/Internal shared storage/SYSTEM": ftpResolveDir() finds it from the storage
 * names returned by the REST API, from the root listing, or creates it.
 */

'use strict';

const net = require('net');

function withTimeout(promise, ms, what) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('Timeout (' + ms + 'ms) pendant ' + what)), ms);
    promise.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); });
  });
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

module.exports = {
  withTimeout,
  ftpHint,
  parseListNames,
  ftpConnect,
  ftpList,
  ftpResolveDir,
  ftpRetr,
  ftpPut
};
