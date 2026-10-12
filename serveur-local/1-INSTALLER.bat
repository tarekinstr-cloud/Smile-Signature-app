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
if errorlevel 1 (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\attendre-docker.ps1"
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

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

echo.
echo ================================================================
echo   Installation terminee. L'application est disponible :
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\adresses.ps1"
echo.
echo   Etape suivante (POS du restaurant) : 5-ACTIVER-DEMARRAGE-AUTO.bat
echo   = demarrage automatique, caisse plein ecran, sauvegardes (LISEZMOI.md, etape 5).
echo ================================================================
pause
exit /b 0

:erreur
echo.
echo ERREUR pendant l'installation. Relancez 1-INSTALLER.bat : ce qui est deja fait n'est pas refait.
echo Si l'erreur revient, envoyez une photo de cette fenetre.
pause
exit /b 1

