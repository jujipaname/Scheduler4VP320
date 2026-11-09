@echo off
rem ---------------------------------------------------------------------------
rem  clock-test.bat - prove that the player firmware applies scheduler.tm2
rem
rem  Double-click, or run from any folder:
rem    clock-test.bat -Host 192.168.8.20 -User admin -Pass password
rem                   -FtpUser idalftp -FtpPass 0000 -Upload
rem
rem  The script runs in its own folder (that is where the .tm2 files and the
rem  backups are written). Both "-Key value" and "--key=value" are accepted.
rem  Add "-Restore" to put the previous schedule back after the test.
rem
rem  Only single-line IFs and labels on purpose: cmd.exe parses multi-line
rem  "( ... )" blocks unreliably, which is what printed
rem      "'etre' n'est pas reconnu en tant que commande interne"
rem  here. Keep this file ASCII, CRLF, no nested parentheses.
rem ---------------------------------------------------------------------------
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

if not exist "clock-test.js" goto missing
if not exist "tm2.js" goto missing
if not exist "api.js" goto missing
if not exist "ftp.js" goto missing
goto ready

:missing
echo ============================================================
echo   [ERREUR] Fichiers manquants dans ce dossier:
if not exist "clock-test.js" echo     - clock-test.js
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
node clock-test.js %*
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" goto failed
echo Termine : PASS, le firmware a execute le planning.
pause
exit /b 0

:failed
echo Termine avec le code %RC%, voir le message RESULTAT ci-dessus.
echo Pour remettre le planning du player: relance avec -Restore
pause
exit /b %RC%

:nonode
echo [ERREUR] Node.js introuvable dans le PATH.
echo Installe Node.js LTS depuis https://nodejs.org/ puis relance.
pause
exit /b 1
