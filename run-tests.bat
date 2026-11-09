@echo off
rem run-tests.bat - Lance run-tests.ps1 avec ExecutionPolicy Bypass.
rem Usage:
rem   run-tests.bat                                 (hors-ligne uniquement)
rem   run-tests.bat -Host 192.168.1.100 -User admin -Pass votreMdp
rem   run-tests.bat -Host 192.168.1.100 -Upload     (avec upload FTP)
setlocal
rem UTF-8 dans la console : evite les accents casses dans les sorties Node.js.
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-tests.ps1" %*
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (
  echo Fin - tous les tests sont OK. Voir REPORT.md dans ce dossier.
) else (
  echo Fin - code retour %RC%. Voir REPORT.md dans ce dossier.
)
pause
exit /b %RC%
