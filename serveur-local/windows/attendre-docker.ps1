# Docker Desktop doit tourner : lance s'il est ferme (installation pour tous ou pour l'utilisateur seul), puis
# attend que Docker Engine reponde (8 minutes au plus). Utilise par les fichiers .bat.
. "$PSScriptRoot\commun.ps1"
if (Test-DockerPret) { exit 0 }
if (-not (Find-DockerDesktop) -and -not (Test-DockerDesktopLance)) {
  Write-Host 'ERREUR : Docker Desktop est introuvable sur ce PC. Est-il installe ? (voir LISEZMOI.md, etape 1)'
  exit 1
}
Write-Host 'Demarrage de Docker Desktop (1 a 3 minutes)...'
$ok = Wait-Docker 480 { param($s) if ($s -gt 0 -and $s % 30 -lt 3) { Write-Host "  ... $s s" } }
if ($ok) { Write-Host 'Docker est pret.'; exit 0 }
Write-Host ''
Write-Host 'ERREUR : Docker Desktop ne demarre pas. Ouvrez Docker Desktop pour lire son message'
Write-Host '(mise a jour de WSL, virtualisation desactivee dans le BIOS...). Voir LISEZMOI.md, En cas de panne.'
exit 1
