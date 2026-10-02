@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Smile Signature - Pare-feu Windows
rem Autorise les tablettes du Wi-Fi a joindre le serveur (port HTTP). Demande les droits administrateur.
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b 0
)
set "P=80"
for /f "tokens=2 delims==" %%p in ('findstr /b "HTTP_PORT=" .env 2^>nul') do set "P=%%p"
netsh advfirewall firewall delete rule name="Smile Signature (serveur local)" >nul 2>&1
netsh advfirewall firewall add rule name="Smile Signature (serveur local)" dir=in action=allow protocol=TCP localport=%P% profile=private,domain
echo.
echo Port %P% ouvert pour les reseaux prives. Le Wi-Fi du restaurant doit etre en « Reseau prive »
echo (Parametres Windows ^> Reseau et Internet ^> Wi-Fi ^> nom du reseau ^> Type de profil : Prive).
pause
