@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Smile Signature - Import depuis le Supabase en ligne
rem Copie la configuration (salles, carte, imprimantes, employes, stock, photos...) du Supabase en ligne vers ce
rem serveur local. Demande l'adresse du projet et la cle service_role, jamais enregistrees. Relancable sans doublon.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\importer-en-ligne.ps1"
echo.
pause
