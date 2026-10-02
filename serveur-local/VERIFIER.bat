@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Smile Signature - Verification

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

echo Etat des services :
docker compose ps --format "table {{.Name}}\t{{.Status}}"
echo.
docker compose --profile outils run --rm outils verifier
echo.
echo Memoire utilisee par chaque service :
docker stats --no-stream --format "table {{.Name}}\t{{.MemUsage}}"

set "PORT_SUFFIX="
for /f "tokens=2 delims==" %%p in ('findstr /b "HTTP_PORT=" .env 2^>nul') do if not "%%p"=="80" set "PORT_SUFFIX=:%%p"

call :adresses
pause
exit /b 0

:adresses
echo.
echo  Sur ce PC (le POS) :        http://localhost%PORT_SUFFIX%
echo  Sur les tablettes/telephones (meme Wi-Fi) :
for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notmatch 'vEthernet|Loopback|WSL|Docker' -and $_.IPAddress -notlike '169.254*' } | ForEach-Object { $_.IPAddress }"`) do echo                               http://%%a%PORT_SUFFIX%
echo.
exit /b 0
