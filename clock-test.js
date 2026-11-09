/*
 * clock-test.js - Prove that the player firmware really applies scheduler.tm2.
 *
 * Everything else is already validated (format, REST/Digest, FTP deploy). This
 * script answers the last question: "does the firmware execute the events?"
 *
 * It reads the player's own clock, builds a tiny schedule for TODAY with two
 * observable events (STOP, then PLAY FOLDER 000) a few minutes ahead, uploads
 * it to /SYSTEM/scheduler.tm2 (with a backup of the existing file) and then
 * polls GET /api/system/state/playbackengine to watch the transitions.
 *
 * Usage:
 *   node clock-test.js --host=192.168.8.20 --user=admin --pass=password \
 *                      --ftp-user=idalftp --ftp-pass=0000 --upload
 *
 * Options:
 *   --host=IP            player address (default 192.168.1.100)
 *   --http-port=80       REST port
 *   --user/--pass        REST (Digest) credentials
 *   --ftp-user/--ftp-pass  FTP credentials (default: same as REST)
 *   --ftp-port=21        FTP port
 *   --dir=/SYSTEM        remote directory (auto-resolved on VP320)
 *   --in=3               minutes between now and the first event
 *   --file=NAME          local file generated (default scheduler-clocktest.tm2)
 *   --upload             deploy the generated file (otherwise just build it)
 *   --watch=N            seconds of observation after upload
 *                        (default (--in + 2) minutes + 30 s, 0 = no watch)
 *   --no-backup          do not save the previous /SYSTEM/scheduler.tm2
 *
 * Exit code: 0 = firmware applied the events, 1 = not observed / error.
 */

'use strict';

const fs = require('fs');

const TM2 = require('./tm2.js');
const API = require('./api.js');
const FTP = require('./ftp.js');

// ------------------------------------------------------------------- args
function arg(key, def) {
  const p = '--' + key + '=';
  const a = process.argv.find(s => s.startsWith(p));
  return a ? a.slice(p.length) : def;
}
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
const REMOTE_DIR = arg('dir', '/SYSTEM');
const FILE = arg('file', 'scheduler-clocktest.tm2');
const LEAD = Math.max(2, Number(arg('in', 3)));
const DO_UPLOAD = flag('upload');
const DO_BACKUP = !flag('no-backup');
const WATCH = Number(arg('watch', DO_UPLOAD ? (LEAD + 2) * 60 + 30 : 0));
const BASE = 'http://' + HOST + (HTTP_PORT === 80 ? '' : ':' + HTTP_PORT);
const TARGET = 'scheduler.tm2';

const log = [];
function say(msg) { console.log(msg); log.push(msg); }

// ---------------------------------------------------------------- helpers
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function withTimeout(promise, ms, what) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('Timeout (' + ms + 'ms) pendant ' + what)), ms);
    promise.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); });
  });
}

// "2026-11-09T11:30:45+01:00" or "2026-11-09 11:30:45" -> parts, no timezone math
function parsePlayerDate(s) {
  const m = /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(s || ''));
  if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +(m[6] || 0), raw: String(s) };
}

function addMinutes(p, add) {
  const t = new Date(Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) + add * 60000);
  return {
    y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(),
    h: t.getUTCHours(), mi: t.getUTCMinutes(), s: t.getUTCSeconds()
  };
}

function isoDate(p) {
  return p.y + '-' + String(p.mo).padStart(2, '0') + '-' + String(p.d).padStart(2, '0');
}

function hhmm(p) {
  return String(p.h).padStart(2, '0') + ':' + String(p.mi).padStart(2, '0');
}

function dateStamp(p) {
  return String(p.d).padStart(2, '0') + '/' + String(p.mo).padStart(2, '0') + '/' + p.y +
         '-' + hhmm(p) + ':' + String(p.s).padStart(2, '0');
}

