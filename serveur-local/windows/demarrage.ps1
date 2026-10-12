# Demarrage du serveur et mode caisse.
#   -Auto   : lance par la tache planifiee a l'ouverture de session (5-ACTIVER-DEMARRAGE-AUTO.bat).
#             Ouvre le mode caisse si KIOSQUE_AU_DEMARRAGE=oui dans config.ini.
#   -Caisse : OUVRIR-CAISSE.bat et le raccourci du Bureau : (re)ouvre toujours le mode caisse.
# Etapes : Docker Engine pret -> docker compose up -d -> l'application et l'API repondent.
# Pendant l'attente, le mode caisse affiche une page locale "Demarrage du serveur..." qui suit ces etapes
# (windows\attente\attente.html) et ouvre l'application des qu'elle est prete.
param([switch]$Auto, [switch]$Caisse)

. "$PSScriptRoot\commun.ps1"

$journal = 'demarrage.log'
$config = Read-Config
$ouvrir = $Caisse -or ($Auto -and (Test-Oui $config['KIOSQUE_AU_DEMARRAGE']))
$source = 'OUVRIR-CAISSE'
if ($Auto) { $source = 'ouverture de session' }
Write-Journal $journal "---- Demarrage ($source)"

function Stop-AvecErreur([string]$Etape, [string]$Message) {
  Write-Etat $Etape $Message
  Write-Journal $journal "ERREUR : $Message"
  if ((Get-ProcessusKiosque).Count -eq 0) {
    # Pas de mode caisse pour afficher l'erreur : fenetre de message.
    try {
      Add-Type -AssemblyName PresentationFramework
      [System.Windows.MessageBox]::Show(
        "Le serveur Smile Signature n'a pas demarre.`n`n$Message`n`nLancez VERIFIER.bat (dossier serveur-local) pour voir ce qui ne va pas.",
        'Smile Signature', 'OK', 'Error') | Out-Null
    } catch { }
  }
  exit 1
}

if ($Caisse) {
  # Rouvrir = fermer la fenetre de caisse actuelle (si elle existe) puis en ouvrir une nouvelle.
  if (Close-Kiosque) { Write-Journal $journal 'Mode caisse deja ouvert : ferme puis rouvert.' }
} elseif ($ouvrir -and (Get-ProcessusKiosque).Count -gt 0) {
  $ouvrir = $false
}

Write-Etat 'verification'
if ((Test-DockerPret) -and (Get-ServeurManquant) -eq '') {
  Write-Etat 'pret'
  Write-Journal $journal 'Serveur deja pret.'
  if ($ouvrir) { Open-Kiosque (Get-UrlLocale); Write-Journal $journal 'Mode caisse ouvert.' }
  exit 0
}

# Docker Desktop d'abord (sa fenetre eventuelle s'ouvre ainsi SOUS le mode caisse), puis la page d'attente.
if (-not (Test-DockerPret) -and -not (Test-DockerDesktopLance)) {
  Write-Etat 'docker'
  if ($Auto) {
    # A l'ouverture de session, Docker Desktop se lance normalement tout seul (Start Docker Desktop when you sign
    # in) : on lui laisse 30 secondes, car un second lancement ouvrirait sa fenetre.
    for ($i = 0; $i -lt 30 -and -not (Test-DockerDesktopLance); $i++) { Start-Sleep -Seconds 1 }
  }
}
if (-not (Test-DockerPret) -and -not (Test-DockerDesktopLance)) {
  if (Start-DockerDesktop) {
    Write-Journal $journal 'Docker Desktop lance.'
    Start-Sleep -Seconds 5
  } else {
    Stop-AvecErreur 'erreur_docker' 'Docker Desktop est introuvable sur ce PC (voir LISEZMOI.md, etape 1).'
  }
}
if ($ouvrir) { Open-Kiosque (Get-UrlAttente); Write-Journal $journal 'Mode caisse ouvert sur la page d''attente.' }

# Si un autre demarrage est deja en cours (ouverture de session + double-clic), on attend simplement le serveur.
$verrou = New-Object System.Threading.Mutex($false, 'Local\SmileSignatureDemarrage')
try { $principal = $verrou.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $principal = $true }

Write-Etat 'docker'
$dockerOk = Wait-Docker 480 { param($s) Write-Etat 'docker' "$s s" }
if (-not $dockerOk) {
  Stop-AvecErreur 'erreur_docker' 'Docker Engine ne repond pas apres 8 minutes. Ouvrez Docker Desktop pour voir le message (mise a jour WSL, virtualisation...).'
}
Write-Journal $journal 'Docker Engine pret.'

if ($principal) {
  Write-Etat 'services'
  $r = $null
  for ($essai = 1; $essai -le 3; $essai++) {
    $r = Invoke-Docker 'compose up -d' 600
    if ($r.Code -eq 0) { break }
    Write-Journal $journal "docker compose up -d (essai $essai) : $($r.Sortie)"
    Start-Sleep -Seconds 10
  }
  if ($r.Code -ne 0) {
    $fin = (($r.Sortie -split "`n") | Select-Object -Last 2) -join ' '
    Stop-AvecErreur 'erreur_services' "Les services ne demarrent pas : $fin"
  }
  Write-Journal $journal 'Services lances (docker compose up -d).'
}

Write-Etat 'api'
$debut = Get-Date
$manquant = Get-ServeurManquant
while ($manquant -ne '') {
  $ecoule = [int]((Get-Date) - $debut).TotalSeconds
  if ($ecoule -ge 300) {
    Stop-AvecErreur 'erreur_api' "Le serveur ne repond pas apres 5 minutes ($manquant)."
  }
  Write-Etat 'api' $manquant
  Start-Sleep -Seconds 3
  $manquant = Get-ServeurManquant
}

Write-Etat 'pret'
Write-Journal $journal ('Serveur pret en {0} s.' -f [int](([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $script:DebutEtat) / 1000))
if ($principal) { $verrou.ReleaseMutex() }
exit 0
