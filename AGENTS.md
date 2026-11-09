# AGENTS.md — Scheduler4VP320

## Périmètre et mission

Réaliser un **planificateur (scheduler) embarqué et web** pour les lecteurs média
**Waves System de la série VP (VP320 / VP330)**, permettant de programmer la lecture
automatique de contenus selon la date et l'heure.

Le planificateur doit pouvoir être :

1. **Affiché et édité à la télécommande IR** du player (navigation spatiale, OK/flèches),
   en tant qu'OSD affiché sur l'écran relié au player.
2. **Édité à distance via le réseau**, en accédant au player par son **IP**
   (interface web embarquée servie par le web server du player).

## Rappels matériel cible (d'après doc Waves System)

- Lecteurs **VP320** et **VP330** : lecteurs vidéo 4K « My Video Player » (moteur de rendu
  web **Chromium v92**, page web en **1920×1080**, navigateur intégré).
- **Web server embarqué** qui sert des pages HTML5/JavaScript → point d'entrée de la
  partie web.
- **REST API** embarquée, authentification **Digest access auth (RFC 2617)**,
  permissions `admin` / `user`.
- **IR remote control** (protocole NEC) fourni avec chaque player → navigation OSD.
- **WebSocket** d'événements temps réel (JSON, filtres par type).
- Serveurs **FTP / TCP-IP / PJLink**, client **NTP**, service **mDNS (Zeroconf)**.
- Stockage sur **USB / microSD**, systèmes FAT32 / exFAT / NTFS / ext2-4.
- **Clavier / souris / écran multi-touch USB HID** supportés.
- VP320 : 1 entrée contact. VP330 : 1 + 8 entrées contact, 8 sorties, 1 RS-232.

### Fonctionnement de la lecture (règle des dossiers)

- La lecture se pilote par **dossiers numérotés sur 3 chiffres** (`000` … `999`).
- Dossier `000` : **auto-play au démarrage** (lecture aléatoire, `[LOOP]`, `[SEQ]`…).
- Entrées contact → déclenchent des dossiers (`001`…`255` selon code binaire sur VP330).
- Tags dans le nom de dossier : `[LOOP]`, `[SEQ]`, `[RND]`, `[Jxxx]`.

### Scheduler officiel (format de référence)

- Le format officiel d'un planning est le fichier **`scheduler.tm2`** (format « Scheduler V2 »),
  placé dans le dossier **`SYSTEM`** du stockage du player : **`/SYSTEM/scheduler.tm2`**.
- Le **nom du fichier ne doit pas être changé** (`scheduler.tm2`), sinon non reconnu.
- Le fichier décrit :
  - un **calendrier de dates** (VP320 : 2016→2037 ; Scheduler : 2000→2099),
  - associé à des **« typical days »** (jusqu'à 255 modèles),
  - chaque typical day est une suite d'**événements minute par minute** (00:00 → 23:59,
    jusqu'à 1440 événements / jour, **1 seul événement par minute**, déclenché au
    changement de minute).
- Compatible VP320/VP330 à partir du **firmware V1.13.1**.

### Commandes disponibles dans un événement (1 par événement)

| Commande | Effet |
|---|---|
| `PLAY FOLDER <xxx>` | lance le dossier 3 chiffres (`000`…`999`) |
| `PLAY` | relance la lecture du dossier courant (ignoré sinon) |
| `STOP` | arrête la lecture |
| `STANDBY` / `WAKE UP` | veille / réveil du player |
| `HDMI-CEC STANDBY` / `HDMI-CEC WAKE UP` | extinction / allumage écran via CEC |
| `VIDEO PROJECTOR (PJLINK) POWER ON/OFF` | allume / éteint un projecteur PJLink |

### REST API embarquée (domaines)

