@echo off
rem ---------------------------------------------------------------------------
rem  logger-test.bat - probe the "Logger" REST domain of the player
rem
rem  Double-click, or run from any folder:
rem    logger-test.bat -Host 192.168.8.20 -User admin -Pass password
rem
rem  Read-only probe: nothing on the player is touched except the probe file
rem  s4vp-probe.tmp that the script creates and deletes itself.
rem  Both "-Key value" and "--key=value" are accepted.
rem  Single-line IFs and labels only, no "( ... )" blocks (cmd.exe quirk).
rem ---------------------------------------------------------------------------
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

if not exist "logger-test.js" goto missing
if not exist "tm2.js" goto missing
if not exist "api.js" goto missing
goto ready

:missing
echo ============================================================
echo   [ERREUR] Fichiers manquants dans ce dossier:
if not exist "logger-test.js" echo     - logger-test.js
if not exist "tm2.js" echo     - tm2.js
if not exist "api.js" echo     - api.js
echo   Dossier courant: %CD%
echo   Copie l integralite du kit (procedureTest.md, section 3),
echo   ou lance git pull dans ce dossier, puis relance.
echo ============================================================
pause
exit /b 2

:ready
node logger-test.js %*
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" goto done-ok
echo Termine avec le code %RC%, voir les lignes [FAIL] ci-dessus.
echo Le detail complet est dans logger-test.json.
pause
exit /b %RC%

:done-ok
echo Termine : sondes executees, voir le Resume ci-dessus.
echo Le detail complet est dans logger-test.json.
pause
exit /b 0

:nonode
echo [ERREUR] Node.js introuvable dans le PATH.
echo Installe Node.js LTS depuis https://nodejs.org/ puis relance.
pause
exit /b 1
