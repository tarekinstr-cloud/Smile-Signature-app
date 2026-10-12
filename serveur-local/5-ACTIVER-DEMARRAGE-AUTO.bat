@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Smile Signature - Mise en production du POS
rem Demarrage automatique (Docker, serveur, caisse plein ecran), raccourcis du Bureau, sauvegardes planifiees.
rem Peut etre relance sans risque (apres un changement de config.ini, une mise a jour...).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\activer.ps1"
echo.
pause