D'après la doc officielle « Controlling the VP320/VP330 using a REST API »
(https://download.waves-system.com/MANUAL/REST_API/rest-api-external-en/index.html),
l'API couvre : **Player**, **Events**, **Contact**, **Serial**, **Logger**, **System**,
**Storage**, **Power**, **Display**, **VideoProjector** (`/api/videoprojector/poweron|poweroff`),
**Printer**, **Console**. Le scheduler n'y figure pas en tant que domaine dédié : la
programmation passe par le fichier `scheduler.tm2`.

## Liens de référence (doc officielle Waves System)

- Produit VP320 : https://waves-system.com/en/produit/my-video-player-vp320/
- Produit VP330 : https://waves-system.com/en/produit/my-video-player-vp330/
- Page « Video players with programming » : https://waves-system.com/en/video-players-with-programming/
- Support KB VP320/VP330 : https://support.waves-system.com/en/support/solutions/203000065192
- **Programmation horodatée VP320/330** :
  https://support.waves-system.com/en/support/solutions/articles/203000068982
- **Contrôle par REST API** :
  https://support.waves-system.com/en/support/solutions/articles/203000069732
- **Logiciel Scheduler** (outil officiel, génère le `.tm2`) :
  https://waves-system.com/en/produit/scheduler/
- Intro au Scheduler : https://support.waves-system.com/en/support/solutions/articles/203000069236

## État actuel du dépôt (analyse)

Le repo contient **deux pages web statiques** + une config :

- **`index.html`** — OSD embarqué, éditeur du planning 7 jours piloté **télécommande**
  (navigation spatiale + OK, codes claviers 19/20/21/22/23/66). Auto-fermeture 60 s.
  Lecture/écriture via endpoints REST **`/api/storage/schedule.json`** (JSON).
- **`remote.html`** — télécommande web (2 onglets : commandes directes + éditeur planning)
  sur les mêmes endpoints REST.
- **`web-config.json`** — déclare l'URL `http://localhost/www/index.html`.

### Écarts / problèmes identifiés

- Le planning est stocké/écrit en **JSON** (`schedule.json`) via des endpoints REST
  (`/api/storage/…`, `/api/player/…`, `/api/system/cec/…`, `/api/pjlink/…`,
  `/api/web/stop`) **qui ne correspondent pas à la REST API officielle documentée**
  (Digest auth, domaines listés ci-dessus). → À valider sur matériel réel.
- Le format de persistance utilisé (`schedule.json`) **n'est pas le format officiel
  `scheduler.tm2`** attendu par le player dans `/SYSTEM/`. → À clarifier : soit l'OSD
  web génère un `scheduler.tm2` compatible, soit il exploite un mécanisme interne
  du player à confirmer.
- **Aucun moteur de scheduling** (aucun daemon/code qui applique le planning à l'heure).
  Le scheduler officiel est censé être interprété par le player lui-même (firmware).
- La sémantique « heure d'allumage/extinction » + « dossier » + « volume » actuelle est
  simplifiée par rapport aux commandes officielles (`PLAY FOLDER`, `STANDBY`, CEC, PJLINK…).

## Architecture cible

```
┌─────────────────────────────────────────────────────────────┐
│                         VP320 / VP330                       │
│  ┌─────────────────────┐     ┌───────────────────────────┐  │
│  │  Navigateur Chromium │     │   Web server embarqué     │  │
│  │   (1920×1080)        │     │   → sert index.html /     │  │
│  │   affiche l'OSD       │     │     remote.html           │  │
│  └──────────┬──────────┘     └─────────────┬─────────────┘  │
│  IR remote ─┘                              │                │
│     │                                      │ REST API      │
│     ▼                                      ▼                │
│  ┌──────────────────────────────────────────────────────┐   │
│  │   Éditeur de planning (HTML/JS)                      │   │
│  │   → typical days + calendrier                        │   │
│  └────────────────────────┬─────────────────────────────┘   │
│                           │                                │
│                           ▼                                │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Générateur scheduler.tm2                            │   │
│  │  écrit dans /SYSTEM/scheduler.tm2                    │   │
│  └──────────────────────────────────────────────────────┘   │
│                           │ firmware                        │
│                           ▼ interprète le planning           │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Moteur de lecture (dossiers 000-999) → PLAY/STOP    │   │
│  │  Power (veille), HDMI-CEC, PJLINK                    │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Principes d'implémentation

- **Cible d'affichage** : page web servie par le player, résolution **1920×1080**,
  navigateur Chromium **v92**. Pas de framework lourd : HTML/CSS/JS natif.
- **Télécommande** : navigation spatiale DOM (focus), interception des touches
  (flèches 37/38/39/40 + codes IR NEC 19/20/21/22/23/66), gardien de focus.
- **Réseau** : accès par l'IP du player (`http://<ip>/www/…`), REST API officielle avec
  **Digest auth**.
- **Persistance** : produire un fichier `scheduler.tm2` valide dans `/SYSTEM/`
  (format officiel). Valider le format binaire (reverse du logiciel Scheduler si besoin).

## Règles de travail

- Langue : **français** pour UI et documentation ; code, commentaires et variables
  sobrement en anglais.
- Ne pas déployer de fichier volumineux ; le player n'a que **4 GB** de stockage interne.
- Tester l'API sur matériel réel quand disponible (Digest auth, endpoints officiels).
- Ne pas renommer `scheduler.tm2`.
- Vérifier la compatibilité firmware (≥ V1.13.1 pour le scheduler).

## Liste des tâches (roadmap)

> Priorités : `P0` = bloquant / socle, `P1` = fonctionnalité majeure, `P2` = amélioration.
> Statuts : `⬜` à faire, `🔄` en cours, `✅` fait.

### Phase 0 — Socle & analyse (P0)

- [x] ✅ **Reverse-engineering du format `scheduler.tm2`** : analyse binaire des fichiers de
       référence + décompilation du logiciel Scheduler 2.3.3.0 (assembly .NET) → layout,
       calendrier, typical days, événements, commandes. Validé par round-trip octet-à-octet.
- [x] ✅ Valider sur matériel réel (VP320) les endpoints REST officiels et l'auth Digest.
       → **Validé (09/11/2026, VP320 192.168.8.20)** : `POST /api/auth/login` 200,
         `GET /api/system/state` 200, `GET /api/storages` 200, `GET /api/system/attributes`
         200 → **firmware v1.13.1 (2022-09-01)**, série `00014ea23eede685`.
         Upload FTP réel : 82708 octets déposés dans
         **`/Internal shared storage/SYSTEM/scheduler.tm2`** (compte `idalftp`), ancien
         fichier (83488 o) sauvegardé en `scheduler.tm2.backup`. **6/6 PASS** en live,
         13/13 en hors-ligne. La racine FTP **contient les stockages** (elle n'est pas la
         racine du stockage) : le kit résout désormais le chemin tout seul (`ftp.js`).
- [x] ✅ Clarifier le mécanisme d'écriture : l'OSD/remote génère `scheduler.tm2`
       (import/export + mémorisation locale), déploiement vers `/SYSTEM/` **via FTP**
       (l'API REST officielle n'écrit pas de fichiers arbitraires). Choix documenté dans
       `README.md` (« Persistance ») mis en œuvre par `deploy.js` et le kit de test (`-Upload`).

### Phase 1 — Génération du fichier `scheduler.tm2` (P0)

- [x] ✅ **Module `tm2.js`** : encodeur + parseur natif du format binaire `scheduler.tm2`
       (typical days + calendrier + événements + commandes). Round-trip validé sur fichiers réels.
- [x] ✅ Modéliser les **typical days** (jusqu'à 255) et les **événements** par minute (1440/jour).
- [x] ✅ Modéliser le **calendrier de dates** (2016→2037 VP / 2000→2099 Scheduler).
- [x] ✅ Définir la correspondance des **commandes** (`PLAY FOLDER`=0x00, `PLAYBACK`=0x01,
       `STANDBY/WAKEUP`=0x02, `HDMI-CEC`=0x03, `PJLINK`=0x05).

### Phase 2 — Modèle de planning et UI (P0)

- [x] ✅ Remplacer la sémantique simplifiée « on/off + volume + dossier » par un modèle
       basé sur les **événements officiels** (typical days + calendrier).
- [x] ✅ **`index.html` (OSD télécommande)** : éditer typical days + événements (heure,
       commande, valeur) et calendrier (affectation par dates) avec navigation spatiale
       (flèches/OK, codes IR NEC), gardien de focus, auto-fermeture.
- [x] ✅ **`remote.html` (web)** : mêmes capacités d'édition depuis le navigateur via l'IP
       (jours types + événements + calendrier + import/export `scheduler.tm2`).
- [ ] ⬜ Brancher le **chargement/sauvegarde** réel du `scheduler.tm2` sur le player
       (endpoint REST à identifier — Phase 3/4) ; persistance actuelle via import/export
       local + localStorage.

### Phase 3 — Accès réseau & REST (P1)

- [x] ✅ Remplacer les endpoints non officiels (`/api/storage/schedule.json`, etc.) par la
       **REST API officielle** avec **Digest auth** (login/mot de passe admin).
- [x] ✅ Gérer l'authentification (challenge nonce/cnonce, RFC 2617) côté page web
       (`api.js` : MD5 natif + client Digest auto-renvoyant la requête).
- [x] ✅ Brancher les **commandes directes** (play/pause/stop, volume, PJLINK, CEC, power,
       play-folder) sur les endpoints officiels documentés.
- [ ] ⬜ (Option) Utiliser le **WebSocket d'événements** pour refléter l'état réel.

### Phase 4 — Moteur / application du planning (P1)

- [x] ✅ Confirmer si le player applique lui-même `scheduler.tm2` (firmware) ou s'il faut un
       **daemon** côté web qui déclenche les commandes à la minute.
- [x] ✅ Implémenter le daemon (`engine.js` : horloge + déclenchement minute par minute) en
       réutilisant les commandes REST officielles. Module `ENGINE` : `resolveDay`,
       `eventsFor`, `toREST`, `createDaemon`. Intégré dans `remote.html` (onglet « Moteur »),
       testé en Node (déclenchement unique par minute).<br>
       *Note : le firmware officiel (≥ V1.13.1) interprète lui-même `/SYSTEM/scheduler.tm2` ;
       le daemon est le chemin de secours/validation piloté depuis le réseau.*

### Phase 5 — Qualité & intégration (P2)

- [x] ✅ **Kit de test exécutable sous Windows 10** pour valider sur machine réelle reliée au
       player, sans nécessiter d'accès réseau ici :
       - `test-runner.js` — suite **hors-ligne** (roundtrip TM2, moteur, MD5/Digest), sans
         dépendance npm.
       - `validate-player.js` — validation **live** (REST Digest + upload FTP vers `/SYSTEM/`),
         pur Node, avec garde-temps.
       - `run-tests.ps1` / `run-tests.bat` — orchestrateur Windows produisant un compte rendu
         consolidé `REPORT.md` / `REPORT.json` (à transmettre pour analyse).
       - `procedureTest.md` — marche à suivre détaillée pour l'exécution sur matériel réel.
- [x] ✅ **Test d'horloge** `clock-test.js` : génère un planning pour aujourd'hui avec
       `STOP` puis `PLAY FOLDER 000` à +2/+3 min sur l'horloge **du player**, l'uploade et
       observe `/api/system/state/playbackengine` → **preuve que le firmware applique le
       `scheduler.tm2`**.
       → **Validé sur le VP320 réel (09/11/2026, 14:16)** : upload de 78726 octets dans
         `/Internal shared storage/SYSTEM/scheduler.tm2`, puis `state=stopped` à la minute
         prévue et `state=playing folder=0` à la minute suivante (chronologie du rapport).
         **Le firmware interprète bien le fichier** : `tm2.js` + le calendrier produit sont
         acceptés tels quels par v1.13.1.
       → **Deux faits d'exécution découverts** :
         1. un événement « HH:MM » est déclenché **à HH:MM:00** (changement de minute), sans
            les secondes de l'heure de programmation ;
         2. l'horloge du player et celle du PC de test peuvent être **décalées de plusieurs
            minutes** (11 min observées) → tout le kit raisonne en **heure du player**
            (`/api/system/state/datetime`) et affiche le décalage.
       → Un état `maintenance` bref après l'upload est normal (le player relit son stockage).
- [ ] ⬜ Tests sur matériel réel des commandes restantes (veille, CEC, PJLINK).
- [ ] ⬜ Synchronisation horloge player (**NTP**) documentée/vérifiée.
       → Le VP320 de test est à **+11 min** par rapport au PC : à corriger (NTP) avant de
         juger un planning « déclenché en retard », l'écart étant supérieur à la minute.
- [x] ✅ Vérification firmware ≥ **V1.13.1** : `GET /api/system/attributes` →
       **v1.13.1 (2022-09-01)** sur le VP320 de test ; le kit est en **FAIL** explicite
       si la version lue est antérieure (`validate-player.js`, test « firmware »).
- [x] ✅ Revue des pages `index.html` / `remote.html` et du `web-config.json` : onglets
       Télécommande (REST Digest) et Moteur ajoutés, endpoints alignés sur l'API officielle.
- [x] ✅ Corrections de finition : Digest `uri` = chemin de requête (RFC 2617, testé),
       log moteur gardé en cas de commande inconnue (`remote.html`), OSD `index.html`
       recharge le planning mémorisé à l'ouverture + garde-fous (0 jour type, index hors bornes).
- [x] ✅ Documenter la procédure de déploiement (copie du `.tm2` dans `/SYSTEM/` via FTP —
       cf. `procedureTest.md` et `deploy.js`) + vérification firmware/NTP (section 8 bis).

## Checklist qualité (avant de considérer une tâche finie)

- Le planning éditable à la télécommande **et** via réseau.
- La sauvegarde produit un fichier **reconnu par le player** (format `scheduler.tm2`).
- Horloge player synchronisée (NTP) pour le déclenchement à la minute.
- Pas de régression des pages `index.html` / `remote.html` existantes tant qu'elles ne
  sont pas remplacées délibérément.
