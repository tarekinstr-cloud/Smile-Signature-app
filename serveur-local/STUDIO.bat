@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Smile Signature - Studio (facultatif)
echo Lance Studio, le tableau de bord Supabase, sur http://localhost:3000 (ce PC uniquement).
echo Il utilise environ 250 Mo de memoire en plus : fermez-le avec STUDIO-ARRETER.bat apres usage.

rem ---- Docker Desktop doit tourner (on le lance s'il est ferme) ----
docker info >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\attendre-docker.ps1"
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

docker compose --profile studio up -d meta studio || (pause & exit /b 1)
ping -n 16 127.0.0.1 >nul
start "" "http://localhost:3000"
