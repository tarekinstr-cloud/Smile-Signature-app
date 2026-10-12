# Mise en production du POS (5-ACTIVER-DEMARRAGE-AUTO.bat). Peut etre relance sans risque : tout est remplace
# a l'identique.
#   - config.ini (reglages du POS) et adresse IP du POS ;
#   - Docker Desktop demarre a l'ouverture de session, sans ouvrir sa fenetre ;
#   - raccourcis du Bureau (caisse en plein ecran, quitter la caisse) ;
#   - taches planifiees : demarrage du serveur + mode caisse a l'ouverture de session, sauvegarde quotidienne,
#     sauvegarde apres cloture ; PC jamais en veille ; pare-feu (demande les droits administrateur) ;
#   - premiere sauvegarde de controle.
param([switch]$PartieAdmin, [string]$Utilisateur = '', [string]$Resultat = '')

. "$PSScriptRoot\commun.ps1"
$ErrorActionPreference = 'Continue'

# ===============================================================================================================
# Partie administrateur (relancee par la partie principale avec les droits administrateur)
# ===============================================================================================================
if ($PartieAdmin) {
  $notes = New-Object System.Collections.Generic.List[string]
  try {
    $config = Read-Config
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
    # conhost --headless : PowerShell tourne sans aucune fenetre (rien ne passe devant le mode caisse).
    function New-Action([string]$Script, [string]$Arguments) {
      New-ScheduledTaskAction -Execute $conhost -WorkingDirectory $Kit `
        -Argument ("--headless `"$ps`" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"{0}`" {1}" -f (Join-Path $DossierWindows $Script), $Arguments)
    }
    $principal = New-ScheduledTaskPrincipal -UserId $Utilisateur -LogonType Interactive -RunLevel Limited

    # 1. Demarrage du serveur (+ mode caisse) a l'ouverture de session.
    $reglages = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 1)
    Register-ScheduledTask -TaskName $TacheDemarrage -Force -Principal $principal -Settings $reglages `
      -Action (New-Action 'demarrage.ps1' '-Auto') -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $Utilisateur) `
      -Description 'Smile Signature : attend Docker, lance le serveur (docker compose up -d), attend l''application et ouvre le mode caisse.' | Out-Null
    $notes.Add("  OK      Tache '$TacheDemarrage' (a chaque ouverture de session de $Utilisateur)")

    # 2. Sauvegarde quotidienne ; faite au demarrage suivant si le PC etait eteint a l'heure prevue.
    $heure = $config['HEURE_SAUVEGARDE']
    if ($heure -notmatch '^([01]?\d|2[0-3]):[0-5]\d$') {
      $notes.Add("  ATTENTION HEURE_SAUVEGARDE=$heure invalide dans config.ini : 04:00 utilise.")
      $heure = '04:00'
    }
    $a = [datetime]::ParseExact($heure.PadLeft(5, '0'), 'HH:mm', [Globalization.CultureInfo]::InvariantCulture)
    $reglages = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
      -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)
    Register-ScheduledTask -TaskName $TacheSauvegarde -Force -Principal $principal -Settings $reglages `
      -Action (New-Action 'sauvegarde.ps1' '-Mode quotidienne') -Trigger (New-ScheduledTaskTrigger -Daily -At $a) `
      -Description 'Smile Signature : sauvegarde de la base et des photos dans serveur-local\sauvegardes.' | Out-Null
    $notes.Add("  OK      Tache '$TacheSauvegarde' (chaque jour a $heure)")

    # 3. Sauvegarde apres cloture : verification toutes les 10 minutes (sauvegarde seulement s'il y a eu une
    #    cloture de caisse depuis la derniere sauvegarde).
    $declencheur = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 10)
    if (Test-Oui $config['SAUVEGARDE_APRES_CLOTURE']) {
      $reglages = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 1)
      $etat = 'toutes les 10 minutes'
    } else {
      $reglages = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 1) -Disable
      $etat = 'desactivee (SAUVEGARDE_APRES_CLOTURE=non)'
    }
    Register-ScheduledTask -TaskName $TacheCloture -Force -Principal $principal -Settings $reglages `
      -Action (New-Action 'sauvegarde.ps1' '-Mode cloture') -Trigger $declencheur `
      -Description 'Smile Signature : sauvegarde apres chaque cloture de caisse.' | Out-Null
    $notes.Add("  OK      Tache '$TacheCloture' ($etat)")
  } catch {
    $notes.Add("  ERREUR  Taches planifiees : $($_.Exception.Message)")
  }

  # PC jamais en veille sur secteur : les tablettes perdraient le serveur.
  & powercfg.exe /change standby-timeout-ac 0 2>&1 | Out-Null
  $codeVeille = $LASTEXITCODE
  & powercfg.exe /change hibernate-timeout-ac 0 2>&1 | Out-Null
  if ($codeVeille -eq 0 -and $LASTEXITCODE -eq 0) { $notes.Add('  OK      Mise en veille du PC desactivee (sur secteur)') }
  else { $notes.Add('  ATTENTION Mise en veille non modifiee : reglez "Mise en veille : Jamais" dans Parametres > Systeme > Alimentation.') }

  # Pare-feu : tablettes du Wi-Fi (reseaux prives) et telephone du gerant par Tailscale (adresses 100.64.0.0/10).
  function Invoke-Netsh([string]$Arguments) {
    (Start-Process -FilePath 'netsh.exe' -ArgumentList $Arguments -Wait -PassThru -WindowStyle Hidden).ExitCode
  }
  $port = Get-PortHttp
  Invoke-Netsh 'advfirewall firewall delete rule name="Smile Signature (serveur local)"' | Out-Null
  $c1 = Invoke-Netsh "advfirewall firewall add rule name=`"Smile Signature (serveur local)`" dir=in action=allow protocol=TCP localport=$port profile=private,domain"
  Invoke-Netsh 'advfirewall firewall delete rule name="Smile Signature (Tailscale)"' | Out-Null
  $c2 = Invoke-Netsh "advfirewall firewall add rule name=`"Smile Signature (Tailscale)`" dir=in action=allow protocol=TCP localport=$port remoteip=100.64.0.0/10 profile=any"
  if ($c1 -eq 0 -and $c2 -eq 0) { $notes.Add("  OK      Pare-feu : port $port ouvert pour le Wi-Fi du restaurant (reseau prive) et Tailscale") }
  else { $notes.Add('  ATTENTION Pare-feu non modifie : lancez OUVRIR-PARE-FEU.bat.') }

  try { [System.IO.File]::WriteAllLines($Resultat, [string[]]$notes) } catch { }
  exit 0
}

