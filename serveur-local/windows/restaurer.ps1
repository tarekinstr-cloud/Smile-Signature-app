# Restauration d'une sauvegarde (RESTAURER.bat) : liste, choix, confirmation, sauvegarde de securite de l'etat
# actuel, restauration de la base et des photos, redemarrage et verification.

. "$PSScriptRoot\commun.ps1"
$ErrorActionPreference = 'Continue'
$journal = 'sauvegarde.log'

Write-Host '================================================================'
Write-Host '  Smile Signature - Restaurer une sauvegarde'
Write-Host '================================================================'
Write-Host ''

$config = Read-Config
$locales = @(Get-Sauvegardes $DossierSauvegardes)
$copie = $config['COPIE_SAUVEGARDES']
$externes = @()
if ((Test-CopieAccessible $copie) -and (Test-Path -LiteralPath $copie)) {
  # Sauvegardes presentes seulement sur la cle USB / le disque D: (ex. nouveau PC apres une panne).
  $noms = $locales | ForEach-Object { $_.Nom }
  $externes = @(Get-Sauvegardes $copie | Where-Object { $noms -notcontains $_.Nom })
}
$toutes = @($locales + $externes | Sort-Object -Property Nom -Descending)
if ($toutes.Count -eq 0) {
  Write-Host "Aucune sauvegarde trouvee dans $DossierSauvegardes"
  if ($copie) { Write-Host "ni dans $copie" }
  Write-Host ''
  Write-Host 'Pour restaurer depuis une cle USB : copiez le dossier de la sauvegarde (ex. 2026-10-12_04h00-quotidienne)'
  Write-Host "dans $DossierSauvegardes puis relancez RESTAURER.bat."
  exit 1
}

$culture = [Globalization.CultureInfo]::GetCultureInfo('fr-FR')
Write-Host ' N   Date                     Type                  Taille     Derniere cloture   Emplacement'
Write-Host ' --  -----------------------  --------------------  ---------  -----------------  -----------'
for ($i = 0; $i -lt $toutes.Count; $i++) {
  $s = $toutes[$i]
  $ou = 'POS'
  if ($externes -contains $s) { $ou = $copie }
  $cloture = [string]$s.Infos['derniere_cloture']
  if (-not $cloture) { $cloture = '-' }
  Write-Host (' {0,-3} {1,-24} {2,-21} {3,-10} {4,-18} {5}' -f ($i + 1), $s.Date.ToString('ddd dd/MM/yyyy HH:mm', $culture), $s.Type, (Format-Taille $s.Taille), $cloture, $ou)
}
Write-Host ''
$choix = Read-Host 'Numero de la sauvegarde a restaurer (Entree = annuler)'
[int]$numero = 0
if (-not [int]::TryParse($choix, [ref]$numero) -or $numero -lt 1 -or $numero -gt $toutes.Count) {
  Write-Host 'Annule : rien n''a ete modifie.'
  exit 0
}
$choisie = $toutes[$numero - 1]

Write-Host ''
Write-Host '!!! ATTENTION !!!' -ForegroundColor Yellow
Write-Host ("Toutes les donnees actuelles (commandes, encaissements, carte, comptes, photos) vont etre remplacees")
Write-Host ("par celles du {0}." -f $choisie.Date.ToString('dddd dd MMMM yyyy a HH:mm', $culture))
Write-Host 'Tout ce qui a ete fait depuis cette date sera perdu (une sauvegarde de l''etat actuel est faite avant).'
Write-Host 'Les tablettes et telephones seront deconnectes pendant 1 a 2 minutes.'
Write-Host ''
$ok = Read-Host 'Tapez OUI pour confirmer'
if ($ok.Trim().ToUpper() -ne 'OUI') {
  Write-Host 'Annule : rien n''a ete modifie.'
  exit 0
}

# ---- Docker et base ----
if (-not (Test-DockerPret)) {
  Write-Host 'Demarrage de Docker Desktop...'
  if (-not (Wait-Docker 480)) { Write-Host 'ERREUR : Docker ne demarre pas.'; exit 1 }
}

