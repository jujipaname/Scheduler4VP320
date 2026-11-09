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
api.js            (client REST Digest)
tm2.js            (parseur/encodeur TM2)
engine.js         (moteur de planning)
test-runner.js    (suite hors-ligne)
validate-player.js(validation live)
run-tests.ps1     (orchestrateur Windows)
run-tests.bat     (lanceur double-clic)
scheduler1.tm2    (fichiers de référence)
scheduler2.tm2
```

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

> `-Pass` et `-Upload` sont sensibles à la casse des commutateurs (`-Upload` avec
> une majuscule).

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

Le terminal affiche aussi les résultats en direct (`PASS` / `FAIL`).

---

## 6. Comment interpréter le compte rendu (à transmettre)

Transmettez **`REPORT.md`** (ou `REPORT.json`) — c'est ce fichier que je lirai
pour juger de l'état du code.

Un **résultat attendu** est :

- **Hors-ligne :** tous les tests **PASS** (12/12). Cela valide que le format TM2,
  le moteur et l'auth Digest sont corrects et reproductibles.
- **Live :**
  - `Serveur web joignable` → **PASS** (le player répond).
  - `Auth Digest /api/auth/login` → **PASS** (HTTP 200) ⇒ les identifiants et
    l'authentification Digest fonctionnent.
  - `GET /api/system/state` → **PASS** (HTTP 200) ⇒ l'API officielle est bien
    interprétée.
  - `FTP upload /SYSTEM/scheduler.tm2` (si `-Upload`) → **PASS** ⇒ le fichier est
    bien déposé et relu par le player.

---

## 7. Dépannage

| Symptôme | Cause probable | Remède |
|----------|----------------|--------|
| `[ERREUR] Node.js introuvable` | Node.js non installé ou pas dans le PATH | Installer Node LTS puis relancer |
| `Auth Digest ... FAIL` | Mauvais identifiants, ou player non joignable | Vérifier `-User`/`-Pass` et l'IP (`-Host`) |
| `Serveur web joignable ... FAIL` | IP incorrecte ou player éteint | Vérifier `ping <ip>` depuis la machine |
| `FTP upload ... FAIL` | Serveur FTP désactivé ou port non standard | Activer le FTP sur le player, renseigner `-FtpPort` |
| PowerShell refuse le script | Politique d'exécution | Utiliser `-ExecutionPolicy Bypass` (déjà fait par le `.bat`) |

---

## 8. Rappels matériel (à vérifier pendant les tests)

- Firmware du player **≥ V1.13.1** (sinon le `scheduler.tm2` n'est pas lu).
  *Comment vérifier :* page web embarquée `http://<ip>/` → informations système
  (version firmware affichée), ou menu « System/About » sur l'écran. Si la version
  est antérieure, mettre à jour le firmware avant d'aller plus loin (le `.tm2`
  serait ignoré silencieusement).
- Le fichier doit s'appeler **`scheduler.tm2`** et se trouver dans **`/SYSTEM/`**
  (ne jamais renommer).
- Horloge du player synchronisée **NTP** pour un déclenchement précis à la minute.
  *Comment vérifier :* activer le client NTP dans la configuration réseau du player
  (serveur NTP à indiquer, ex. `pool.ntp.org` ou un serveur interne), puis comparer
  l'heure affichée par le player avec une référence fiable ; un écart > 30 s peut
  décaler les événements d'une minute sur les plages courtes.

---