# ===============================================================================================================
# Partie principale
# ===============================================================================================================
Write-Host '================================================================'
Write-Host '  Smile Signature - Mise en production du POS'
Write-Host '  (demarrage automatique, mode caisse, sauvegardes)'
Write-Host '================================================================'
Write-Host ''

if (-not (Test-Path (Join-Path $Kit '.env'))) {
  Write-Host 'ERREUR : le serveur n''est pas installe. Lancez d''abord 1-INSTALLER.bat (LISEZMOI.md, etape 3).'
  exit 1
}

# Fichiers telecharges d'internet (ZIP) : on retire le blocage de Windows pour que les taches s'executent.
Get-ChildItem -Path $Kit -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue

# ---- 1. Reglages et adresse IP ----
Write-Host '[1/5] Reglages (config.ini) et adresse IP du POS'
$nouveauConfig = -not (Test-Path $FichierConfig)
$config = Read-Config
if ($nouveauConfig) { Write-Host "        config.ini cree : $FichierConfig" }
$ipActuelle = $null
try {
  # Carte reseau qui a une passerelle (le routeur) : c'est l'adresse que les tablettes utilisent.
  $ipActuelle = Get-NetIPConfiguration -ErrorAction Stop |
    Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } |
    ForEach-Object { $_.IPv4Address.IPAddress } |
    Where-Object { (Get-AdressesLocales) -contains $_ } | Select-Object -First 1
} catch { }
if (-not $ipActuelle) { $ipActuelle = Get-AdressesLocales | Select-Object -First 1 }
$ipConfig = $config['IP_POS']
if (-not $ipActuelle) {
  Write-Host '        ATTENTION : le POS n''a pas d''adresse sur le reseau (cable ou Wi-Fi debranche ?).'
} elseif (-not $ipConfig) {
  Set-ConfigValeur 'IP_POS' $ipActuelle
  Write-Host "        Adresse du POS enregistree : $ipActuelle  (tablettes : http://$ipActuelle$(Get-SuffixePort))"
} elseif ((Get-AdressesLocales) -contains $ipConfig) {
  Write-Host "        Adresse du POS : $ipConfig (inchangee)"
} else {
  Write-Host "        ATTENTION : l'adresse du POS a change : $ipConfig (enregistree) -> $ipActuelle (actuelle)."
  Write-Host '        Les tablettes qui utilisent l''ancienne adresse ne trouvent plus le serveur.'
  Write-Host '        Faites la reservation DHCP dans le routeur (LISEZMOI.md, section Reseau).'
  $rep = Read-Host "        Enregistrer la nouvelle adresse $ipActuelle ? (O/N)"
  if ((Test-Oui $rep)) { Set-ConfigValeur 'IP_POS' $ipActuelle; Write-Host '        Nouvelle adresse enregistree.' }
}
$config = Read-Config

