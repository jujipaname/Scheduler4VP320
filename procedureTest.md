# ProcedureTest.md — Procédure de test sur machine réelle

Ce dossier contient des scripts qui valident le code du planificateur **VP320/VP330**
(scheduler) **sur une machine réelle reliée au player** et produisent un **compte rendu**
(`REPORT.md` / `REPORT.json`) à transmettre pour analyse.

---

## 1. Qu'est-ce que ce script teste ?

Deux suites sont exécutées :

| Suite | Fichier | Vérifie | Réseau requis |
|-------|---------|---------|---------------|
| Hors-ligne | `test-runner.js` | Roundtrip du format `scheduler.tm2` (byte-for-byte), moteur de planning (`engine.js`), MD5 + Digest auth (`api.js`) | **Non** |
| Live | `validate-player.js` | Authentification **Digest** REST officielle + (optionnel) **upload FTP** du `scheduler.tm2` vers `/SYSTEM/` | **Oui** (player joignable) |

---

## 2. Prérequis

- **Windows 10** (PowerShell intégré).
- **Node.js ≥ 18** installé (le script l'utilise pour `fetch` et la validation).
  Téléchargement : https://nodejs.org — choisir la version **LTS**.
  Vérifier dans une invite de commandes : `node --version`.
- Le **player VP320/VP330** allumé et joignable sur le réseau (câble ou WiFi).
  Noter son **adresse IP** (l'afficheur du player ou la page web la montre).
- Les identifiants **admin** du player (utilisateur + mot de passe).

---

## 3. Copie des fichiers sur la machine Windows

Copier **l'intégralité** de ce dossier (au minimum) vers un dossier local, par ex.
`C:\Scheduler4VP320` :

```
api.js             (client REST Digest)
tm2.js             (parseur/encodeur TM2)
ftp.js             (client FTP - requis par validate-player.js ET clock-test.js)
engine.js          (moteur de secours réseau)
test-runner.js     (suite hors-ligne)
validate-player.js (validation live)
clock-test.js      (test d'horloge : le firmware applique-t-il le planning ?)
clock-test.bat     (lanceur Windows du test d'horloge)
run-tests.ps1      (orchestrateur Windows)
run-tests.bat      (lanceur double-clic)
scheduler1.tm2     (fichiers de référence)
scheduler2.tm2
```

`ftp.js` est **indispensable** : le client FTP y vit depuis qu'il est partagé entre
`validate-player.js` et `clock-test.js`. Sans lui, l'un ou l'autre s'arrête sur
`Cannot find module './ftp.js'`. Le kit vérifie maintenant lui-même et affiche la
liste des fichiers manquants plutôt qu'une stack trace Node.

> **Important :** les fichiers `.js` et `.tm2` doivent rester **dans le même dossier**
> que `run-tests.bat`, car les scripts se référencent par chemins relatifs.

---

## 4. Exécution

### Cas A — Seulement la partie hors-ligne (aucun player requis)

Double-cliquer sur **`run-tests.bat`**, ou en PowerShell :

```powershell
powershell -ExecutionPolicy Bypass -File .\run-tests.ps1
```

### Cas B — Validation live contre le player (recommandé)

Double-cliquer sur **`run-tests.bat`** avec les paramètres, ou en PowerShell :

```powershell
powershell -ExecutionPolicy Bypass -File .\run-tests.ps1 `
    -Host 192.168.1.100 -User admin -Pass "VotreMotDePasse"
```

Ajouter **`-Upload`** pour tester aussi le **déploiement FTP** du `scheduler.tm2`
vers `/SYSTEM/` :

```powershell
powershell -ExecutionPolicy Bypass -File .\run-tests.ps1 `
    -Host 192.168.1.100 -User admin -Pass "VotreMotDePasse" -Upload
```

Si le serveur FTP du player n'est pas sur le port 21 : ajouter `-FtpPort 21`.

**Compte FTP distinct du compte REST** : sur certains players le serveur FTP a ses
propres identifiants (ou refuse le compte `admin`). Dans ce cas :

```powershell
powershell -ExecutionPolicy Bypass -File .\run-tests.ps1 `
    -Host 192.168.1.100 -User admin -Pass "MotDePasseWeb" `
    -Upload -FtpUser ftp -FtpPass "MotDePasseFtp"
```

Une réponse `530 Authentication failed` (visible dans le rapport) signifie que le
serveur FTP refuse le couple utilisateur/mot de passe : ce n'est **pas** un problème
d'API REST (le Digest, lui, est validé juste avant). Sur un VP320, le compte FTP se
lit dans le menu FTP du player (ex. utilisateur `idalftp` et un mot de passe dédié).

Le script résout tout seul le dossier distant. Sur un VP320, la racine FTP **contient les
stockages** : le chemin réel est par exemple `/Internal shared storage/SYSTEM`, et non
`/SYSTEM`. Ordre des essais :

1. le chemin demandé (`/SYSTEM`) et sa forme relative (`SYSTEM`) ;
2. `/<nom du stockage>/SYSTEM` pour chaque stockage renvoyé par `GET /api/storages`
   (c'est ce qui résout le cas VP320) ;
3. `LIST` de la racine puis `<entrée>/SYSTEM` pour chaque entrée (insensible à la casse) ;
4. avec `-Mkdir`, création du dossier manquant.

Pour forcer un chemin, utiliser `-RemoteDir` :

```powershell
... -Upload -FtpUser idalftp -FtpPass "0000" -RemoteDir "/Internal shared storage/SYSTEM"
```

Par défaut le fichier envoyé est `scheduler2.tm2` (jeu de test). Pour déployer **ton**
planning exporté depuis `remote.html`, utilise `-Tm2` :

```powershell
powershell -ExecutionPolicy Bypass -File .\run-tests.ps1 `
    -Host 192.168.1.100 -User admin -Pass "MotDePasseWeb" `
    -Upload -FtpUser idalftp -FtpPass "MotDePasseFtp" -Tm2 "C:\chemin\scheduler.tm2"
```

Avant d'écrire, le script **télécharge l'ancien `/SYSTEM/scheduler.tm2`** dans
`scheduler.tm2.backup` (sauvegarde automatique). `-NoBackup` désactive ce filet.

> `-Pass` et `-Upload` sont sensibles à la casse des commutateurs (`-Upload` avec
> une majuscule).

### Cas D — Prouver que le firmware exécute le planning

Les cas A/B valident le format, l'authentification et le dépôt du fichier. Ils ne disent
pas si le **firmware applique** le planning. `clock-test.js` répond à cette question :

1. il lit l'horloge **du player** (`GET /api/system/state/datetime`) ;
2. il génère un `scheduler.tm2` pour **aujourd'hui** avec deux événements observables
   sur le même jour type : `STOP` à `--in` minutes et `PLAY FOLDER 000` à `--in+1` ;
3. il l'uploade avec sauvegarde de l'ancien fichier ;
4. il interroge `GET /api/system/state/playbackengine` toutes les 2 s et affiche les
   changements d'état.

Dans le dossier du projet, le plus simple (le `.bat` se place dans son propre dossier) :

```bat
clock-test.bat -Host 192.168.1.100 -User admin -Pass "MotDePasseWeb" -FtpUser idalftp -FtpPass "MotDePasseFtp" -In 2 -Upload
```

Ou avec Node directement — les deux syntaxes sont acceptées (`-Host valeur` comme
`--host=valeur`, casse et tirets ignorés) :

```powershell
node clock-test.js --host 192.168.1.100 --user admin --pass "MotDePasseWeb" `
                   --ftp-user idalftp --ftp-pass "MotDePasseFtp" --in 2 --upload
```

> Le script doit être lancé **depuis le dossier du projet** (ou via `clock-test.bat`) :
> `Cannot find module 'C:\Users\...\clock-test.js'` signifie simplement que le
> répertoire courant n'est pas le bon.

Sans `--upload`, le script **génère seulement** le fichier (aucune écriture sur le
player) : utile pour inspecter le planning produit.

Durée d'observation : `--watch` (par défaut `--in + 2` minutes + 30 s). Résultat attendu :

```
Observation pendant 270 s (etat de lecture toutes les 2 s) ...
  21:14:01  state=playing  folder=0
  21:16:02  state=stopped
  21:17:02  state=playing  folder=0
Arret observe (state=stopped)        : OUI
Lecture dossier 000 observee         : OUI
RESULTAT : PASS - les deux evenements ont ete executes (STOP puis PLAY FOLDER 000).
```

- **PASS** ⇒ le firmware interprète bien `/SYSTEM/scheduler.tm2`, le format de l'éditeur
  est correct de bout en bout.
- **FAIL** ⇒ aucun changement d'état. Vérifier dans cet ordre : chemin réel du fichier
  (`/Internal shared storage/SYSTEM/scheduler.tm2`), horloge du player, date du jour
  présente dans le calendrier, firmware ≥ V1.13.1.

⚠️ Ce test **remplace le planning en place**. L'ancien fichier est récupéré dans
`scheduler.tm2.backup` (dossier courant). Si un backup **différent** existe déjà, la
nouvelle sauvegarde est horodatée (`scheduler.tm2.backup.AAAAMMJJ-HHMMSS`) : aucune
sauvegarde précédente n'est écrasée. Pour remettre un planning, renvoyer le `.backup`
voulu par FTP sous le nom `scheduler.tm2`.

### Cas C — Depuis l'invite de commandes `cmd`

```bat
run-tests.bat -Host 192.168.1.100 -User admin -Pass mdp
```

---

## 5. Fichiers produits (à la fin de l'exécution)

| Fichier | Contenu |
|---------|---------|
| **`REPORT.md`** | Compte rendu consolidé lisible (à transmettre de préférence) |
| **`REPORT.json`** | Idem, au format JSON (lisible par machine) |
| `report.json` | Détail de la suite hors-ligne |
| `report-live.json` | Détail de la validation live |
| `player-state.json` | État complet renvoyé par le player (`/api/system/attributes`, `/api/system/state`, `/api/storages`, dossiers médias, bannière FTP) : firmware, NTP, stockages montés |
| `scheduler.tm2.backup` | Sauvegarde de l'ancien `/SYSTEM/scheduler.tm2` récupérée avant l'upload (`-Upload`, ou `clock-test.js --upload`) |
| `scheduler-clocktest.tm2` | Planning de test généré par `clock-test.js` (utilisable avec `-Tm2`) |
| `clock-test.json` | Résultat détaillé du test d'horloge : horloge du player, événements, chronologie des états, verdict |

Le terminal affiche aussi les résultats en direct (`PASS` / `FAIL`).

---

## 6. Comment interpréter le compte rendu (à transmettre)

Transmettez **`REPORT.md`** (ou `REPORT.json`) — c'est ce fichier que je lirai
pour juger de l'état du code.

Un **résultat attendu** est :

- **Hors-ligne :** tous les tests **PASS** (13/13). Cela valide que le format TM2,
  le moteur et l'auth Digest sont corrects et reproductibles.
- **Live :**
  - `Serveur web joignable` → **PASS** (le player répond).
  - `Auth Digest /api/auth/login` → **PASS** (HTTP 200) ⇒ les identifiants et
    l'authentification Digest fonctionnent.
  - `GET /api/system/attributes (firmware)` → **PASS** ⇒ le modèle, le numéro de
    série et la **version firmware** sont lisibles. **FAIL** si le firmware est
    antérieur à **1.13.1** (le `scheduler.tm2` n'est alors pas interprété) :
    mettre à jour le player avant de continuer.
  - `GET /api/system/state` → **PASS** (HTTP 200) ⇒ l'API officielle est bien
    interprétée. Le détail indique la **version firmware** détectée.
  - `GET /api/storages` → **PASS** (HTTP 200) ⇒ le player liste ses stockages
    (utile pour confirmer la présence de la clé USB et du dossier `/SYSTEM/`).
  - `FTP upload /SYSTEM/scheduler.tm2` (si `-Upload`) → **PASS** ⇒ le fichier est
    bien déposé ; le détail indique la taille envoyée et la taille de la sauvegarde
    `scheduler.tm2.backup`.

---

## 7. Dépannage

| Symptôme | Cause probable | Remède |
|----------|----------------|--------|
| `[ERREUR] Node.js introuvable` | Node.js non installé ou pas dans le PATH | Installer Node LTS puis relancer |
| `Auth Digest ... FAIL` | Mauvais identifiants, ou player non joignable | Vérifier `-User`/`-Pass` et l'IP (`-Host`) |
| `Serveur web joignable ... FAIL` | IP incorrecte ou player éteint | Vérifier `ping <ip>` depuis la machine |
| `FTP upload ... FAIL` | Serveur FTP désactivé ou port non standard | Activer le FTP sur le player, renseigner `-FtpPort` |
| `FTP upload ... : 530 Authentication failed` | Compte FTP différent du compte REST/Digest | Renseigner `-FtpUser` / `-FtpPass` (ou `anonymous`) ; vérifier le réglage FTP du player |
| `FTP upload ... : 550` | `/SYSTEM` absent, ou racine FTP du compte différente de la racine du stockage | Le message affiche désormais **le contenu de la racine FTP** (`racine FTP = [...]`) : si `SYSTEM` y figure, le script le trouve tout seul (chemin relatif / casse). S'il est vraiment absent, ajouter `-Mkdir` pour le créer |
| `GET /api/system/attributes (firmware) ... FAIL` | Firmware < 1.13.1 | Mettre à jour le player (le scheduler n'est pas pris en charge avant) |
| PowerShell refuse le script | Politique d'exécution | Utiliser `-ExecutionPolicy Bypass` (déjà fait par le `.bat`) |
| Erreurs de parsing (`Jeton inattendu « ) »`, `Ã©` dans les messages) | `run-tests.ps1` réenregistré en UTF-8 **sans BOM** ou avec des accents | Le fichier doit rester **ASCII pur + BOM UTF-8** (voir l'en-tête du script) |
| Accents cassés dans `REPORT.md` (`modÃ¨le`) | `Get-Content` sans `-Encoding UTF8` (PowerShell 5.1 lit en ANSI) | Corrigé depuis la version courante du script |

---

## 8. Rappels matériel (à vérifier pendant les tests)

- Firmware du player **≥ V1.13.1** (sinon le `scheduler.tm2` n'est pas lu).
  *Comment vérifier :* page web embarquée `http://<ip>/` → informations système
  (version firmware affichée), ou menu « System/About » sur l'écran. Si la version
  est antérieure, mettre à jour le firmware avant d'aller plus loin (le `.tm2`
  serait ignoré silencieusement).
- Le fichier doit s'appeler **`scheduler.tm2`** et se trouver dans **`/SYSTEM/`**
  (ne jamais renommer).
- **Exécution réelle** : lancer `clock-test.js` (Cas D) et obtenir `PASS`. C'est la seule
  preuve que le firmware applique le planning.
- Horloge du player synchronisée **NTP** pour un déclenchement précis à la minute.
  *Comment vérifier :* activer le client NTP dans la configuration réseau du player
  (serveur NTP à indiquer, ex. `pool.ntp.org` ou un serveur interne), puis comparer
  l'heure affichée par le player avec une référence fiable ; un écart > 30 s peut
  décaler les événements d'une minute sur les plages courtes.

---