function templateHeader(now) {
  const fallback = {
    ver: 'SCH21.01',
    device: 'eVP3x0--0100----My Video Player (VP320/VP330) / Event Video Player (EVP380)',
    name: 'Clock test',
    author: '',
    moddate: dateStamp(now),
    client: 'Scheduler4VP320',
    comments: 'Temporary clock test - firmware acceptance',
    softver: '1.01'
  };
  // Reuse the header of a reference file when available, so the player sees
  // the same device string as with the official Scheduler.
  for (const f of ['scheduler1.tm2', 'scheduler2.tm2']) {
    try {
      if (!fs.existsSync(f)) continue;
      const h = TM2.parse(fs.readFileSync(f)).hdr;
      return Object.assign({}, h, { name: 'Clock test', moddate: dateStamp(now) });
    } catch (_) { /* keep fallback */ }
  }
  return fallback;
}

// ---------------------------------------------------------------- REST
async function getJSON(client, path, timeoutMs) {
  const res = await withTimeout(client.request(path, 'GET'), timeoutMs, path);
  let body = null;
  try { body = await res.json(); } catch (_) {}
  return { status: res.status, data: (body && body.data) || body, body };
}

async function readPlayerNow(client, T) {
  const candidates = [
    ['/api/system/state/datetime', d => d && (d.now || d.datetime && d.datetime.now)],
    ['/api/system/state', d => d && d.datetime && d.datetime.now],
    ['/api/system/state', d => d && d.date]
  ];
  for (const [path, pick] of candidates) {
    try {
      const r = await getJSON(client, path, T);
      const value = pick(r.data);
      const parsed = parsePlayerDate(value);
      if (parsed) return parsed;
    } catch (_) { /* try next */ }
  }
  return null;
}

async function readPlayback(client, T) {
  const out = { state: '', folder: null, file: '', standby: null };
  try {
    const r = await getJSON(client, '/api/system/state/playbackengine', T);
    if (r.data) {
      out.state = String(r.data.state || '');
      if (r.data.folder && r.data.folder.index !== undefined) out.folder = Number(r.data.folder.index);
      if (r.data.file && r.data.file.name) out.file = String(r.data.file.name).slice(0, 40);
    }
  } catch (_) { /* older firmware: fall back to the full state */ }
  if (!out.state) {
    try {
      const r = await getJSON(client, '/api/system/state', T);
      const pe = r.data && r.data.playbackengine;
      if (pe) {
        out.state = String(pe.state || '');
        if (pe.folder && pe.folder.index !== undefined) out.folder = Number(pe.folder.index);
      }
      const pw = r.data && r.data.power;
      if (pw && pw.standby !== undefined) out.standby = !!pw.standby;
    } catch (_) { /* ignore */ }
  }
  return out;
}