# ---- 2. Docker Desktop au demarrage de Windows ----
Write-Host ''
Write-Host '[2/5] Docker Desktop : demarrage automatique a l''ouverture de session'
function Set-ReglageJson([string]$Fichier, [string]$Cle, [string]$Valeur) {
  $texte = [System.IO.File]::ReadAllText($Fichier)
  $motif = '"' + [regex]::Escape($Cle) + '"\s*:\s*(true|false)'
  if ($texte -match $motif) {
    $nouveau = [regex]::Replace($texte, $motif, ('"{0}": {1}' -f $Cle, $Valeur))
  } else {
    $i = $texte.IndexOf('{')
    if ($i -lt 0) { return $false }
    $separateur = ','
    if ($texte.Substring($i + 1).Trim().StartsWith('}')) { $separateur = '' }
    $nouveau = $texte.Substring(0, $i + 1) + ('"{0}": {1}{2}' -f $Cle, $Valeur, $separateur) + $texte.Substring($i + 1)
  }
  if ($nouveau -ne $texte) {
    if (-not (Test-Path "$Fichier.avant-smile")) { Copy-Item -Path $Fichier -Destination "$Fichier.avant-smile" }
    [System.IO.File]::WriteAllText($Fichier, $nouveau, (New-Object System.Text.UTF8Encoding($false)))
  }
  return $true
}
$fait = $false
# settings-store.json (Docker Desktop recent) ou settings.json (versions plus anciennes).
foreach ($r in @(@{ F = 'settings-store.json'; A = 'AutoStart'; O = 'OpenUIOnStartupDisabled' },
                 @{ F = 'settings.json'; A = 'autoStart'; O = 'openUIOnStartupDisabled' })) {
  $f = Join-Path $env:APPDATA "Docker\$($r.F)"
  if (Test-Path $f) {
    try {
      if ((Set-ReglageJson $f $r.A 'true') -and (Set-ReglageJson $f $r.O 'true')) { $fait = $true }
    } catch { Write-Host "        ATTENTION : $f non modifie : $($_.Exception.Message)" }
  }
}
if ($fait) {
  Write-Host '        OK : "Start Docker Desktop when you sign in" active, fenetre de Docker non ouverte au demarrage.'
  Write-Host '        (A verifier une fois : Docker Desktop > Settings > General, case cochee.)'
} else {
  Write-Host '        ATTENTION : reglages de Docker Desktop introuvables. Cochez a la main : Docker Desktop > Settings'
  Write-Host '        > General > "Start Docker Desktop when you sign in to your computer" > Apply.'
}
Write-Host '        La tache de demarrage du serveur lance de toute facon Docker Desktop s''il ne l''est pas.'

