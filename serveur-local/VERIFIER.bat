@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Smile Signature - Verification

rem ---- Docker Desktop doit tourner (on le lance s'il est ferme) ----
docker info >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\attendre-docker.ps1"
  if errorlevel 1 goto etat_pos
)

echo Etat des services :
docker compose ps --format "table {{.Name}}\t{{.Status}}"
echo.
docker compose --profile outils run --rm outils verifier
echo.
echo Memoire utilisee par chaque service :
docker stats --no-stream --format "table {{.Name}}\t{{.MemUsage}}"

:etat_pos
rem Adresses (et changement d'IP), demarrage automatique, sauvegardes, place sur le disque.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\etat-pos.ps1"
pause
exit /b 0
