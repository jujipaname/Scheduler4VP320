/*
 * validate-player.js - Live validation against a real VP320/VP330 player.
 *
 * Pure Node (no external deps). Requires network access to the player.
 *
 * Checks:
 *   1. HTTP reachability of the embedded web server.
 *   2. Digest auth (RFC 2617) against the official REST API (api.js):
 *        - POST /api/auth/login
 *        - GET  /api/system/state        (informational + firmware version)
 *        - GET  /api/storages            (informational: mounted storages)
 *   3. Optional FTP: connect to the player's FTP server, ensure /SYSTEM,
 *      upload the generated scheduler.tm2 (roundtripped through tm2.js).
 *   4. Always writes a full JSON snapshot of state + storages
 *      (player-state.json) so firmware/NTP/storages can be inspected offline.
 *
 * Usage:
 *   node validate-player.js --host=192.168.1.100 [--user=admin] [--pass=admin]
 *                            [--ftp-port=21] [--upload] [--out=report-live.json]
 *                            [--snapshot=player-state.json]
 *
 * Exit code: 0 = all checks OK, 1 = at least one failure.
 */

'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const TM2 = require('./tm2.js');
const API = require('./api.js');

function arg(key, def) {
  const p = '--' + key + '=';
  const a = process.argv.find(s => s.startsWith(p));
  // slice (not split) so values may contain '=' (e.g. passwords)
  return a ? a.slice(p.length) : def;
}

// Node.js 18+ is required: native fetch, AbortSignal.timeout (17.3+).
if (typeof fetch !== 'function' || typeof AbortSignal === 'undefined' ||
    typeof AbortSignal.timeout !== 'function') {
  const msg = 'Node.js ' + process.version + ' trop ancien : Node.js 18+ requis (fetch natif).';
  console.error('  [FAIL] Environnement Node.js  ' + msg);
  const out = arg('out', 'report-live.json');
  fs.writeFileSync(out, JSON.stringify({
    suite: 'live', host: arg('host', ''), generatedAt: new Date().toISOString(),
    total: 1, passed: 0, failed: 1,
    results: [{ name: 'Environnement Node.js', pass: false, detail: msg }]
  }, null, 2));
  process.exit(1);
}

const HOST = arg('host', '192.168.1.100');
const HTTP_PORT = Number(arg('http-port', 80));
const USER = arg('user', 'admin');
const PASS = arg('pass', 'admin');
const FTP_PORT = Number(arg('ftp-port', 21));
const DO_UPLOAD = arg('upload', '') === '1' || arg('upload', '') === 'true';
const OUT = arg('out', 'report-live.json');
const BASE = 'http://' + HOST + (HTTP_PORT === 80 ? '' : ':' + HTTP_PORT);

