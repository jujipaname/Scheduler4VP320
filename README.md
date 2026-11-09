# Scheduler4VP320

Planificateur **embarqué et web** pour les lecteurs média **Waves System VP320 / VP330** :
programmer la lecture automatique des contenus (dossiers `000`–`999`) selon la date et
l'heure, en générant le fichier officiel **`scheduler.tm2`** déposé dans `/SYSTEM/`.

Références officielles (Waves System) : voir **AGENTS.md** (rappels matériel, REST API,
format TM2, liens KB).

---

## Architecture

```
VP320 / VP330
├── Navigateur Chromium v92 (1920×1080) — page OSD servie par le player
│     └── index.html      : éditeur du planning piloté à la TÉLÉCOMMANDE IR
├── Web server embarqué — http://<ip>/www/
│     └── remote.html     : éditeur + télécommande + moteur, piloté depuis un navigateur
├── REST API officielle (Digest auth RFC 2617)  →  api.js
└── /SYSTEM/scheduler.tm2  →  interprété par le firmware (≥ V1.13.1)
                              (fallback réseau : engine.js)
```

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | **OSD embarqué** — éditeur « jours types » + « calendrier » navigable à la télécommande IR (flèches + OK, codes NEC), auto-fermeture 60 s, sauvegarde mémorisée puis rechargée à l'ouverture |
| `remote.html` | **Télécommande web** — 5 onglets : Jours types, Calendrier, Moteur, Télécommande (REST Digest), Fichier (génération/import/export du `.tm2`) |
| `tm2.js` | Parseur/encodeur du format binaire `scheduler.tm2` (reverse du logiciel Scheduler 2.3.3.0, validé octet par octet) |
| `engine.js` | Moteur de secours réseau : déclenchement à la minute des commandes via la REST API (`resolveDay`, `eventsFor`, `toREST`, `createDaemon`) |
| `api.js` | Client REST officiel avec **Digest auth** en JS pur (MD5 RFC 1321, RFC 2617) |
| `deploy.js` | Déploiement FTP du `scheduler.tm2` vers `/SYSTEM/` (`npm install` puis `node deploy.js <model.json> <ip> <user> <pass>`) |
| `test-runner.js` | Suite hors-ligne (roundtrip TM2, moteur, MD5/Digest) |
| `validate-player.js` | Validation **live** : auth Digest, **version firmware** (`/api/system/attributes`), stockages, upload FTP avec **sauvegarde de l'ancien fichier** **(requis : player joignable)** |
| `run-tests.bat` / `run-tests.ps1` | Orchestrateur Windows — cf. `procedureTest.md`. Live : `run-tests.bat -Host <ip> -User admin -Pass <mdp> [-Upload]` |

## Modèle de planning (format officiel)

- Fichier **`scheduler.tm2`** dans `/SYSTEM/` — **ne pas renommer**.
- **Jours types** (jusqu'à 255) : suite d'événements **minute par minute** (1 év./minute).
- **Calendrier** : affectation de chaque date à un jour type.
- Commandes : `PLAY FOLDER xxx` (0x00), `PLAYBACK PLAY/STOP` (0x01), `STANDBY/WAKEUP` (0x02),
  `HDMI-CEC` (0x03), `PJLINK POWER ON/OFF` (0x05).

## Persistance

L'API REST officielle ne permet pas l'écriture de fichiers arbitraires ; le déploiement
du `.tm2` se fait donc en **FTP** (`deploy.js` ou via le kit de test avec `-Upload`, qui sauvegarde d'abord
l'ancien fichier en `scheduler.tm2.backup`) :
1. Éditer le planning (OSD ou `remote.html`), « ⬇ Télécharger .tm2 ».
2. Copier le fichier en **`/SYSTEM/scheduler.tm2`** sur le player.
3. Le firmware (≥ **V1.13.1**) l'interprète à chaque changement de minute — horloge
   player synchronisée **NTP** vivement conseillée.

## Tests

```powershell
# Machine Windows 10 reliée au player (recommandé)
run-tests.bat -Host 192.168.1.100 -User admin -Pass <mdp> -Upload

# Hors-ligne uniquement
node test-runner.js
```

Détails et interprétation : **`procedureTest.md`**. Bilan hors-ligne attendu : 13/13 PASS.

## Statut

Roadmap et état détaillés dans **AGENTS.md**. Restant : validation sur matériel réel
(live REST Digest, FTP, déclenchement à la minute), conformité firmware/NTP.
