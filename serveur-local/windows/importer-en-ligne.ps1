# Import de la configuration du Supabase en ligne vers le serveur local (IMPORTER-DEPUIS-EN-LIGNE.bat).
#   1. demande l'adresse du projet en ligne et la cle service_role (gardees en memoire seulement) ;
#   2. lit la configuration en ligne (lecture seule) et affiche ce qui sera importe ;
#   3. apres confirmation : sauvegarde locale, chargement de la configuration, copie des photos ;
#   4. resume : nombre de lignes par table.
# Relancable : les identifiants (UUID) sont conserves, rien n'est cree en double.

. "$PSScriptRoot\commun.ps1"
$ErrorActionPreference = 'Continue'
$journal = 'import.log'
$dossierImport = 'import-en-ligne'                      # serveur-local\import-en-ligne (efface a la fin)
$cheminImport = Join-Path $Kit $dossierImport

Write-Host '================================================================'
Write-Host '  Smile Signature - Importer la configuration depuis le Supabase en ligne'
Write-Host '================================================================'
Write-Host ''
Write-Host 'Copie sur ce serveur local : salles, tables et plan, categories, articles, prix, options,'
Write-Host 'imprimantes et liaisons, zones de livraison, parametres (caisse, ticket, modes de paiement,'
Write-Host 'categories de depenses, permissions des roles), employes et permissions, codes PIN,'
Write-Host 'articles de stock (sans les quantites), fiches techniques, fonds d''ecran et photos des articles.'
Write-Host ''
Write-Host 'Jamais copies : commandes, tickets, paiements, caisses et journees, mouvements de stock,'
Write-Host 'fournisseurs et factures, reservations, clients et credits, depenses.'
Write-Host 'Le compte administrateur local n''est pas modifie.'
Write-Host ''

# ---- Serveur local demarre ----
if (-not (Test-DockerPret)) {
  Write-Host 'Demarrage de Docker Desktop...'
  if (-not (Wait-Docker 480)) { Write-Host 'ERREUR : Docker ne demarre pas.'; exit 1 }
}
if ((Get-ServeurManquant) -ne '') {
  Write-Host 'Demarrage du serveur local...'
  & (Get-DockerExe) compose up -d
  $n = 0
  while ((Get-ServeurManquant) -ne '' -and $n -lt 100) { Start-Sleep -Seconds 3; $n++ }
  $manquant = Get-ServeurManquant
  if ($manquant -ne '') { Write-Host "ERREUR : le serveur local ne repond pas ($manquant). Lancez VERIFIER.bat."; exit 1 }
}

# ---- Adresse et cle du projet en ligne (jamais ecrites dans un fichier) ----
Write-Host 'Dans Supabase (https://supabase.com/dashboard) > votre projet > Project Settings > API :'
Write-Host '  - Project URL                (ex. https://abcdefghijkl.supabase.co)'
Write-Host '  - cle "service_role" secret  (bouton Reveal, puis copier)'
Write-Host ''
$url = (Read-Host 'Adresse du projet (Project URL)').Trim().TrimEnd('/')
if ($url -notmatch '^https?://[^/\s]+') { Write-Host "ERREUR : adresse invalide : $url"; exit 1 }
$secret = Read-Host 'Cle service_role (collez-la avec un clic droit ; rien ne s''affiche)' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try { $cle = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim() }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
if (-not $cle) { Write-Host 'ERREUR : cle vide.'; exit 1 }

# Transmises au conteneur par l'environnement de cette fenetre uniquement.
$env:EN_LIGNE_URL = $url
$env:EN_LIGNE_CLE = $cle
Set-Location $Kit
$code = 1
try {
  Write-Host ''
  & (Get-DockerExe) compose --profile outils run --rm -T importer node /kit/outils/importer-en-ligne.mjs telecharger $dossierImport
  if ($LASTEXITCODE -ne 0) { Write-Host ''; Write-Host 'Rien n''a ete modifie sur le serveur local.'; exit 1 }

  Write-Host ''
  Write-Host 'Les lignes ci-dessus vont etre copiees sur ce serveur local (ajoutees ou mises a jour).'
  Write-Host 'Les elements de configuration presents ici mais absents en ligne sont supprimes, sauf s''ils sont'
  Write-Host 'utilises par des donnees locales (commandes, stock...). Une sauvegarde est faite avant.'
  $ok = Read-Host 'Tapez OUI pour importer'
  if ($ok.Trim().ToUpper() -ne 'OUI') { Write-Host 'Annule : rien n''a ete modifie.'; exit 0 }

  Write-Host ''
  Write-Host '[1/3] Sauvegarde locale avant import...'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $DossierWindows 'sauvegarde.ps1') -Mode avant-import
  if ($LASTEXITCODE -ne 0) { Write-Host 'ERREUR : sauvegarde impossible : import annule, rien n''a ete modifie.'; exit 1 }

  Write-Host ''
  Write-Host '[2/3] Configuration...'
  & (Get-DockerExe) compose --profile outils run --rm -T outils importer $dossierImport
  if ($LASTEXITCODE -ne 0) {
    Write-Journal $journal "ECHEC chargement de la configuration depuis $url"
    Write-Host ''
    Write-Host 'ERREUR : la configuration n''a pas ete importee (rien n''a ete modifie dans la base).'
    Write-Host 'Envoyez une photo de cette fenetre.'
    exit 1
  }

  Write-Host ''
  Write-Host '[3/3] Photos et fonds de salle...'
  & (Get-DockerExe) compose --profile outils run --rm -T importer node /kit/outils/importer-en-ligne.mjs photos
  $photosOk = ($LASTEXITCODE -eq 0)
  Write-Journal $journal ("Import depuis $url : configuration OK, photos " + $(if ($photosOk) { 'OK' } else { 'INCOMPLETES' }))

  Write-Host ''
  Write-Host '================================================================'
  if ($photosOk) { Write-Host '  Import termine.' } else { Write-Host '  Import termine, SAUF certaines photos : relancez l''import pour les recuperer.' }
  Write-Host '  Rechargez l''application sur chaque appareil.'
  Write-Host '  Employes : connexion par leur code PIN (si la connexion par PIN est activee), ou donnez-leur'
  Write-Host '  un mot de passe dans Fichier > Utilisateurs (les mots de passe en ligne ne sont pas copiables).'
  Write-Host '  Le stock part de zero : faites un inventaire pour saisir les quantites reelles.'
  Write-Host '================================================================'
  if ($photosOk) { $code = 0 }
} finally {
  Remove-Item Env:EN_LIGNE_CLE -ErrorAction SilentlyContinue
  Remove-Item Env:EN_LIGNE_URL -ErrorAction SilentlyContinue
  $cle = $null
  # Fichiers lus en ligne (employes, codes PIN chiffres...) : jamais laisses sur le disque.
  if (Test-Path $cheminImport) { Remove-Item -Path $cheminImport -Recurse -Force -ErrorAction SilentlyContinue }
}
exit $code
