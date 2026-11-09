@echo off
rem ---------------------------------------------------------------------------
rem  clock-test.bat - prove that the player firmware applies scheduler.tm2
rem
rem  Double-click, or run from any folder:
rem    clock-test.bat -Host 192.168.8.20 -User admin -Pass password
rem                   -FtpUser idalftp -FtpPass 0000 -Upload
rem
rem  The script always runs in its own folder (that is where the .tm2 files and
rem  the backups are written). Both -Key value and --key=value are accepted.
rem ---------------------------------------------------------------------------
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERREUR] Node.js introuvable dans le PATH.
  echo Installez Node.js LTS depuis https://nodejs.org/ puis relancez.
  pause
  exit /b 1
)

node clock-test.js %*
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo Termine : PASS ^(le firmware a execute le planning^).
) else (
  echo Termine avec le code %RC% : voir le message RESULTAT ci-dessus.
)
pause
exit /b %RC%
