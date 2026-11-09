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
 * Usage (run it from the project folder, e.g. clock-test.bat):
 *   node clock-test.js --host=192.168.8.20 --user=admin --pass=password \
 *                      --ftp-user=idalftp --ftp-pass=0000 --upload
 *
 * Both syntaxes are accepted (case-insensitive), so a PowerShell habit works:
 *   node clock-test.js -Host 192.168.8.20 -User admin -Pass password -Upload
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
 *   --restore            re-upload the backup afterwards (undo the test)
 *   --restore=FILE       same, with an explicit local .tm2 to put back. Without
 *                        --upload this is a "restore only" run: no test, no wait
 *
 * Exit code: 0 = firmware applied the events, 1 = not observed / error.
 */

'use strict';

const fs = require('fs');

// The kit is copied as loose files onto a Windows box: a missing sibling module
// must produce an actionable message, not a Node stack trace.
function need(mod) {
  try {
    return require(mod);
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message).indexOf(mod) !== -1) {
      console.error('[ERREUR] il manque ' + mod.replace(/^\.\//, '') + ' dans ce dossier.');
      console.error('  clock-test.js a besoin de tm2.js, api.js et ftp.js, tous dans le MEME dossier.');
      console.error('  Recopie l integralite du kit (ou git pull) puis relance clock-test.bat.');
      process.exit(2);
    }
    throw e;
  }
}

const TM2 = need('./tm2.js');
const API = need('./api.js');
const FTP = need('./ftp.js');

// ------------------------------------------------------------------- args
// Accepts --key=value, --key value, -Key=value and -Key value (PowerShell
// habit), case-insensitively. A bare option (no value, or followed by another
// option) is a boolean flag.
const OPTIONS = {};
const SWITCHES = new Set();
(function parseArgs() {
  const av = process.argv.slice(2);
  // Keys are normalized: case, dashes and underscores are ignored, so
  // --http-port, -HttpPort and -httpport all mean the same option.
  const keyOf = s => s.replace(/^--?/, '').toLowerCase().replace(/[-_]/g, '');
  const isOption = s => /^--?[A-Za-z]/.test(s);
  for (let i = 0; i < av.length; i++) {
    const a = av[i];
    if (!isOption(a)) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) {
      OPTIONS[keyOf(a.slice(0, eq))] = a.slice(eq + 1);
      continue;
    }
    const k = keyOf(a);
    const next = av[i + 1];
    if (next !== undefined && !isOption(next)) { OPTIONS[k] = next; i++; }
    else SWITCHES.add(k);
  }
})();

function norm(key) { return String(key).toLowerCase().replace(/[-_]/g, ''); }

function arg(key, def) {
  const v = OPTIONS[norm(key)];
  return v === undefined ? def : v;
}
function flag(key) {
  const k = norm(key);
  if (SWITCHES.has(k)) return true;
  const v = OPTIONS[k];
  if (v === undefined) return false;
  return !/^(0|false|no)$/i.test(v);
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
// --restore : put the previous schedule back after the test (bare flag = the
// backup just taken; --restore=file to pick another one).
const RESTORE = SWITCHES.has('restore') ? true : (OPTIONS['restore'] || false);
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

// Wall-clock helpers. Everything the schedule and the verdict rely on is the
// PLAYER's wall clock: the PC may be several minutes off, and a naive
// Date.now() comparison then misses the events entirely.
function localWallMs() {
  const d = new Date();
  return d.getTime() - d.getTimezoneOffset() * 60000;
}

function wallMs(p) { return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s); }

