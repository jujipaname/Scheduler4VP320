/*
 * deploy-scheduler.js - put a scheduler.tm2 onto the player, nothing else.
 *
 * deploy.bat is the entry point; it forwards here with the arguments given on
 * its command line (the launcher only sets its folder and checks Node).
 *
 * Usage (run from the project folder):
 *   node deploy-scheduler.js -File planning.tm2 -Host 192.168.8.20 ^
 *        -User admin -Pass webpass -FtpUser idalftp -FtpPass ftppass
 *
 * Explicit enough for the workflow of the web editor:
 *   1. edit remote.html, download the .tm2 (button "Telecharger .tm2");
 *   2. deploy-scheduler.js writes it as /SYSTEM/scheduler.tm2 over FTP,
 *      keeping a backup of the previous file (scheduler.tm2.backup.*).
 *
 * Options:
 *   -File/--file=X       local .tm2 to deploy (default: scheduler.tm2)
 *   -Host/--host=IP     REST/FTP host
 *   -HttpPort          REST port (default 80)
 *   -FtpPort           FTP port  (default 21)
 *   -User/-Pass        REST (Digest) credentials
 *   -FtpUser/-FtpPass  FTP credentials (default: same as REST)
 *   -RemoteDir         remote directory (auto-resolved on VP320)
 *   -Mkdir             create the remote directory if missing
 *   -Name              remote file name (default scheduler.tm2 - do not change)
 *   -NoBackup          do not keep a backup of the existing remote file
 *   -Silent            no firmware check on the REST side (no HTTP before FTP)
 *
 * Exit code 0 = uploaded, 1 = refused.
 */

'use strict';

const fs = require('fs');
const API = require('./api.js');
const TM2 = require('./tm2.js');
const FTP = require('./ftp.js');

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

const FILE = arg('file', 'scheduler.tm2');
const HOST = arg('host', '192.168.1.100');
const HTTP_PORT = Number(arg('http-port', 80));
const FTP_PORT = Number(arg('ftp-port', 21));
const USER = arg('user', 'admin');
const PASS = arg('pass', '');
const FTP_USER = arg('ftp-user', '') || USER;
const FTP_PASS = arg('ftp-pass', '') || PASS;
const REMOTE_DIR = arg('dir', '/SYSTEM');
const REMOTE_NAME = arg('name', 'scheduler.tm2');
const DO_BACKUP = !flag('no-backup');
const DO_MKDIR = flag('mkdir');
const SILENT = flag('silent');
const BASE = 'http://' + HOST + (HTTP_PORT && HTTP_PORT !== 80 ? ':' + HTTP_PORT : '');

function fail(msg) { console.error('[ERREUR] ' + msg); process.exit(1); }

// ------------------------------------------------------------------ main
async function run() {
  console.log('='.repeat(60));
  console.log('  Scheduler4VP320 - Deploiement FTP de ' + FILE);
  console.log('='.repeat(60));

  if (!fs.existsSync(FILE)) fail("fichier local introuvable : '" + FILE + "'");
  const data = fs.readFileSync(FILE);
  // sanity: does it parse as a TM2? a mangled encoding would brick the player
  let parsed;
  try { parsed = TM2.parse(Buffer.from(data)); }
  catch (e) { fail("fichier invalide (pas un scheduler.tm2 valide) : " + e.message +
                   " ; reteleverse-le depuis l'editeur ou lance le kit."); }
  console.log('  fichier courant : ' + data.length + ' octets (' + FILE + ')');
  console.log('  contenu verifie : ' + parsed.days.length + ' jour(s) type, ' +
              Object.keys(parsed.dates).length + ' date(s).');
  if (!Object.keys(parsed.dates).length) {
    console.log('  [ATTENTION] calendrier vide - le player ne programmera rien.');
  }

  if (!SILENT) {
    try {
      const client = API.createClient({ base: BASE, username: USER, password: PASS });
      const res = await client.request('/api/system/attributes', 'GET');
      if (res.status !== 200) {
        console.log('  [NOTE] REST non joignable (HTTP ' + res.status + ') : on continue en FTP.');
      } else {
        const j = await res.json().catch(() => null);
        const d = (j && j.data) || {};
        const fw = d.firmware && d.firmware.version;
        if (fw) {
          const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(fw));
          const min = m && (Number(m[1]) > 1 ||
            (Number(m[1]) === 1 && (Number(m[2]) > 13 || (Number(m[2]) === 13 && Number(m[3]) >= 1))));
          console.log('  player : ' + (d.model || '?') + ' / ' + (d.serialnumber || '?') +
                      ' / firmware ' + fw + (min ? '' : '  [ATTENTION] < V1.13.1 : le fichier est ignore'));
        }
      }
    } catch (e) {
      console.log('  [NOTE] REST indisponible (' + e.message + ') : on continue en FTP.');
    }
  }

  // storage names to help locate <STORAGE>/SYSTEM (VP320 layout)
  let dirHints = [];
  if (!SILENT) {
    try {
      const client = API.createClient({ base: BASE, username: USER, password: PASS });
      const res = await client.request('/api/storages', 'GET');
      const j = await res.json().catch(() => null);
      const arr = (j && j.data) || [];
      dirHints = Array.isArray(arr) ? arr.map(s => s && s.name).filter(Boolean) : [];
    } catch (_) { /* informational only */ }
  }

  console.log('  envoi vers ' + (dirHints.length ? dirHints[0] + '/SYSTEM/' : REMOTE_DIR + '/') +
              REMOTE_NAME + ' (compte FTP ' + FTP_USER + (DO_BACKUP ? ', sauvegarde de l ancien' : ', sans sauvegarde') + ') ...');
  try {
    const info = await FTP.ftpPut(HOST, FTP_PORT, FTP_USER, FTP_PASS, REMOTE_DIR, REMOTE_NAME, data,
                                  { backup: DO_BACKUP, mkdir: DO_MKDIR, dirHints });
    console.log('  depose dans ' + (info.dir || REMOTE_DIR) + '/' + REMOTE_NAME);
    if (info.backup) console.log('  ancien fichier sauvegarde : ' + info.backup.length + ' octets.');
    console.log('');
    console.log('Le player relit le fichier a la minute suivante.');
    console.log('Pour en recreer un apres le test : clock-test.bat -Restore (cf. README).');
  } catch (e) {
    fail('upload FTP : ' + e.message);
  }
}

setTimeout(() => { console.error('Garde-temps global (60 s)'); process.exit(1); }, 60000);
run().catch(e => { console.error('Erreur fatale: ' + e.message); process.exit(1); });
