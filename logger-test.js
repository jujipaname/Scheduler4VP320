/*
 * logger-test.js - Probe the "Logger" REST domain of the VP320/VP330.
 *
 * The documented REST API has no file manager, EXCEPT the Logger domain:
 *   GET    /api/logs               list file identifiers
 *   GET    /api/logs/:logid/stat   size of a file
 *   GET    /api/logs/:logid/read?offset&length  content, base64
 *   GET    /api/logs/:logid        content as plain text (accepts Range)
 *   POST   /api/logs/:logid        {"data":"..."} - APPEND into the file
 *   DELETE /api/logs/:logid
 *
 * If the identifier accepts paths (or the append keeps raw bytes), the web
 * editor hosted by the player could READ the current /SYSTEM/scheduler.tm2 and
 * maybe even WRITE it back over REST - no FTP deploy from a PC needed.
 *
 * This probe answers four questions on the real hardware:
 *   1) what identifiers exist (naming convention, folder?);
 *   2) is POST append byte-safe for binary payloads (base64 round trip);
 *   3) can the Logger be pointed at /SYSTEM/scheduler.tm2 (READ it, parse it);
 *   4) does the web server serve /SYSTEM/... over plain HTTP as a fallback?
 *
 * Nothing is deleted except the probe file we create ourselves. Usage:
 *   node logger-test.js --host=192.168.8.20 --user=admin --pass=password
 *
 * Both -Key value and --key=value forms are accepted (see clock-test.js).
 * Output details are also saved in logger-test.json.
 */

'use strict';

const fs = require('fs');
const TM2 = require('./tm2.js');

// ------------------------------------------------------------------- args
const OPTIONS = {};
const SWITCHES = new Set();
(function parseArgs() {
  const av = process.argv.slice(2);
  const keyOf = s => s.replace(/^--?/, '').toLowerCase().replace(/[-_]/g, '');
  const isOption = s => /^--?[A-Za-z]/.test(s);
  for (let i = 0; i < av.length; i++) {
    const a = av[i];
    if (!isOption(a)) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) { OPTIONS[keyOf(a.slice(0, eq))] = a.slice(eq + 1); continue; }
    const k = keyOf(a);
    const next = av[i + 1];
    if (next !== undefined && !isOption(next)) { OPTIONS[k] = next; i++; }
    else SWITCHES.add(k);
  }
})();
function arg(key, def) {
  const v = OPTIONS[String(key).toLowerCase().replace(/[-_]/g, '')];
  return v === undefined ? def : v;
}
function flag(key) {
  const k = String(key).toLowerCase().replace(/[-_]/g, '');
  if (SWITCHES.has(k)) return true;
  const v = OPTIONS[k];
  return v !== undefined && !/^(0|false|no)$/i.test(v);
}

const HOST = arg('host', '192.168.1.100');
const HTTP_PORT = Number(arg('noplugins', 0) ? 0 : arg('http-port'.slice(0), 0) || arg('port', 80));
const USER = arg('user', 'admin');
const PASS = arg('pass', 'admin');
const BASE = 'http://' + HOST + (HTTP_PORT && HTTP_PORT !== 80 ? ':' + HTTP_PORT : '');
const PROBE_ID = arg('probe', 's4vp-probe.bin');
const NO_CLEANUP = flag('no-cleanup');

function fail(msg) { console.error('[ERREUR] ' + msg); process.exit(1); }

// ---------------------------------------------------------------- output
const out = { host: HOST, when: new Date().toISOString(), steps: [] };
const log = [];
function say(m) { console.log(m); log.push(m); }
function step(status, title, detail) {
  say('  [' + status + '] ' + title + (detail ? '  ' + detail : ''));
  out.steps.push({ status, title, detail: detail || '' });
}

// ---------------------------------------------------------------- HTTP
async function req(client, path, method, body) {
  return client.request(path, method, undefined, body);
}
async function statusOf(client, path, method, body) {
  method = method || 'GET';
  const res = await req(client, path, method, body);
  return { status: res.status, res };
}
async function getJSON(res) {
  try { return await res.json(); } catch (_) { return null; }
}

// Path-shaped ids must keep their slashes, so only encode each segment.
function encodePath(id) {
  return String(id).split('/').map(x => encodeURIComponent(x)).join('/');
}