function hhmmss(ms) {
  const d = new Date(ms);
  return String(d.getUTCHours()).padStart(2, '0') + ':' +
         String(d.getUTCMinutes()).padStart(2, '0') + ':' +
         String(d.getUTCSeconds()).padStart(2, '0');
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

  // "--restore=FILE --no-upload" (or --restore with --upload=0): put that file
  // back in /SYSTEM and stop. Undoing a test must not need another test.
  if (RESTORE && !DO_UPLOAD) {
    const src = RESTORE === true ? '' : RESTORE;
    if (!src) {
      console.error('[ERREUR] --restore sans --upload doit donner le fichier : --restore=scheduler.tm2.backup');
      process.exit(1);
    }
    let data;
    try { data = fs.readFileSync(src); }
    catch (e) { console.error('[ERREUR] impossible de lire ' + src + ' : ' + e.message); process.exit(1); }
    say('Restauration seule : ' + src + ' (' + data.length + ' octets) -> ' + REMOTE_DIR + '/' + TARGET);
    try {
      const info2 = await FTP.ftpPut(HOST, FTP_PORT, FTP_USER, FTP_PASS, REMOTE_DIR, TARGET, data,
                                     { backup: false, mkdir: flag('mkdir'), dirHints: await storageNames(client, T) });
      say('  depose dans ' + (info2.dir || REMOTE_DIR) + '/' + TARGET);
      try {
        const back = await getJSON(client, '/api/system/state/playbackengine', T);
        say('  etat du player : ' + JSON.stringify(back.data && back.data.state ? back.data.state : back.data));
      } catch (_) { /* not blocking */ }
      say('  le player rejoue selon ce planning.');
      process.exit(0);
    } catch (e) {
      console.error('[ERREUR] restauration : ' + e.message);
      process.exit(1);
    }
  }

  const now = await readPlayerNow(client, T);
  if (!now) {
    console.error('[ERREUR] horloge du player illisible (GET /api/system/state/datetime).');
    process.exit(1);
  }
  say('Horloge du player : ' + now.raw);

  // Constant offset: player wall clock minus PC wall clock.
  const OFFSET = wallMs(now) - localWallMs();
  const playerWall = () => localWallMs() + OFFSET;
  const drift = Math.round(OFFSET / 1000);
  say('Heure du PC       : ' + hhmmss(localWallMs()) + '  (decalage PC/player : ' +
      (drift >= 0 ? '+' : '') + drift + ' s)');
  if (Math.abs(drift) > 30) {
    say('  => le PC et le player ne sont pas a la meme heure. Les evenements sont');
    say('     programmes sur l\'horloge DU PLAYER ; la chronologie ci-dessous aussi.');
  }

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
    say('  node clock-test.js --host=' + HOST + ' --user=' + USER + ' --pass=' + PASS +
        ' --ftp-user=' + FTP_USER + ' --ftp-pass=' + FTP_PASS + ' --upload');
    process.exit(0);
  }

  say('');
  say('Deploiement vers ' + REMOTE_DIR + '/' + TARGET + ' (compte FTP : ' + FTP_USER + ') ...');
  let info;
  let backupName = null;
  try {
    info = await FTP.ftpPut(HOST, FTP_PORT, FTP_USER, FTP_PASS, REMOTE_DIR, TARGET, buf,
                            { backup: DO_BACKUP, mkdir: flag('mkdir'), dirHints: await storageNames(client, T) });
  } catch (e) {
    console.error('[ERREUR] upload FTP : ' + e.message);
    process.exit(1);
  }
  say('  envoye ' + buf.length + ' octets dans ' + info.dir + '/');
  if (info.backup) {
    // Never overwrite an earlier backup (it may hold the customer's real
    // schedule): keep a timestamped copy when the content differs.
    let name = TARGET + '.backup';
    if (fs.existsSync(name)) {
      const same = fs.readFileSync(name).equals(info.backup);
      if (!same) {
        const d = new Date();
        const stamp = d.getFullYear() +
          String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') +
          '-' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0') +
          String(d.getSeconds()).padStart(2, '0');
        name = TARGET + '.backup.' + stamp;
      }
    }
    fs.writeFileSync(name, info.backup);
    backupName = name;
    say('  ancien fichier sauvegarde : ' + name + ' (' + info.backup.length + ' octets)');
  } else if (!DO_BACKUP) {
    say('  sauvegarde desactivee (--no-backup)');
  } else {
    say('  aucun ' + TARGET + ' existant a sauvegarder');
  }

  // Put the player's own schedule back (bare --restore = the backup we just
  // took, --restore=FILE = a file we choose). Used both when the observation is
  // skipped and at the end of a full run.
  async function restoreStep() {
    if (!DO_BACKUP || !backupName) return;
    say('');
    if (!RESTORE) {
      say('Le planning du player a ete remplace par le test. Pour le remettre :');
      say('  node clock-test.js --host=' + HOST + ' --user=' + USER + ' --pass=' + PASS +
          ' --ftp-user=' + FTP_USER + ' --ftp-pass=' + FTP_PASS + ' --restore');
      say('  (ou copier ' + backupName + ' vers ' + (info.dir || REMOTE_DIR) + '/' + TARGET + ' par FTP)');
      return;
    }
    const src = RESTORE === true ? backupName : RESTORE;
    say('Restauration du planning depuis ' + src + ' ...');
    let data;
    try { data = fs.readFileSync(src); }
    catch (e) { say('[ERREUR] impossible de lire ' + src + ' : ' + e.message); return; }
    try {
      const back = await FTP.ftpPut(HOST, FTP_PORT, FTP_USER, FTP_PASS, info.dir, TARGET, data,
                                     { backup: false, mkdir: false, dirHints: await storageNames(client, T) });
      say('  ' + data.length + ' octets reinjectes dans ' + (back.dir || info.dir) + '/' + TARGET);
      say('  le player a retrouve ce planning.');
    } catch (e) {
      say('[ERREUR] restauration : ' + e.message);
    }
  }

  if (!WATCH) {
    say('');
    say('Pas d\'observation demandee (--watch=0).');
    await restoreStep();
    process.exit(0);
  }

  say('');
  say('Observation pendant ' + WATCH + ' s (etat de lecture toutes les 2 s) ...');
  say('  T0 (player) = ' + now.raw);
  const timeline = [];
  const started = Date.now();
  let prevKey = '';
  let before = null;
  // The firmware fires on the MINUTE CHANGE: an event "13:54" is executed at
  // 13:54:00, not at 13:54:47 (the seconds of T0 are irrelevant). Expect the
  // top of the minute, and accept up to 2 min late in case of a slow reload.
  const stopAt = Math.floor(wallMs(tStop) / 60000) * 60000;
  const playAt = Math.floor(wallMs(tPlay) / 60000) * 60000;
  const window = [stopAt - 25000, stopAt + 120000];
  const windowPlay = [playAt - 25000, playAt + 120000];

  while (Date.now() - started < WATCH * 1000) {
    const pb = await readPlayback(client, T);
    const key = pb.state + '|' + pb.folder;
    if (!before) before = pb;
    const changed = key !== prevKey;
    const wall = playerWall();
    if (changed) {
      const at = hhmmss(wall);
      timeline.push({ at, ms: wall, state: pb.state, folder: pb.folder, file: pb.file });
      say('  ' + at + '  state=' + (pb.state || '?') +
          (pb.folder !== null ? '  folder=' + pb.folder : '') +
          (pb.file ? '  file=' + pb.file : ''));
      prevKey = key;
    }
    await sleep(2000);
  }

  // Judge afterwards, from the recorded transitions: easier to read and to trust.
  const inWin = (t, w) => t.ms >= w[0] && t.ms <= w[1];
  const stopHit = timeline.filter(t => t.state === 'stopped' && inWin(t, window))[0];
  const playHit = timeline.filter(t => t.state === 'playing' && t.folder === 0 && inWin(t, windowPlay))[0];
  const sawStop = !!stopHit;
  const sawPlayFolder0 = !!playHit;

  const wasPlayingFolder0 = !!(before && before.state === 'playing' && before.folder === 0);
  const driftWasLarge = Math.abs(drift) > 30;
  const pass = sawStop || sawPlayFolder0;

  say('');
  say('Etat initial : ' + (before ? before.state + (before.folder !== null ? ' folder=' + before.folder : '') : '?'));
  say('Arret observe (state=stopped)        : ' +
      (sawStop ? 'OUI a ' + stopHit.at + ' (prevu a la minute ' + hhmmss(stopAt) + ')'
               : 'non (fenetre ' + hhmmss(window[0]) + ' - ' + hhmmss(window[1]) + ')'));
  say('Lecture dossier 000 observee         : ' +
      (sawPlayFolder0 ? 'OUI a ' + playHit.at + ' (prevu a la minute ' + hhmmss(playAt) + ')'
                      : 'non (fenetre ' + hhmmss(windowPlay[0]) + ' - ' + hhmmss(windowPlay[1]) + ')'));
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
    if (driftWasLarge) {
      say('  A note : le PC est decale de ' + drift + ' s par rapport au player.');
      say('  Les evenements se declenchent sur l\'heure DU player (voir T0 ci-dessus).');
    }
    say('  Un etat « maintenance » juste apres l\'upload est normal : le player relit son stockage.');
  }

  fs.writeFileSync('clock-test.json', JSON.stringify({
    host: HOST,
    playerNow: now.raw,
    pcNow: hhmmss(localWallMs()),
    driftSeconds: drift,
    firmwareOk: firmwareOk,
    file: FILE,
    events: events,
    dates: dates,
    uploadedTo: info.dir,
    backup: backupName,
    timeline,
    initialState: before,
    expected: { wake: tWake ? hhmmss(wallMs(tWake)) : null, stop: hhmmss(stopAt), play: hhmmss(playAt) },
    stopObserved: stopHit ? stopHit.at : null,
    playObserved: playHit ? playHit.at : null,
    sawStop,
    sawPlayFolder0,
    pass
  }, null, 2));

  await restoreStep();

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

// The observation window is LEAD minutes of waiting plus WATCH seconds: a fixed
// 300s watchdog used to kill a perfectly good run before its verdict.
const HARD_LIMIT_MS = (LEAD * 60000) + WATCH * 1000 + 120000;
setTimeout(() => {
  console.error('Garde-temps global (' + Math.round(HARD_LIMIT_MS / 1000) +
                's) - arret force');
  process.exit(1);
}, HARD_LIMIT_MS);

run().catch(e => { console.error('Erreur fatale:', e.message); process.exit(1); });
