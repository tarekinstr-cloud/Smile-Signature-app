@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Smile Signature - Restauration
rem Liste les sauvegardes, demande laquelle restaurer et une confirmation, sauvegarde l'etat actuel, restaure.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\restaurer.ps1"
echo.
pause