# ---- 3. Raccourcis du Bureau ----
Write-Host ''
Write-Host '[3/5] Raccourcis sur le Bureau'
try {
  $shell = New-Object -ComObject WScript.Shell
  $bureau = [Environment]::GetFolderPath('Desktop')
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $lnk = $shell.CreateShortcut((Join-Path $bureau 'Caisse Smile Signature.lnk'))
  $lnk.TargetPath = Join-Path $env:SystemRoot 'System32\conhost.exe'
  $lnk.Arguments = "--headless `"$ps`" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $DossierWindows 'demarrage.ps1')`" -Caisse"
  $lnk.WorkingDirectory = $Kit
  $lnk.IconLocation = (Join-Path $DossierWindows 'caisse.ico') + ',0'
  $lnk.Description = 'Ouvre la caisse Smile Signature en plein ecran (lance le serveur si besoin)'
  $lnk.Save()
  $lnk = $shell.CreateShortcut((Join-Path $bureau 'Quitter la caisse.lnk'))
  $lnk.TargetPath = Join-Path $Kit 'QUITTER-KIOSQUE.bat'
  $lnk.WorkingDirectory = $Kit
  $lnk.IconLocation = (Join-Path $env:SystemRoot 'System32\shell32.dll') + ',27'
  $lnk.Description = 'Ferme le mode caisse plein ecran (le serveur continue de tourner)'
  $lnk.Save()
  Write-Host '        OK : "Caisse Smile Signature" et "Quitter la caisse"'
} catch {
  Write-Host "        ERREUR : raccourcis non crees : $($_.Exception.Message)"
}

# ---- 4. Taches planifiees, veille, pare-feu (droits administrateur) ----
Write-Host ''
Write-Host '[4/5] Taches planifiees, mise en veille, pare-feu'
Write-Host '        Windows demande l''autorisation administrateur : repondez Oui.'
$utilisateurActuel = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$fichierResultat = Join-Path $env:TEMP ("smile-activer-{0}.txt" -f $PID)
Remove-Item -Path $fichierResultat -ErrorAction SilentlyContinue
$arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -PartieAdmin -Utilisateur "{1}" -Resultat "{2}"' -f $PSCommandPath, $utilisateurActuel, $fichierResultat
try {
  Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $arguments -WindowStyle Hidden -Wait
} catch {
  Write-Host '        ERREUR : autorisation administrateur refusee. Relancez 5-ACTIVER-DEMARRAGE-AUTO.bat et repondez Oui.'
}
if (Test-Path $fichierResultat) {
  Get-Content -Path $fichierResultat | ForEach-Object { Write-Host "      $_" }
  Remove-Item -Path $fichierResultat -ErrorAction SilentlyContinue
}
foreach ($t in @($TacheDemarrage, $TacheSauvegarde, $TacheCloture)) {
  if (-not (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue)) { Write-Host "        ERREUR : tache '$t' absente." }
}

# ---- 5. Serveur et premiere sauvegarde de controle ----
Write-Host ''
Write-Host '[5/5] Premiere sauvegarde de controle'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $DossierWindows 'sauvegarde.ps1') -Mode manuelle
if ($config['COPIE_SAUVEGARDES']) { Write-Host "        Copie des sauvegardes vers : $($config['COPIE_SAUVEGARDES'])" }
else { Write-Host '        Conseil : indiquez une cle USB ou un disque D: dans config.ini (COPIE_SAUVEGARDES).' }

Write-Host ''
Write-Host '================================================================'
Write-Host '  Mise en production terminee.'
Write-Host ''
if (Test-Oui $config['KIOSQUE_AU_DEMARRAGE']) {
  Write-Host '  A chaque ouverture de session : Docker, le serveur, puis la caisse en plein ecran.'
} else {
  Write-Host '  A chaque ouverture de session : Docker puis le serveur (mode caisse au demarrage desactive).'
}
Write-Host '  Pour que la session s''ouvre toute seule (POS sans clavier) : LISEZMOI.md, etape 5.'
Write-Host '  Pour tester : redemarrez le PC.'
Write-Host '================================================================'
exit 0
