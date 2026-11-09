@echo off
rem ---------------------------------------------------------------------------
rem  deploy.bat - copy a scheduler.tm2 to the player over FTP, one command.
rem
rem  Usage from any folder (there is nothing else to configure):
rem    deploy.bat planning.tm2 -Host 192.168.8.20 -User admin -Pass webpass
rem                            -FtpUser idalftp -FtpPass ftppass
rem
rem  The launcher runs in its own folder (that is where tm2.js, api.js and
rem  ftp.js live), checks Node and the required files, then forwards to
rem  deploy-scheduler.js. The remote file is always scheduler.tm2 (the player
rem  refuses other names). Add -NoBackup to skip the automatic backup.
rem  Single-line IFs and labels only, no "( ... )" blocks (cmd.exe quirk).
rem ---------------------------------------------------------------------------
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

if not exist "deploy-scheduler.js" goto missing
if not exist "tm2.js" goto missing
if not exist "api.js" goto missing
if not exist "ftp.js" goto missing
goto ready

:missing
echo ============================================================
echo   [ERREUR] Fichiers manquants dans ce dossier:
if not exist "deploy-scheduler.js" echo     - deploy-scheduler.js
if not exist "tm2.js" echo     - tm2.js
if not exist "api.js" echo     - api.js
if not exist "ftp.js" echo     - ftp.js
echo   Dossier courant: %CD%
echo   Copie l integralite du kit (procedureTest.md, section 3),
echo   ou lance git pull dans ce dossier, puis relance.
echo ============================================================
pause
exit /b 2

:ready
if "%~1"=="" goto runall
set "FILEARG=%~1"
shift
node deploy-scheduler.js -File "%FILEARG%" %*
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" goto failed
echo Termine : le planning est dans le player.
pause
exit /b 0

:runall
node deploy-scheduler.js %*
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" goto failed
echo Termine : le planning est dans le player.
pause
exit /b 0

:failed
echo Deploiement refuse : voir le message [ERREUR] ci-dessus, puis relance.
pause
exit /b %RC%

:nonode
echo [ERREUR] Node.js introuvable dans le PATH.
echo Installe Node.js LTS depuis https://nodejs.org/ puis relance.
pause
exit /b 1
