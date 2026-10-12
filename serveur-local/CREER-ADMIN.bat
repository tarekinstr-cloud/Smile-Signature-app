@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Smile Signature - Compte administrateur
echo Cree un compte administrateur, ou remet le mot de passe d'un compte existant.
echo Mot de passe : lettres SANS accent, chiffres et signes du clavier (ex. Cafe2026!).
echo.

rem ---- Docker Desktop doit tourner (on le lance s'il est ferme) ----
docker info >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\attendre-docker.ps1"
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

docker compose --profile outils run --rm outils creer-admin
pause
