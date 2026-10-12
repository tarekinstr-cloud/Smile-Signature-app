@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Smile Signature - Sauvegarde
echo ================================================================
echo   Sauvegarde de la base et des photos
echo   (dossier serveur-local\sauvegardes, + copie si COPIE_SAUVEGARDES est rempli dans config.ini)
echo ================================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\sauvegarde.ps1" -Mode manuelle
echo.
pause