# ---- Sauvegarde sur la cle USB : copiee d'abord sur le POS (le serveur lit serveur-local\sauvegardes) ----
if ($externes -contains $choisie) {
  Write-Host "Copie de la sauvegarde depuis $copie ..."
  try {
    Copy-Item -Path $choisie.Chemin -Destination (Join-Path $DossierSauvegardes "$($choisie.Nom).en-cours") -Recurse -Force -ErrorAction Stop
    Rename-Item -Path (Join-Path $DossierSauvegardes "$($choisie.Nom).en-cours") -NewName $choisie.Nom -ErrorAction Stop
  } catch {
    Write-Host "ERREUR : copie impossible : $($_.Exception.Message)"
    exit 1
  }
}

# ---- Sauvegarde de securite de l'etat actuel ----
Write-Host ''
Write-Host '[1/4] Sauvegarde de securite de l''etat actuel...'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $DossierWindows 'sauvegarde.ps1') -Mode avant-restauration
if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Host 'La sauvegarde de securite a echoue (la base actuelle est peut-etre abimee : c''est souvent la raison'
  Write-Host 'd''une restauration).'
  $ok = Read-Host 'Restaurer quand meme, SANS sauvegarde de l''etat actuel ? Tapez OUI pour continuer'
  if ($ok.Trim().ToUpper() -ne 'OUI') { Write-Host 'Annule : rien n''a ete modifie.'; exit 1 }
}

$verrou = Lock-Sauvegarde 600
if (-not $verrou) { Write-Host 'ERREUR : une sauvegarde est en cours. Reessayez dans quelques minutes.'; exit 1 }
Write-Journal $journal "[restauration] debut : $($choisie.Nom)"
Set-Location $Kit

try {
  Write-Host ''
  Write-Host '[2/4] Arret des services (la base reste allumee)...'
  & (Get-DockerExe) compose stop web auth rest realtime storage functions
  & (Get-DockerExe) compose up -d db
  $n = 0
  while (-not (Test-ConteneurSain 'smile-db') -and $n -lt 60) { Start-Sleep -Seconds 2; $n++ }

  Write-Host ''
  Write-Host '[3/4] Restauration...'
  & (Get-DockerExe) compose --profile outils run --rm outils restaurer $choisie.Nom
  $codeRestauration = $LASTEXITCODE

  Write-Host ''
  Write-Host '[4/4] Redemarrage du serveur et verification...'
  if ($codeRestauration -eq 0) {
    # Redemarrage de la base : ses taches de fond se reconnectent a la base restauree.
    & (Get-DockerExe) compose restart db
  }
  & (Get-DockerExe) compose up -d
  if ($codeRestauration -eq 0) {
    # Sauvegarde d'une version plus ancienne de l'application : migrations manquantes appliquees ici.
    & (Get-DockerExe) compose --profile outils run --rm outils migrer
    & (Get-DockerExe) compose --profile outils run --rm outils verifier
  }
} finally {
  $verrou.ReleaseMutex()
  $verrou.Dispose()
}

Write-Host ''
if ($codeRestauration -eq 0) {
  Write-Journal $journal "[restauration] OK : $($choisie.Nom)"
  Write-Host '================================================================'
  Write-Host ("  Restauration terminee : donnees du {0}." -f $choisie.Date.ToString('dd/MM/yyyy HH:mm'))
  Write-Host '  Rechargez l''application sur chaque appareil (reconnexion parfois demandee).'
  Write-Host '================================================================'
  exit 0
}
Write-Journal $journal "[restauration] ECHEC : $($choisie.Nom)"
Write-Host 'ERREUR : la restauration a echoue (voir les messages ci-dessus) ; le serveur a ete relance.'
Write-Host 'Si l''erreur est apparue avant "Remplacement de la base", les donnees actuelles n''ont pas ete'
Write-Host 'modifiees. Sinon, la sauvegarde "...-avant-restauration" faite juste avant contient l''etat precedent.'
Write-Host 'Envoyez une photo de cette fenetre.'
exit 1
