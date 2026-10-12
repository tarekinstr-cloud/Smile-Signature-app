@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Smile Signature - Quitter le mode caisse
rem Pour l'administrateur : ferme la caisse plein ecran. Le serveur continue de tourner pour les tablettes.
rem Pour atteindre ce fichier quand la caisse est en plein ecran : Alt+Tab, touche Windows, ou Ctrl+Alt+Suppr.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\quitter-kiosque.ps1"
ping -n 6 127.0.0.1 >nul