const results = [];
function add(name, pass, detail) { results.push({ name, pass, detail: detail || '' }); console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}  ${detail || ''}`); }

// Full JSON bodies kept aside so the firmware version / NTP / storages can be
// inspected offline (the report only shows a truncated detail line).
const snapshot = { host: HOST, generatedAt: new Date().toISOString(), state: null, storages: null };

// Best-effort extraction of firmware version fields, schema may vary.
function findVersion(obj, depth) {
  if (!obj || typeof obj !== 'object' || (depth || 0) > 4) return '';
  for (const k of Object.keys(obj)) {
    if (/^(firmware|fw|software|sw|version|app|build)/i.test(k)) {
      const v = obj[k];
      if (typeof v === 'string') return v;
      if (typeof v === 'number') return String(v);
      if (v && typeof v === 'object') {
        const inner = findVersion(v, (depth || 0) + 1);
        if (inner) return inner;
      }
    }
  }
  for (const k of Object.keys(obj)) {
    if (obj[k] && typeof obj[k] === 'object') {
      const inner = findVersion(obj[k], (depth || 0) + 1);
      if (inner) return inner;
    }
  }
  return '';
}

// ---- minimal FTP client (control + passive data) -------------------------
function withTimeout(promise, ms, what) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('Timeout (' + ms + 'ms) pendant ' + what)), ms);
    promise.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); });
  });
}

function ftpUpload(host, port, user, pass, remoteDir, data) {
  const task = new Promise((resolve, reject) => {
    const sock = net.createConnection(port, host);
    let lineBuf = '';
    const waiters = [];

    sock.on('data', (d) => {
      lineBuf += d.toString();
      let idx;
      while ((idx = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, idx).replace(/\r$/, '');
        lineBuf = lineBuf.slice(idx + 1);
        if (/^1\d\d/.test(line)) continue; // 1xx preliminary
        const w = waiters.shift();
        if (w) w(line);
      }
    });
    sock.on('error', reject);
    sock.on('close', () => { reject(new Error('FTP fermé prématurément')); });

    function send(s) { sock.write(s + '\r\n'); }
    function expect() {
      return new Promise((res) => waiters.push(res));
    }

    (async () => {
      const step = (m) => { if (process.env.FTP_DEBUG) console.error('  ftp>', m); };
      let line = await expect();
      step('banner: ' + line);
      if (!/^220/.test(line)) throw new Error('Bannière inattendue: ' + line);
      send('USER ' + user); line = await expect(); step('USER: ' + line); if (!/^331|^230/.test(line)) throw new Error('USER: ' + line);
      send('PASS ' + pass); line = await expect(); step('PASS: ' + line); if (!/^230/.test(line)) throw new Error('Auth refusée: ' + line);
      send('TYPE I'); line = await expect(); step('TYPE: ' + line);
      send('PASV'); line = await expect(); step('PASV: ' + line);
      const m = line.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/);
      if (!m) throw new Error('PASV invalide: ' + line);
      const dataPort = Number(m[5]) * 256 + Number(m[6]);

      const dataSock = net.createConnection(dataPort, host);
      await new Promise((res, rej) => { dataSock.once('connect', res); dataSock.once('error', rej); });
      step('data connected');
      send('STOR ' + remoteDir + '/scheduler.tm2');
      dataSock.write(data);
      dataSock.end();

      line = await expect(); step('after STOR (150): ' + line);
      line = await expect(); step('after STOR (226): ' + line);
      if (!/^226/.test(line)) throw new Error('STOR: ' + line);
      send('QUIT');
      sock.destroy();
      resolve();
    })().catch(reject);
  });
  return withTimeout(task, 15000, 'upload FTP');
}

async function run() {
  console.log('='.repeat(60));
  console.log(`  Scheduler4VP320 — Validation live du player ${HOST}`);
  console.log('='.repeat(60));

  const T = 8000; // per-request timeout ms
  const to = () => AbortSignal.timeout(T);

  // 1. reachability
  const reachable = await fetch(BASE + '/api/system/state', { method: 'GET', signal: to() }).then(() => true).catch(() => false);
  add('Serveur web joignable', reachable, reachable ? BASE : 'pas de réponse HTTP');

  // 2. Digest auth
  try {
    const login = await withTimeout(API.login({ base: BASE, username: USER, password: PASS }), T, 'login');
    add('Auth Digest /api/auth/login', login.ok, login.ok ? 'HTTP 200' : 'réponse != 200');
  } catch (e) {
    add('Auth Digest /api/auth/login', false, 'exception: ' + e.message);
  }

  // 3. state / storages (informational, only if auth works)
  const client = API.createClient({ base: BASE, username: USER, password: PASS });
  try {
    const s = await withTimeout(client.request('/api/system/state', 'GET'), T, 'system/state');
    let detail = 'HTTP ' + s.status;
    let body = null;
    try { body = await s.json(); } catch (_) {}
    if (body) {
      snapshot.state = body;
      detail += ' - ' + JSON.stringify(body).slice(0, 120);
      const fw = findVersion(body);
      if (fw) detail += ' | firmware: ' + fw;
    }
    add('GET /api/system/state', s.status === 200, detail);
  } catch (e) { add('GET /api/system/state', false, 'exception: ' + e.message); }

  // 4. storages (informational): confirms what is mounted (USB / SD / SYSTEM)
  try {
    const st = await withTimeout(client.request('/api/storages', 'GET'), T, 'storages');
    let body = null;
    try { body = await st.json(); } catch (_) {}
    if (body) snapshot.storages = body;
    let names = '';
    const list = body && (Array.isArray(body) ? body : (body.data || body.storages));
    if (Array.isArray(list)) {
      names = list.map(function (x) {
        return (x && (x.name || x.label || x.path || x.type)) || '?';
      }).join(', ');
    }
    add('GET /api/storages', st.status === 200, 'HTTP ' + st.status + (names ? ' - ' + names : ''));
  } catch (e) { add('GET /api/storages', false, 'exception: ' + e.message); }

  // 4. FTP upload (optional)
  if (DO_UPLOAD) {
    try {
      const model = TM2.parse(fs.readFileSync('scheduler2.tm2'));
      const data = Buffer.from(TM2.encode(model));
      await ftpUpload(HOST, FTP_PORT, USER, PASS, '/SYSTEM', data);
      add('FTP upload /SYSTEM/scheduler.tm2', true, `envoyé ${data.length} octets`);
    } catch (e) {
      add('FTP upload /SYSTEM/scheduler.tm2', false, 'exception: ' + e.message);
    }
  } else {
    add('FTP upload /SYSTEM/scheduler.tm2', true, 'ignoré (ajouter --upload)');
  }

  // 5. full snapshot, for offline inspection (firmware, NTP, storages)
  const snapshotPath = arg('snapshot', 'player-state.json');
  try {
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
    console.log('  (snapshot complet : ' + snapshotPath + ')');
  } catch (e) {
    console.error('  (snapshot non ecrit : ' + e.message + ')');
  }

  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log('-'.repeat(60));
  console.log(`  ${passed} succès, ${failed} échec(s) sur ${results.length}`);
  fs.writeFileSync(OUT, JSON.stringify({ suite: 'live', host: HOST, generatedAt: new Date().toISOString(), total: results.length, passed, failed, results }, null, 2));
  process.exit(failed ? 1 : 0);
}

// safety net: always exit, even if something hangs
setTimeout(() => { console.error('❌ Garde-temps global (60s) — arrêt forcé'); process.exit(1); }, 60000).unref();

run().catch(e => { console.error('Erreur fatale:', e.message); process.exit(1); });
