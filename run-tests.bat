@echo off
rem run-tests.bat - Lance run-tests.ps1 avec ExecutionPolicy Bypass.
rem Usage:
rem   run-tests.bat                                 (hors-ligne uniquement)
rem   run-tests.bat -Host 192.168.1.100 -User admin -Pass votreMdp
rem   run-tests.bat -Host 192.168.1.100 -Upload     (avec upload FTP)
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-tests.ps1" %*
echo.
echo Fin. Verifiez REPORT.md dans ce dossier.
pause