// Read offset..offset+length as base64 (Logger domain), decode to Buffer.
async function readChunk(client, id, offset, length) {
  const path = '/api/logs/' + encodePath(id) + '/read?offset=' + offset + '&length=' + length;
  const { status, res } = await statusOf(client, path, 'GET');
  if (status !== 200) return { status, buf: null, length: null };
  const j = await getJSON(res);
  const b64 = j && j.data && j.data.data;
  if (b64 === undefined || b64 === null) return { status: 200, buf: null, length: null };
  return { status: 200, buf: Buffer.from(String(b64), 'base64'), length: j.data.length };
}

async function readWhole(client, id, size, chunk) {
  const parts = [];
  let off = 0;
  while (off < size) {
    const r = await readChunk(client, id, off, Math.min(chunk, size - off));
    if (r.status !== 200 || !r.buf) return { ok: false, why: 'HTTP ' + r.status + ' a l offset ' + off };
    parts.push(r.buf);
    off += r.buf.length;
    if (r.buf.length === 0) break;
  }
  return { ok: true, buf: Buffer.concat(parts) };
}

// ---------------------------------------------------------------- main
async function run() {
  const API = require('./api.js');
  console.log('='.repeat(64));
  console.log("  Scheduler4VP320 - Sonde Logger (REST): lire/ecrire des fichiers ?");
  console.log('='.repeat(64));
  console.log('  cible ' + BASE + ' (compte ' + USER + ')');
  console.log('  ATTENTION: aucun fichier du player n est modifie, sauf ' + PROBE_ID);
  console.log('');

  const client = API.createClient({ base: BASE, username: USER, password: PASS });

  // ---- [1] list
  let list = null;
  try {
    const { status, res } = await statusOf(client, '/api/logs');
    const j = await getJSON(res);
    list = (j && j.data) || null;
    step(status === 200 ? 'PASS' : 'FAIL', 'GET /api/logs (liste des fichiers)',
         status === 200 ? 'HTTP ' + status + ' ; ' + (Array.isArray(list) ? list.length : '?') +
           ' identifiant(s): ' + (Array.isArray(list) ? String(list.map(x => x)).slice(0, 12) : String(list).slice(0, 80))
         : 'HTTP ' + status + ' -> domaine non implemente sur ce firmware');
  } catch (e) {
    step('FAIL', 'GET /api/logs', e.message);
  }
  out.logsList = list;

  // ---- [2..3] binary round trip through POST append + base64 read
  const bytes = [];
  for (let i = 0; i < 256; i++) bytes.push(i);            // 0x00..0xFF, doubled below
  for (let i = 0; i < 256; i++) bytes.push(i);
  const expected = Buffer.from(bytes);

  let roundTrip = null;
  const writeBody = () => JSON.stringify({ data: String.fromCharCode.apply(String, expected) });

  try {
    // create / reset the probe file by deleting then appending
    await statusOf(client, '/api/logs/' + encodePath(PROBE_ID), 'DELETE');
    let { status } = await statusOf(client, '/api/logs/' + encodePath(PROBE_ID), 'POST', writeBody());
    if (status !== 200) {
      // some firmwares may refuse \u0000 in the JSON string: retry without NULs
      const noNul = expected.filter(b => b !== 0);
      step('NOTE', "POST /api/logs/" + PROBE_ID + ' (octets bruts)', 'HTTP ' + status + ' -> nouvelle tentative sans octet 0x00');
      ({ status } = await statusOf(client, '/api/logs/' + encodePath(PROBE_ID), 'POST',
        JSON.stringify({ data: String.fromCharCode.apply(String, noNul) })));
    }
    step(status === 200 ? 'PASS' : 'FAIL', 'POST /api/logs/' + PROBE_ID + " (ecriture {\"data\":\"...\"})",
         'HTTP ' + status);
    out.postStatus = status;

    const st = await readChunk(client, PROBE_ID, 0, 512);
    if (st.status !== 200 || !st.buf) {
      step('FAIL', 'GET /api/logs/:id/read (relecture base64)', 'HTTP ' + st.status + ' ; lecture impossible');
    } else {
      const got = st.buf;
      const same = got.equals(expected);
      let detail;
      if (same) detail = "les 512 octets sont identiques -> lecture/ECRITURE REST binaires OK";
      else {
        // is it the UTF-8 encoding of each byte (= chars >= 0x80 became 2 bytes)?
        let utf8 = true;
        const u = Buffer.from(expected.toString('latin1'), 'utf8');
        if (got.length !== u.length) utf8 = false;
        else { for (let i = 0; i < u.length; i++) { if (u[i] !== got[i]) { utf8 = false; break; } } }
        if (utf8) {
          detail = 'corruption UTF-8 (les octets >= 0x80 sont doubles) -> texte seul passable';
        } else {
          let diff = -1;
          for (let i = 0; i < Math.min(got.length, expected.length) && diff === -1; i++) {
            if (got[i] !== expected[i]) diff = i;
          }
          detail = diff === -1
            ? 'longueur ' + got.length + ' au lieu de ' + expected.length
            : 'premier ecart au rang ' + diff + ' : lu ' + got[diff] + ' au lieu de ' + expected[diff] +
              ' ; octets lus ' + Array.from(got.slice(0, 16)).join(',');
        }
      }
      roundTrip = same ? 'binary-ok' : 'not-binary';
      out.roundTrip = roundTrip;
      out.roundTripDetail = detail;
      step(same ? 'PASS' : 'NOTE', 'Aller-retour binaire (POST puis /read base64)', detail);
    }
  } catch (e) {
    step('FAIL', 'Aller-retour binaire', e.message);
  }

  // ---- [4] append semantics
  try {
    await statusOf(client, '/api/logs/' + encodePath(PROBE_ID), 'DELETE');
    await statusOf(client, '/api/logs/' + encodePath(PROBE_ID), 'POST', JSON.stringify({ data: 'AB' }));
    await statusOf(client, '/api/logs/' + encodePath(PROBE_ID), 'POST', JSON.stringify({ data: 'CD' }));
    const r = await readChunk(client, PROBE_ID, 0, 64);
    const txt = r.buf ? r.buf.toString('latin1') : '';
    const appendOk = r.buf && r.buf.toString('latin1').indexOf('ABCD') !== -1;
    step(appendOk ? 'PASS' : 'NOTE', 'POST append (2 ecritures successives)',
         'relus: ' + JSON.stringify(txt.slice(0, 8)) + ' -> ' +
         (appendOk ? 'append confirme (AB puis CD)' : 'ecrasement ou autre semantique'));
    out.appendOk = !!appendOk;
  } catch (e) {
    step('FAIL', 'POST append', e.message);
  }

  // ---- [5] can the Logger see the scheduler file?
  const sizeProbe = arg('expect-size', '82000');
  const candidates = [
    'scheduler.tm2',
    'SYSTEM/scheduler.tm2',
    'SYSTEM/scheduler.tm2.backup',
    'Internal shared storage/SYSTEM/scheduler.tm2',
    'www/scheduler.tm2',
    '../SYSTEM/scheduler.tm2',
    '../../Internal shared storage/SYSTEM/scheduler.tm2'
  ].concat(Array.isArray(list) ? list.map(x => x) : []);
  const seen = new Set();
  let schedulerHit = null;
  for (const id of candidates) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    try {
      const { status, res } = await statusOf(client, '/api/logs/' + encodePath(id) + '/stat');
      if (status !== 200) { step('INFO', 'stat ' + id, 'HTTP ' + status); continue; }
      const j = await getJSON(res);
      const size = j && j.data && j.data.size;
      const sizeN = Number(size);
      const plausible = sizeN >= 10000 && sizeN <= 200000;
      step('PASS', 'stat ' + id, 'existe, ' + sizeN + ' octets' + (sizeN > 70000 ? ' << TAILLE D UN PLANNING' : ''));
      out.statHits = out.statHits || {};
      out.statHits[id] = sizeN;
      if (id.indexOf('scheduler.tm2') !== -1 && !schedulerHit) schedulerHit = id;
      if (sizeN === Number(sizeProbe)) out.exactSize = id;
    } catch (e) {
      step('FAIL', 'stat ' + id, e.message);
    }
  }
  out.schedulerViaLogger = schedulerHit;

  if (schedulerHit) {
    try {
      const { status, res } = await statusOf(client, '/api/logs/' + encodePath(schedulerHit) + '/stat');
      const j = await getJSON(res);
      const size = Number(j && j.data && j.data.size || 0);
      const r = await readWhole(client, schedulerHit, size, 16384);
      if (!r.ok) {
        step('FAIL', 'lecture entiere de ' + schedulerHit, r.why);
      } else {
        let verdict = r.buf.length + ' octets lus';
        try {
          const m = TM2.parse(r.buf);
          verdict += ' ; TM2 VALIDE: ' + m.days.length + ' jour(s) type, ' +
            Object.keys(m.dates).length + ' date(s), device="' + String(m.hdr.device || '').slice(0, 30) + '"';
          step('PASS', 'lecture + parse de ' + schedulerHit, verdict);
          out.schedulerParseOk = true;
          out.schedulerSize = size;
        } catch (e) {
          verdict += ' ; TM2 INVALIDE: ' + e.message;
          step('NOTE', 'lecture de ' + schedulerHit, verdict +
               " ; l identifiant existe mais ne pointe pas vers /SYSTEM/scheduler.tm2");
          out.schedulerParseOk = false;
        }
      }
    } catch (e) {
      step('FAIL', 'lecture de ' + schedulerHit, e.message);
    }
  }

  // ---- [6] plain HTTP over /SYSTEM (fallback: import without Digest)
  for (const p of ['/SYSTEM/scheduler.tm2', '/www/SYSTEM/scheduler.tm2', '/www/scheduler.tm2']) {
    try {
      const r = await fetch(BASE + encodeURI(p));
      const detail = 'HTTP ' + r.status + (r.headers.get('content-type') ? ' ; ' + r.headers.get('content-type') : '');
      if (r.status === 200) {
        const ab = await r.arrayBuffer();
        const buf = Buffer.from(ab);
        let ok = '';
        try { const m = TM2.parse(buf); ok = ' ; TM2 VALIDE (' + m.days.length + ' jour(s))'; } catch (_) { ok = ' ; mais TM2 invalide'; }
        step('PASS', 'HTTP statique ' + p, 'HTTP 200 (' + buf.length + ' octets)' + ok);
        out.httpStatic = out.httpStatic || {};
        out.httpStatic[p] = buf.length;
      } else {
        step('INFO', 'HTTP statique ' + p, detail);
        out.httpStatic = out.httpStatic || {};
        out.httpStatic[p] = r.status;
      }
    } catch (e) {
      step('FAIL', 'HTTP statique ' + p, e.message);
    }
  }

  // ---- [7] cleanup
  if (!NO_CLEANUP && (out.postStatus === 200 || out.appendOk)) {
    try {
      const r = await statusOf(client, '/api/logs/' + encodePath(PROBE_ID), 'DELETE');
      const j = await getJSON(r.res);
      const okDel = j && j.data && j.data.status === true;
      step(okDel ? 'PASS' : 'NOTE', 'DELETE /api/logs/' + PROBE_ID, JSON.stringify(j && j.data));
    } catch (e) {
      step('FAIL', 'DELETE /api/logs/' + PROBE_ID, e.message);
    }
  }

  console.log('');
  console.log('Resume :');
  console.log('  - POST append binaire : ' + (out.roundTrip === 'binary-ok' ? 'OK (octets intacts)' : 'probleme: ' + (out.roundTripDetail || 'non teste')));
  console.log('  - append successifs   : ' + (out.appendOk ? 'confirme' : 'non'));
  console.log('  - scheduler via Logger: ' + (schedulerHit ? 'oui (' + schedulerHit + ')' : 'non'));
  if (schedulerHit) console.log('  - parse du fichier lu : ' + (out.schedulerParseOk ? 'VALIDE' : 'invalide (pas le real scheduler.tm2)'));
  console.log('');
  console.log('Envoye: logger-test.json (detail des reponses HTTP).');

  fs.writeFileSync('logger-test.json', JSON.stringify(out, null, 2));
  process.exit(0);
}

setTimeout(() => { console.error('Garde-temps global (120 s)'); process.exit(1); }, 120000);
run().catch(e => { console.error('Erreur fatale: ' + e.message); process.exit(1); });
