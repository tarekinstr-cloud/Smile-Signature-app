@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
docker compose --profile studio stop studio meta
docker compose --profile studio rm -f studio meta >nul
echo Studio arrete.
ping -n 4 127.0.0.1 >nul
