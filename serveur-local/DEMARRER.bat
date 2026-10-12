@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Smile Signature - Demarrage
echo Demarrage du serveur Smile Signature...

rem ---- Docker Desktop doit tourner (on le lance s'il est ferme) ----
docker info >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\attendre-docker.ps1"
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

docker compose up -d || goto erreur

set "PORT_SUFFIX="
for /f "tokens=2 delims==" %%p in ('findstr /b "HTTP_PORT=" .env 2^>nul') do if not "%%p"=="80" set "PORT_SUFFIX=:%%p"

echo Attente du serveur...
set /a n=0
:wait_web
curl -s -f -o nul http://localhost%PORT_SUFFIX%/healthz && goto web_ok
set /a n+=1
if %n% geq 90 goto erreur
ping -n 3 127.0.0.1 >nul
goto wait_web
:web_ok
echo Serveur pret.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\adresses.ps1"
start "" "http://localhost%PORT_SUFFIX%"
ping -n 6 127.0.0.1 >nul
exit /b 0

:erreur
echo.
echo ERREUR : le serveur ne demarre pas. Lancez VERIFIER.bat pour voir ce qui ne va pas.
pause
exit /b 1

