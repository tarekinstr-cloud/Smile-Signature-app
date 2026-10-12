# Sauvegarde : base (pg_dump compresse) + photos et fonds de salle, dans serveur-local\sauvegardes\<date>-<type>.
#   -Mode manuelle     : SAUVEGARDER-MAINTENANT.bat (affiche tout, lance le serveur si besoin).
#   -Mode quotidienne  : tache planifiee chaque jour (HEURE_SAUVEGARDE de config.ini).
#   -Mode cloture      : tache planifiee toutes les 10 minutes ; ne sauvegarde que si une cloture de caisse a eu
#                        lieu depuis la derniere sauvegarde.
#   -Mode avant-restauration : appele par restaurer.ps1.
# Ensuite : copie vers COPIE_SAUVEGARDES (cle USB, disque D:) et effacement des sauvegardes de plus de
# JOURS_A_GARDER jours.
param([ValidateSet('manuelle', 'quotidienne', 'cloture', 'avant-restauration')][string]$Mode = 'manuelle')

. "$PSScriptRoot\commun.ps1"

$journal = 'sauvegarde.log'
$interactif = ($Mode -eq 'manuelle' -or $Mode -eq 'avant-restauration')
$fichierResultat = Join-Path $DossierJournaux 'derniere-sauvegarde.txt'

function Write-Info([string]$Message) {
  if ($interactif) { Write-Host $Message }
  Write-Journal $journal "[$Mode] $Message"
}

# Resultat de la derniere tentative, affiche par VERIFIER.bat.
function Write-Resultat([string]$Statut, [string]$Message) {
  try {
    if (-not (Test-Path $DossierJournaux)) { New-Item -ItemType Directory -Path $DossierJournaux | Out-Null }
    $lignes = @("date=$(Get-Date -Format 'yyyy-MM-dd HH:mm')", "mode=$Mode", "statut=$Statut", "message=$Message")
    [System.IO.File]::WriteAllLines($fichierResultat, [string[]]$lignes, (New-Object System.Text.UTF8Encoding($false)))
  } catch { }
}

function Stop-Sauvegarde([string]$Message) {
  Write-Info "ERREUR : $Message"
  Write-Resultat 'ERREUR' $Message
  exit 1
}

$config = Read-Config

# ---- Docker et base de donnees ----
if ($Mode -eq 'cloture') {
  # Verification legere toutes les 10 minutes : on ne lance rien si le serveur ne tourne pas.
  if (-not (Test-ConteneurSain 'smile-db')) { exit 0 }
} else {
  if (-not (Test-DockerPret)) {
    if ($Mode -eq 'quotidienne') {
      # Au demarrage du PC (sauvegarde de 4 h manquee), Docker peut mettre quelques minutes a demarrer.
      if (-not (Wait-Docker 900)) { Stop-Sauvegarde 'Docker ne demarre pas : sauvegarde impossible.' }
    } else {
      Write-Info 'Demarrage de Docker Desktop...'
      if (-not (Wait-Docker 480)) { Stop-Sauvegarde 'Docker ne demarre pas (voir LISEZMOI.md, En cas de panne).' }
    }
  }
  if (-not (Test-ConteneurSain 'smile-db')) {
    if ($Mode -eq 'quotidienne') {
      # Base arretee expres (ARRETER.bat) ou serveur encore en demarrage : on attend jusqu'a 10 minutes.
      $n = 0
      while (-not (Test-ConteneurSain 'smile-db') -and $n -lt 120) { Start-Sleep -Seconds 5; $n++ }
      if (-not (Test-ConteneurSain 'smile-db')) { Stop-Sauvegarde 'Le serveur est arrete : pas de sauvegarde (lancez DEMARRER.bat).' }
    } else {
      Write-Info 'Demarrage de la base de donnees...'
      $r = Invoke-Docker 'compose up -d db' 300
      $n = 0
      while (-not (Test-ConteneurSain 'smile-db') -and $n -lt 60) { Start-Sleep -Seconds 2; $n++ }
      if (-not (Test-ConteneurSain 'smile-db')) { Stop-Sauvegarde "La base de donnees ne demarre pas. $($r.Sortie)" }
    }
  }
}

if ($Mode -eq 'cloture') {
  if (-not (Test-Oui $config['SAUVEGARDE_APRES_CLOTURE'])) { exit 0 }
  # Derniere cloture de caisse (secondes depuis 1970) comparee a la derniere sauvegarde reussie.
  $r = Invoke-Docker 'exec smile-db psql -U supabase_admin -d postgres -tAc "select coalesce(extract(epoch from max(closed_at))::bigint, 0) from public.cash_days"' 60
  if ($r.Code -ne 0) { Write-Journal $journal "[cloture] lecture des clotures impossible : $($r.Sortie)"; exit 0 }
  [long]$cloture = 0
  if (-not [long]::TryParse($r.Sortie.Trim(), [ref]$cloture) -or $cloture -eq 0) { exit 0 }
  [long]$derniere = 0
  foreach ($s in (Get-Sauvegardes $DossierSauvegardes)) {
    [long]$e = 0
    if ([long]::TryParse([string]$s.Infos['epoch'], [ref]$e) -and $e -gt $derniere) { $derniere = $e }
  }
  if ($cloture -le $derniere) { exit 0 }
  Write-Journal $journal '[cloture] nouvelle cloture de caisse depuis la derniere sauvegarde.'
}

