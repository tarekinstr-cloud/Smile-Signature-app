@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Smile Signature - Demarrage
echo Demarrage du serveur Smile Signature...

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
call :adresses
start "" "http://localhost%PORT_SUFFIX%"
ping -n 6 127.0.0.1 >nul
exit /b 0

:erreur
echo.
echo ERREUR : le serveur ne demarre pas. Lancez VERIFIER.bat pour voir ce qui ne va pas.
pause
exit /b 1

:adresses
echo.
echo  Sur ce PC (le POS) :        http://localhost%PORT_SUFFIX%
echo  Sur les tablettes/telephones (meme Wi-Fi) :
for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notmatch 'vEthernet|Loopback|WSL|Docker' -and $_.IPAddress -notlike '169.254*' } | ForEach-Object { $_.IPAddress }"`) do echo                               http://%%a%PORT_SUFFIX%
echo.
exit /b 0
