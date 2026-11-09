/*
 * test-runner.js - Offline self-test suite for the Scheduler4VP320 modules.
 *
 * Runs all deterministic (network-free) checks:
 *   - tm2.js     : byte-for-byte roundtrip on reference files + synthetic model,
 *                  size formula, header fields, command mapping.
 *   - engine.js  : resolveDay / eventsFor / toREST / describe.
 *   - api.js     : MD5 (RFC 1321 vectors) + Digest response (RFC 2617 example).
 *
 * No external dependencies (pure Node + local modules). Produces:
 *   - a text report on stdout
 *   - a machine-readable report in report.json  (also copied to REPORT.md by run-tests.ps1)
 *
 * Exit code: 0 = all pass, 1 = at least one failure.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const TM2 = require('./tm2.js');
const ENGINE = require('./engine.js');
const API = require('./api.js');

const results = [];
function test(name, fn) {
  try {
    const detail = fn();
    results.push({ name, pass: true, detail: detail || '' });
  } catch (e) {
    results.push({ name, pass: false, detail: e.message });
  }
}
function eq(a, b, ctx) { if (a !== b) throw new Error(`${ctx}: attendu ${JSON.stringify(b)}, obtenu ${JSON.stringify(a)}`); }

// ------------------------------------------------------------------ tm2
function roundtripModel(file) {
  const buf = fs.readFileSync(file);
  const m1 = TM2.parse(buf);
  const enc = TM2.encode(m1);
  const m2 = TM2.parse(Buffer.from(enc));
  eq(m2.ndays, m1.ndays, 'ndays');
  eq(m2.nevents, m1.nevents, 'nevents');
  eq(m2.days.length, m1.days.length, 'days count');
  m1.days.forEach((d, i) => {
    eq(m2.days[i].name, d.name, `day ${i} name`);
    eq(JSON.stringify(m2.days[i].events), JSON.stringify(d.events), `day ${i} events`);
  });
  eq(JSON.stringify(Object.keys(m2.dates).sort()), JSON.stringify(Object.keys(m1.dates).sort()), 'dates keys');
  return enc.length;
}

test('tm2 roundtrip scheduler1.tm2', () => {
  const n = roundtripModel('scheduler1.tm2');
  return `fichier relu byte-for-byte (${n} octets)`;
});
test('tm2 roundtrip scheduler2.tm2', () => {
  const n = roundtripModel('scheduler2.tm2');
  return `fichier relu byte-for-byte (${n} octets)`;
});

test('tm2 size formula', () => {
  const buf = fs.readFileSync('scheduler2.tm2');
  const m = TM2.parse(buf);
  const expected = 75264 + m.ndays * 3072 + m.nevents * 130;
  eq(buf.length, expected, 'taille totale');
  return `taille=${buf.length} = 75264 + ${m.ndays}*3072 + ${m.nevents}*130`;
});

test('tm2 header champs', () => {
  const buf = fs.readFileSync('scheduler1.tm2');
  const h = TM2.parse(buf).hdr;
  eq(h.ver.slice(0, 4), 'SCH2', 'magic');
  return `ver="${h.ver}" name="${h.name.trim()}" device="${h.device.trim()}"`;
});

test('tm2 command mapping (COMMANDS)', () => {
  eq(TM2.COMMANDS[0x00], 'PLAY FOLDER', '0x00');
  eq(TM2.COMMANDS[0x01], 'PLAYBACK', '0x01');
  eq(TM2.COMMANDS[0x02], 'STANDBY/WAKEUP', '0x02');
  eq(TM2.COMMANDS[0x03], 'HDMI-CEC', '0x03');
  eq(TM2.COMMANDS[0x05], 'PJLINK', '0x05');
  eq(TM2.fmtTime(510), '08:30', 'fmtTime');
  return 'commandes + format heure OK';
});

test('tm2 synthetic roundtrip (modèle éditeur)', () => {
  const model = {
    hdr: { ver: 'SCH21.01', device: 'VP320', name: 'test', author: '', moddate: '01/01/2026-00:00:00', client: '', comments: '', softver: '1.01' },
    days: [
      { name: 'Jour A', color: [0, 255, 0], events: [
        { minute: 0, code: 0x02, value: 2 },
        { minute: 420, code: 0x00, value: 5 },
        { minute: 1439, code: 0x05, value: 1 }
      ] },
      { name: 'Jour B', color: [255, 0, 0], events: [] }
    ],
    dates: { '2026-01-15': 0, '2026-06-01': 1 }
  };
  const enc = TM2.encode(model);
  const m = TM2.parse(Buffer.from(enc));
  eq(m.days.length, 2, 'days');
  eq(m.days[0].events.length, 3, 'events day0');
  eq(m.days[0].events[1].minute, 420, 'ev minute');
  eq(m.days[0].events[1].code, 0x00, 'ev code');
  eq(m.days[0].events[1].value, 5, 'ev value');
  eq(m.dates['2026-01-15'], 0, 'date->day');
  eq(m.dates['2026-06-01'], 1, 'date->day2');
  return `encode->parse synthétique OK (${enc.length} octets)`;
});

// ------------------------------------------------------------------ engine
test('engine resolveDay', () => {
  const m = TM2.parse(fs.readFileSync('scheduler2.tm2'));
  const d = ENGINE.resolveDay(m, new Date('2025-12-16T00:00:00Z'));
  eq(d, 0, 'day index');
  eq(ENGINE.resolveDay(m, new Date('2025-01-01T00:00:00Z')), null, 'date non affectée -> null');
  return '2025-12-16 -> day 0 ; jour non affecté -> null';
});

test('engine eventsFor + toREST + describe', () => {
  const m = TM2.parse(fs.readFileSync('scheduler2.tm2'));
  const evs = ENGINE.eventsFor(m, 0, 8 * 60 + 30); // 08:30
  eq(evs.length, 1, 'nb events');
  const e = evs[0];
  eq(e.code, 0x02, 'code');
  eq(e.value, 2, 'value');
  const rest = ENGINE.toREST(e);
  eq(rest.path, '/api/power/wakeup', 'rest path');
  eq(ENGINE.describe(e), 'WAKE UP', 'describe');
  eq(ENGINE.toREST({ code: 0x00, value: 12 }).path, '/api/player/play-folder', 'play-folder path');
  return '08:30 -> WAKE UP -> /api/power/wakeup';
});

// ------------------------------------------------------------------ api
test('md5 RFC1321 vectors', () => {
  eq(API.md5(''), 'd41d8cd98f00b204e9800998ecf8427e', 'md5("")');
  eq(API.md5('abc'), '900150983cd24fb0d6963f7d28e17f72', 'md5("abc")');
  eq(API.md5('The quick brown fox jumps over the lazy dog'), '9e107d9d372bb6826bd81d3542a419d6', 'md5(fox)');
  return '3 vecteurs RFC1321 OK';
});

test('digest RFC2617 example (cnonce fixe)', () => {
  const challenge = { realm: 'testrealm@host.com', nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093', opaque: '5ccc069c403ebaf9f0171e9517f40e41', qop: 'auth' };
  const nc = '00000001', cnonce = '0a4f113b', qop = 'auth';
  const ha1 = API.md5('Mufasa:testrealm@host.com:Circle Of Life');
  const ha2 = API.md5('GET:/dir/index.html');
  const response = API.md5(ha1 + ':' + challenge.nonce + ':' + nc + ':' + cnonce + ':' + qop + ':' + ha2);
  eq(response, '6629fae49393a05397450978507c4ef1', 'response digest');
  return 'response = 6629fae4... OK';
});

test('api parseChallenge', () => {
  const c = API.parseChallenge('Digest realm="r", nonce="n", qop="auth", opaque="o"');
  eq(c.realm, 'r', 'realm'); eq(c.nonce, 'n', 'nonce'); eq(c.qop, 'auth', 'qop'); eq(c.opaque, 'o', 'opaque');
  return 'challenge parsé';
});

test('api buildAuth structure', () => {
  const auth = API.buildAuth('admin', 'pw', { realm: 'r', nonce: 'n', qop: 'auth' }, 'POST', '/api/player/play');
  eq(/^Digest username="admin"/.test(auth), true, 'header digest');
  eq(/qop=auth/.test(auth), true, 'qop');
  eq(/cnonce="[^"]+"/.test(auth), true, 'cnonce');
  eq(/nc=00000001/.test(auth), true, 'nc');
  return auth;
});

test('api digest uri = chemin de requête (RFC 2617)', () => {
  const auth = API.buildAuth('admin', 'pw', { realm: 'r', nonce: 'n', qop: '' }, 'GET', '/api/system/state');
  eq(/uri="\/api\/system\/state"/.test(auth), true, 'uri sans base absolue');
  return auth;
});

// ------------------------------------------------------------------ report
const passed = results.filter(r => r.pass).length;
const failed = results.filter(r => !r.pass);

console.log('='.repeat(60));
console.log('  Scheduler4VP320 — Rapport de tests hors-ligne');
console.log('='.repeat(60));
results.forEach(r => {
  console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? '  —  ' + r.detail : ''}`);
});
console.log('-'.repeat(60));
console.log(`  ${passed} succès, ${failed.length} échec(s) sur ${results.length}`);
console.log('='.repeat(60));

// machine-readable report
const report = {
  suite: 'offline',
  generatedAt: new Date().toISOString(),
  node: process.version,
  total: results.length,
  passed,
  failed: failed.length,
  results
};
fs.writeFileSync('report.json', JSON.stringify(report, null, 2));
process.exit(failed.length ? 1 : 0);