# ---- Une seule sauvegarde a la fois ----
$attente = 0
if ($interactif) { $attente = 600 }
$verrou = Lock-Sauvegarde $attente
if (-not $verrou) {
  if ($interactif) { Stop-Sauvegarde 'Une autre sauvegarde ou une restauration est en cours.' }
  exit 0
}

try {
  # ---- Place disponible ----
  try {
    $disque = New-Object System.IO.DriveInfo([System.IO.Path]::GetPathRoot($Kit))
    if ($disque.AvailableFreeSpace -lt 2GB) {
      Write-Info ('ATTENTION : il reste seulement {0} sur le disque {1}.' -f (Format-Taille $disque.AvailableFreeSpace), $disque.Name)
    }
  } catch { }

  # ---- Sauvegarde ----
  $nom = (Get-Date -Format 'yyyy-MM-dd_HH\hmm') + "-$Mode"
  $i = 2
  while ((Test-Path (Join-Path $DossierSauvegardes $nom)) -or (Test-Path (Join-Path $DossierSauvegardes "$nom.en-cours"))) {
    $nom = (Get-Date -Format 'yyyy-MM-dd_HH\hmm') + "-$Mode-$i"
    $i++
  }
  Write-Info "Sauvegarde $nom ..."
  $r = Invoke-Docker "compose --profile outils run --rm -T outils sauvegarder $nom" 1800
  if ($interactif -and $r.Sortie) {
    ($r.Sortie -split "`r?`n") | Where-Object { $_ -notmatch '^\s*Container ' } | ForEach-Object { Write-Host "  $_" }
  }
  if ($r.Code -ne 0 -or -not (Test-Path (Join-Path $DossierSauvegardes "$nom\infos.txt"))) {
    Write-Journal $journal $r.Sortie
    Stop-Sauvegarde 'la sauvegarde a echoue (details dans journaux\sauvegarde.log).'
  }
  $taille = (Get-ChildItem -Path (Join-Path $DossierSauvegardes $nom) -File | Measure-Object -Property Length -Sum).Sum
  Write-Journal $journal ("[$Mode] OK : $nom ({0})" -f (Format-Taille $taille))
  $message = "$nom ($(Format-Taille $taille))"

  # ---- Copie vers le 2e emplacement ----
  $copie = $config['COPIE_SAUVEGARDES']
  $statut = 'OK'
  if ($copie) {
    if (-not (Test-CopieAccessible $copie)) {
      $statut = 'COPIE ABSENTE'
      $message += " ; copie impossible : $copie inaccessible (cle USB debranchee ?)"
      Write-Info "ATTENTION : copie non faite, $copie est inaccessible (cle USB debranchee ?). La sauvegarde reste sur le POS."
    } else {
      try {
        if (-not (Test-Path $copie)) { New-Item -ItemType Directory -Path $copie -Force | Out-Null }
        $tmp = Join-Path $copie "$nom.en-cours"
        if (Test-Path $tmp) { Remove-Item -Path $tmp -Recurse -Force }
        Copy-Item -Path (Join-Path $DossierSauvegardes $nom) -Destination $tmp -Recurse -Force
        Rename-Item -Path $tmp -NewName $nom
        Write-Info "Copie faite dans $copie"
        $message += " ; copie dans $copie"
        $n = Remove-AnciennesSauvegardes $copie ([int]$config['JOURS_A_GARDER'])
        if ($n -gt 0) { Write-Info "$n ancienne(s) sauvegarde(s) effacee(s) dans $copie" }
      } catch {
        $statut = 'COPIE EN ERREUR'
        $message += " ; copie en erreur : $($_.Exception.Message)"
        Write-Info "ATTENTION : copie vers $copie en erreur : $($_.Exception.Message)"
      }
    }
  }

  # ---- Rotation ----
  $n = Remove-AnciennesSauvegardes $DossierSauvegardes ([int]$config['JOURS_A_GARDER'])
  if ($n -gt 0) { Write-Info "$n ancienne(s) sauvegarde(s) effacee(s) (plus de $($config['JOURS_A_GARDER']) jours)." }

  Write-Resultat $statut $message
  if ($interactif) { Write-Host ''; Write-Host "OK : sauvegarde terminee dans $(Join-Path $DossierSauvegardes $nom)" }
} finally {
  $verrou.ReleaseMutex()
  $verrou.Dispose()
}
exit 0
