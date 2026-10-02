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
if not errorlevel 1 goto docker_ok
echo Demarrage de Docker Desktop...
if exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" start "" "%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
set /a tries=0
:wait_docker
ping -n 6 127.0.0.1 >nul
docker info >nul 2>&1
if not errorlevel 1 goto docker_ok
set /a tries+=1
if %tries% lss 60 goto wait_docker
echo.
echo ERREUR : Docker Desktop ne demarre pas. Est-il installe ? (voir LISEZMOI.md, etape 1)
pause
exit /b 1
:docker_ok

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
