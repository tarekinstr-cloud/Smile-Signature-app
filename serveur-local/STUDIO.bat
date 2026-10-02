@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Smile Signature - Studio (facultatif)
echo Lance Studio, le tableau de bord Supabase, sur http://localhost:3000 (ce PC uniquement).
echo Il utilise environ 250 Mo de memoire en plus : fermez-le avec STUDIO-ARRETER.bat apres usage.

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

docker compose --profile studio up -d meta studio || (pause & exit /b 1)
ping -n 16 127.0.0.1 >nul
start "" "http://localhost:3000"
