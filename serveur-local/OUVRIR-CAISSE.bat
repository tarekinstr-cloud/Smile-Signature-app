@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Smile Signature - Caisse
rem Ouvre l'application en plein ecran (Microsoft Edge, mode kiosque). Si le serveur n'est pas pret, une page
rem "Demarrage du serveur..." s'affiche et ouvre l'application des qu'il repond. Aucune fenetre noire ne reste.
echo Ouverture de la caisse en plein ecran...
start "" "%SystemRoot%\System32\conhost.exe" --headless "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0windows\demarrage.ps1" -Caisse
