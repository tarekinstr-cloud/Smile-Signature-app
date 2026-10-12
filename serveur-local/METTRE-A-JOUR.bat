@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Smile Signature - Mise a jour
echo ================================================================
echo   Mise a jour de l'application et de la base
echo   (apres avoir remplace les fichiers par la nouvelle version)
echo ================================================================

rem ---- Docker Desktop doit tourner (on le lance s'il est ferme) ----
docker info >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\attendre-docker.ps1"
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

echo [1/3] Reconstruction de l'application et redemarrage...
docker compose up -d --build || goto erreur
echo.
echo [2/3] Nouvelles migrations de la base...
docker compose --profile outils run --rm outils migrer || goto erreur
echo.
echo [3/3] Verification
docker compose --profile outils run --rm outils verifier
echo.
echo Mise a jour terminee. Rechargez l'application sur chaque appareil.
pause
exit /b 0

:erreur
echo.
echo ERREUR pendant la mise a jour. L'ancienne version de la base est intacte.
pause
exit /b 1
