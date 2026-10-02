@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Smile Signature - Installation du serveur local
echo ================================================================
echo   Smile Signature - Installation du serveur local
echo   (a faire une seule fois, internet necessaire)
echo ================================================================
echo.

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

if not exist .env (
  copy /y .env.example .env >nul
  echo Fichier de reglages .env cree.
)
echo [1/5] Generation des mots de passe internes...
docker compose --profile outils run --rm secrets || goto erreur
echo.
echo [2/5] Telechargement et demarrage du serveur
echo       (10 a 30 minutes la premiere fois selon la connexion)...
docker compose up -d --build || goto erreur
echo.
echo [3/5] Creation de la base (migrations, photos, fonction PIN)...
docker compose --profile outils run --rm outils migrer || goto erreur
echo.
echo [4/5] Compte administrateur de l'application
docker compose --profile outils run --rm outils creer-admin || goto erreur
echo.
echo [5/5] Verification
docker compose --profile outils run --rm outils verifier

set "PORT_SUFFIX="
for /f "tokens=2 delims==" %%p in ('findstr /b "HTTP_PORT=" .env 2^>nul') do if not "%%p"=="80" set "PORT_SUFFIX=:%%p"

echo.
echo ================================================================
echo   Installation terminee. L'application est disponible :
call :adresses
echo ================================================================
pause
exit /b 0

:erreur
echo.
echo ERREUR pendant l'installation. Relancez 1-INSTALLER.bat : ce qui est deja fait n'est pas refait.
echo Si l'erreur revient, envoyez une photo de cette fenetre.
pause
exit /b 1

:adresses
echo.
echo  Sur ce PC (le POS) :        http://localhost%PORT_SUFFIX%
echo  Sur les tablettes/telephones (meme Wi-Fi) :
for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notmatch 'vEthernet|Loopback|WSL|Docker' -and $_.IPAddress -notlike '169.254*' } | ForEach-Object { $_.IPAddress }"`) do echo                               http://%%a%PORT_SUFFIX%
echo.
exit /b 0
