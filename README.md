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
| `ftp.js` | Client FTP minimal en Node pur (PASV, RETR/STOR/LIST, sauvegarde) ; résout le dossier distant (`/Internal shared storage/SYSTEM` sur VP320) |
| `test-runner.js` | Suite hors-ligne (roundtrip TM2, moteur, MD5/Digest) |
| `validate-player.js` | Validation **live** : auth Digest, **version firmware** (`/api/system/attributes`), stockages, upload FTP avec **sauvegarde de l'ancien fichier** **(requis : player joignable)** |
| `clock-test.bat` | Lanceur Windows du test d'horloge (se place dans le dossier du projet, `pause` à la fin) |
| `clock-test.js` | **Test d'horloge** : programme STOP puis `PLAY FOLDER 000` à +2/+3 min sur l'horloge **du player**, uploade et observe `/api/system/state/playbackengine` → prouve que le firmware exécute le planning |
| `run-tests.bat` / `run-tests.ps1` | Orchestrateur Windows — cf. `procedureTest.md`. Live : `run-tests.bat -Host <ip> -User admin -Pass <mdp> [-Upload -FtpUser <u> -FtpPass <p> -Tm2 fichier.tm2]` |

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

### Prouver que le firmware applique le planning (`clock-test.js`)

Le format, l'auth et l'upload étant validés, ce test répond à la dernière question :
**le firmware exécute-t-il vraiment `/SYSTEM/scheduler.tm2` ?**

Il lit l'horloge **du player**, génère un planning pour aujourd'hui avec deux événements
observables (`STOP` puis `PLAY FOLDER 000`) à `--in` et `--in+1` minutes, l'uploade
(sauvegarde de l'ancien fichier), puis interroge l'état de lecture toutes les 2 s.

Depuis le dossier du projet (le `.bat` s'y place tout seul, quel que soit le
répertoire courant) :

```bat
clock-test.bat -Host 192.168.8.20 -User admin -Pass <mdp> -FtpUser idalftp -FtpPass <mdp ftp> -In 2 -Upload
```

ou directement avec Node (les deux syntaxes sont acceptées, casse et tirets ignorés) :

```bat
node clock-test.js --host=192.168.8.20 --user=admin --pass=<mdp> --ftp-user=idalftp --ftp-pass=<mdp ftp> --in=2 --upload
```

Sortie attendue (chronologie en **heure du player**, `--watch` par défaut ≈ `in+2` min) :

```
Horloge du player : 2026-11-09T14:16:43.904+01:00
Heure du PC       : 14:05:48  (decalage PC/player : +660 s)
  14:19:05  state=stopped
  14:20:04  state=playing  folder=0
Arret observe (state=stopped)        : OUI a 14:19:05 (prevu a la minute 14:19:00)
RESULTAT : PASS - les deux evenements ont ete executes (STOP puis PLAY FOLDER 000).
```

Le firmware déclenche **à la première seconde de la minute** : un événement « 14:19 »
s'exécute à 14:19:00. C'est cette heure-là qui est surveillée, sur l'horloge du player
(le décalage avec le PC est affiché, il n'a aucune influence sur le test).

Ajoute `--restore` (ou `-Restore`) pour que le script remette automatiquement l'ancien
planning du player à la fin.

`PASS` prouve que le firmware interprète le fichier. `FAIL` oriente vers : fichier absent
ou mal placé, horloge du player fausse, date du jour hors calendrier, firmware < V1.13.1.

⚠️ Le test **remplace** le planning en place : `scheduler.tm2.backup` est écrit dans le
dossier courant. Si un backup **différent** existe déjà, le nouveau est horodaté
(`scheduler.tm2.backup.20261109-121928`) pour ne jamais écraser une sauvegarde
précédente. Pour remettre le planning réel : renvoyer le bon `.backup` par FTP sous le
nom `scheduler.tm2`.

## Statut

Roadmap et état détaillés dans **AGENTS.md**. Restant : validation sur matériel réel
(live REST Digest, FTP, déclenchement à la minute), conformité firmware/NTP.