// ---------------------------------------------------------------- main
async function run() {
  const T = 8000;
  console.log('='.repeat(60));
  console.log('  Scheduler4VP320 - Test d\'horloge (le firmware applique-t-il le planning ?)');
  console.log('='.repeat(60));

  const client = API.createClient({ base: BASE, username: USER, password: PASS });

  const now = await readPlayerNow(client, T);
  if (!now) {
    console.error('[ERREUR] horloge du player illisible (GET /api/system/state/datetime).');
    process.exit(1);
  }
  say('Horloge du player : ' + now.raw);

  // Firmware gate: below 1.13.1 the player ignores scheduler.tm2 entirely.
  let firmwareOk = null;
  try {
    const r = await getJSON(client, '/api/system/attributes', T);
    const d = (r.data && r.data.data) || r.data || {};
    const fw = (d.firmware && (d.firmware.version || d.firmware)) || d.firmwareversion || '';
    const model = d.model || '?';
    const serial = d.serialnumber || '?';
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(fw));
    firmwareOk = !!m && (Number(m[1]) > 1 ||
      (Number(m[1]) === 1 && (Number(m[2]) > 13 || (Number(m[2]) === 13 && Number(m[3]) >= 1))));
    say('Player : ' + model + ' / ' + serial + ' / firmware ' + (fw || '?') +
        (firmwareOk === false ? '  [ATTENTION] firmware < V1.13.1 : le planning est ignore' : ''));
  } catch (_) {
    say('Player : attributs illisibles (version firmware non verifiee)');
  }

  const tStop = addMinutes(now, LEAD);
  const tPlay = addMinutes(now, LEAD + 1);
  const tWake = LEAD > 2 ? addMinutes(now, LEAD - 1) : null;

  const events = [];
  if (tWake) events.push({ minute: tWake.h * 60 + tWake.mi, code: 0x02, value: 2 }); // WAKE UP
  events.push({ minute: tStop.h * 60 + tStop.mi, code: 0x01, value: 2 });            // STOP
  events.push({ minute: tPlay.h * 60 + tPlay.mi, code: 0x00, value: 0 });            // PLAY FOLDER 000

  const dates = {};
  dates[isoDate(tStop)] = 0;
  dates[isoDate(tPlay)] = 0;

  const model = {
    hdr: templateHeader(now),
    days: [{ name: 'Clock test', color: [0, 255, 0], events }],
    dates
  };

  const buf = TM2.encode(model);
  fs.writeFileSync(FILE, buf);

  say('');
  say('Planning generee : ' + FILE + ' (' + buf.length + ' octets)');
  say('  jour type \"Clock test\", date ' + isoDate(tStop) +
      (isoDate(tPlay) !== isoDate(tStop) ? ' + ' + isoDate(tPlay) : ''));
  if (tWake) say('  ' + hhmm(tWake) + '  WAKE UP');
  say('  ' + hhmm(tStop) + '  STOP          (la lecture doit s\'arreter)');
  say('  ' + hhmm(tPlay) + '  PLAY FOLDER 000 (la lecture doit repartir)');
  say('');
  say('Verification du fichier relu :');
  const check = TM2.parse(Buffer.from(buf));
  say('  ' + check.days.length + ' jour(s) type, ' + check.days[0].events.length +
      ' evenement(s), ' + Object.keys(check.dates).length + ' date(s)');
  if (check.days[0].events.length !== events.length) {
    console.error('[ERREUR] le fichier relu ne contient pas le bon nombre d\'evenements.');
    process.exit(1);
  }

  if (!DO_UPLOAD) {
    say('');
    say('Fichier pret. Pour le deployer puis observer :');
    say('  node clock-test.js --host=' + HOST + ' --user=' + USER + ' --pass=*** ' +
        '--ftp-user=' + FTP_USER + ' --ftp-pass=*** --upload');
    process.exit(0);
  }

  say('');
  say('Deploiement vers ' + REMOTE_DIR + '/' + TARGET + ' (compte FTP : ' + FTP_USER + ') ...');
  let info;
  try {
    info = await FTP.ftpPut(HOST, FTP_PORT, FTP_USER, FTP_PASS, REMOTE_DIR, TARGET, buf,
                            { backup: DO_BACKUP, mkdir: flag('mkdir'), dirHints: await storageNames(client, T) });
  } catch (e) {
    console.error('[ERREUR] upload FTP : ' + e.message);
    process.exit(1);
  }
  say('  envoye ' + buf.length + ' octets dans ' + info.dir + '/');
  if (info.backup) {
    const name = TARGET + '.backup';
    fs.writeFileSync(name, info.backup);
    say('  ancien fichier sauvegarde : ' + name + ' (' + info.backup.length + ' octets)');
  } else {
    say('  aucun ' + TARGET + ' existant a sauvegarder');
  }

  if (!WATCH) {
    say('');
    say('Pas d\'observation demandee (--watch=0).');
    process.exit(0);
  }

  say('');
  say('Observation pendant ' + WATCH + ' s (etat de lecture toutes les 2 s) ...');
  say('  T0 = ' + now.raw);
  const timeline = [];
  const started = Date.now();
  let prevKey = '';
  let before = null;
  const stopFrom = Date.now() + (LEAD * 60000) - 15000;
  const playFrom = Date.now() + ((LEAD + 1) * 60000) - 15000;

  let sawStop = false;
  let sawPlayFolder0 = false;

  while (Date.now() - started < WATCH * 1000) {
    const pb = await readPlayback(client, T);
    const key = pb.state + '|' + pb.folder;
    if (!before) before = pb;
    const changed = key !== prevKey;
    if (changed) {
      const at = new Date().toTimeString().slice(0, 8);
      timeline.push({ at, state: pb.state, folder: pb.folder, file: pb.file });
      say('  ' + at + '  state=' + (pb.state || '?') +
          (pb.folder !== null ? '  folder=' + pb.folder : '') +
          (pb.file ? '  file=' + pb.file : ''));
      prevKey = key;
    }
    const at = Date.now();
    if (changed && pb.state === 'stopped' && at >= stopFrom - 5000) sawStop = true;
    if (changed && pb.state === 'playing' && pb.folder === 0 && at >= playFrom - 5000) sawPlayFolder0 = true;
    await sleep(2000);
  }

  const wasPlayingFolder0 = !!(before && before.state === 'playing' && before.folder === 0);
  const pass = sawStop || sawPlayFolder0;

  say('');
  say('Etat initial : ' + (before ? before.state + (before.folder !== null ? ' folder=' + before.folder : '') : '?'));
  say('Arret observe (state=stopped)        : ' + (sawStop ? 'OUI' : 'non'));
  say('Lecture dossier 000 observee         : ' + (sawPlayFolder0 ? 'OUI' : 'non'));
  say('');
  if (sawStop && sawPlayFolder0) {
    say('RESULTAT : PASS - les deux evenements ont ete executes (STOP puis PLAY FOLDER 000).');
  } else if (sawStop) {
    say('RESULTAT : PASS - STOP execute (l\'arret a bien ete observe).');
    say('  La reprise PLAY FOLDER 000 n\'a pas ete vue dans la fenetre d\'observation');
    say('  (dossier 000 peut-etre vide ou deja en lecture).');
  } else if (sawPlayFolder0) {
    say('RESULTAT : PASS - PLAY FOLDER 000 execute (la lecture a repris).');
  } else {
    say('RESULTAT : FAIL - aucun evenement observe.');
    if (wasPlayingFolder0) {
      say('  La lecture n\'a pas ete stoppee a l\'heure prevue.');
    }
    say('  Verifier : /SYSTEM/scheduler.tm2 present, horloge du player, date du jour');
    say('  dans le calendrier, et firmware >= V1.13.1.');
    if (firmwareOk === false) say('  >> Le firmware lu est anterieur a V1.13.1 : c\'est la cause probable.');
    say('  Si l\'horloge du player est fausse, le planning ne se declenchera jamais.');
  }

  fs.writeFileSync('clock-test.json', JSON.stringify({
    host: HOST,
    playerNow: now.raw,
    firmwareOk: firmwareOk,
    file: FILE,
    events: events,
    dates: dates,
    uploadedTo: info.dir,
    backup: info.backup ? TARGET + '.backup' : null,
    timeline,
    initialState: before,
    sawStop,
    sawPlayFolder0,
    pass
  }, null, 2));

  process.exit(pass ? 0 : 1);
}

async function storageNames(client, T) {
  try {
    const r = await getJSON(client, '/api/storages', T);
    const list = (r.data && (Array.isArray(r.data) ? r.data : r.data.data)) || [];
    return Array.isArray(list) ? list.map(s => s && s.name).filter(Boolean) : [];
  } catch (_) {
    return [];
  }
}

setTimeout(() => {
  console.error('Garde-temps global (300s) - arret force');
  process.exit(1);
}, 300000);

run().catch(e => { console.error('Erreur fatale:', e.message); process.exit(1); });
