/*
 * deploy.js - Upload scheduler.tm2 to a VP320/VP330 player over FTP.
 *
 * The player's embedded web server has no REST endpoint to write arbitrary
 * files (official API only reads storages). Deployment therefore uses the
 * player's FTP server, dropping the generated file into /SYSTEM/ where the
 * firmware (>= V1.13.1) expects scheduler.tm2.
 *
 * Usage:
 *   node deploy.js <model.json> [host] [user] [pass] [path] [port]
 *     - model.json  : a model produced by TM2.parse (import from remote.html)
 *                     or generated via TM2.encode
 *     - host        : player IP (default 192.168.1.100)
 *     - user/pass   : FTP credentials (default admin/admin)
 *     - path        : remote dir (default /SYSTEM)
 *     - port        : FTP port (default 21)
 *
 * The output file is always named scheduler.tm2 and never renamed, as required.
 *
 * Requires: npm install basic-ftp
 */

'use strict';

const { Client } = require('basic-ftp');
const { encode } = require('./tm2.js');
const { readFileSync } = require('fs');
const { Readable } = require('stream');

async function main() {
  const [modelPath, host, user, pass, remoteDir, port] = process.argv.slice(2);
  if (!modelPath) {
    console.error('Usage: node deploy.js <model.json> [host] [user] [pass] [/SYSTEM] [port]');
    process.exit(1);
  }

  const model = JSON.parse(readFileSync(modelPath, 'utf8'));
  const buf = encode(model);
  const name = 'scheduler.tm2';
  console.log(`Encodé ${name} : ${buf.length} octets (${model.days.length} jours types, ` +
              `${Object.keys(model.dates).length} dates).`);

  const client = new Client();
  try {
    await client.access({ host: host || '192.168.1.100', port: port ? Number(port) : 21, user: user || 'admin', password: pass || 'admin', secure: false });
    await client.ensureDir(remoteDir || '/SYSTEM');
    await client.uploadFrom(Readable.from(Buffer.from(buf)), name);
    console.log(`✅ ${name} déposé dans ${remoteDir || '/SYSTEM'}/ sur ${host || '192.168.1.100'}.`);
    console.log('Le firmware interprétera ce fichier au prochain changement de minute.');
  } catch (err) {
    console.error('❌ Échec du déploiement :', err.message);
    process.exitCode = 1;
  } finally {
    client.close();
  }
}

main();
