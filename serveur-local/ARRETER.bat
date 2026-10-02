@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Smile Signature - Arret
echo Arret propre du serveur (la base enregistre tout avant de s'arreter)...
docker compose stop
echo.
echo Serveur arrete. Vous pouvez eteindre le PC.
ping -n 6 127.0.0.1 >nul
