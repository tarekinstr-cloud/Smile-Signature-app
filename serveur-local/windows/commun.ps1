# Fonctions partagees par les scripts Windows du serveur local Smile Signature.
# Charge par les autres scripts : . "$PSScriptRoot\commun.ps1"
# Windows PowerShell 5.1 (installe d'origine sur Windows 10 et 11) : rien a installer.
# Textes sans accents : la console Windows les affiche mal selon la page de code.

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$Kit = Split-Path -Parent $PSScriptRoot                     # dossier serveur-local
$DossierWindows = $PSScriptRoot                             # dossier serveur-local\windows
$DossierSauvegardes = Join-Path $Kit 'sauvegardes'          # vu par le conteneur outils comme /kit/sauvegardes
$DossierJournaux = Join-Path $Kit 'journaux'
$FichierConfig = Join-Path $Kit 'config.ini'
$FichierEtat = Join-Path $DossierWindows 'attente\etat.js'
$PageAttente = Join-Path $DossierWindows 'attente\attente.html'
$ProfilKiosque = Join-Path $env:LOCALAPPDATA 'SmileSignature\EdgeKiosque'

$TacheDemarrage = 'Smile Signature - Demarrage'
$TacheSauvegarde = 'Smile Signature - Sauvegarde quotidienne'
$TacheCloture = 'Smile Signature - Sauvegarde apres cloture'

# ---------------------------------------------------------------------------------------------------------------
# Journaux (serveur-local\journaux\*.log), limites a 1 Mo chacun.
# ---------------------------------------------------------------------------------------------------------------
function Write-Journal([string]$Fichier, [string]$Message) {
  try {
    if (-not (Test-Path $DossierJournaux)) { New-Item -ItemType Directory -Path $DossierJournaux | Out-Null }
    $chemin = Join-Path $DossierJournaux $Fichier
    if ((Test-Path $chemin) -and ((Get-Item $chemin).Length -gt 1MB)) {
      $fin = Get-Content -Path $chemin -Tail 2000 -Encoding UTF8
      Set-Content -Path $chemin -Value $fin -Encoding UTF8
    }
    $ligne = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Add-Content -Path $chemin -Value $ligne -Encoding UTF8
  } catch { }
}

# ---------------------------------------------------------------------------------------------------------------
# Reglages : .env (secrets, port) et config.ini (reglages du POS, jamais remplace par une mise a jour).
# ---------------------------------------------------------------------------------------------------------------
function Read-CleValeur([string]$Chemin) {
  $valeurs = @{}
  if (Test-Path $Chemin) {
    foreach ($ligne in (Get-Content -Path $Chemin -Encoding UTF8)) {
      $l = $ligne.Trim()
      if ($l -eq '' -or $l.StartsWith('#') -or $l.StartsWith(';') -or $l.StartsWith('[')) { continue }
      $i = $l.IndexOf('=')
      if ($i -lt 1) { continue }
      $valeurs[$l.Substring(0, $i).Trim()] = $l.Substring($i + 1).Trim()
    }
  }
  return $valeurs
}

function Read-Env { return Read-CleValeur (Join-Path $Kit '.env') }

function Initialize-Config {
  if (-not (Test-Path $FichierConfig)) {
    Copy-Item -Path (Join-Path $Kit 'config.exemple.ini') -Destination $FichierConfig
  }
}

function Read-Config {
  Initialize-Config
  $c = Read-CleValeur $FichierConfig
  $defauts = @{
    IP_POS = ''; KIOSQUE_AU_DEMARRAGE = 'oui'; HEURE_SAUVEGARDE = '04:00'; SAUVEGARDE_APRES_CLOTURE = 'oui'
    JOURS_A_GARDER = '30'; COPIE_SAUVEGARDES = ''
  }
  foreach ($k in $defauts.Keys) { if (-not $c.ContainsKey($k)) { $c[$k] = $defauts[$k] } }
  return $c
}

function Test-Oui([string]$Valeur) { return @('oui', 'o', 'yes', 'y', '1', 'true', 'vrai') -contains $Valeur.Trim().ToLower() }

# Remplace (ou ajoute) une ligne CLE=valeur dans config.ini, sans toucher aux commentaires.
function Set-ConfigValeur([string]$Cle, [string]$Valeur) {
  Initialize-Config
  $lignes = @(Get-Content -Path $FichierConfig -Encoding UTF8)
  $trouve = $false
  for ($i = 0; $i -lt $lignes.Count; $i++) {
    if ($lignes[$i] -match ('^\s*' + [regex]::Escape($Cle) + '\s*=')) { $lignes[$i] = "$Cle=$Valeur"; $trouve = $true }
  }
  if (-not $trouve) { $lignes += "$Cle=$Valeur" }
  [System.IO.File]::WriteAllLines($FichierConfig, [string[]]$lignes, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-PortHttp {
  $p = (Read-Env)['HTTP_PORT']
  if ([string]::IsNullOrWhiteSpace($p)) { return '80' }
  return $p
}

function Get-SuffixePort {
  $p = Get-PortHttp
  if ($p -eq '80') { return '' }
  return ":$p"
}

function Get-UrlLocale { return 'http://localhost{0}/' -f (Get-SuffixePort) }

# ---------------------------------------------------------------------------------------------------------------
# Docker Desktop
# ---------------------------------------------------------------------------------------------------------------
# Docker Desktop.exe : installation pour tous (Program Files) ou pour l'utilisateur seul (AppData).
function Find-DockerDesktop {
  $candidats = New-Object System.Collections.Generic.List[string]
  $cmd = Get-Command docker.exe -ErrorAction SilentlyContinue
  if ($cmd) {
    # ...\Docker\resources\bin\docker.exe -> ...\Docker\Docker Desktop.exe
    $candidats.Add((Join-Path (Split-Path (Split-Path (Split-Path $cmd.Source))) 'Docker Desktop.exe'))
  }
  $candidats.Add((Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'))
  $candidats.Add((Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe'))
  $candidats.Add((Join-Path $env:LOCALAPPDATA 'Programs\Docker\Docker\Docker Desktop.exe'))
  $candidats.Add((Join-Path $env:LOCALAPPDATA 'Docker\Docker Desktop.exe'))
  foreach ($cle in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Docker Desktop',
                     'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Docker Desktop')) {
    try {
      $dossier = (Get-ItemProperty -Path $cle -ErrorAction Stop).InstallLocation
      if ($dossier) { $candidats.Add((Join-Path $dossier 'Docker Desktop.exe')) }
    } catch { }
  }
  foreach ($c in $candidats) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}

function Get-DockerExe {
  $cmd = Get-Command docker.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $dd = Find-DockerDesktop
  if ($dd) {
    $exe = Join-Path (Split-Path $dd) 'resources\bin\docker.exe'
    if (Test-Path $exe) { return $exe }
  }
  return 'docker.exe'
}

# Lance docker sans fenetre et renvoie le code de sortie et le texte affiche. Delai maximum : $Secondes.
function Invoke-Docker([string]$Arguments, [int]$Secondes = 600) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = Get-DockerExe
  $psi.Arguments = $Arguments
  $psi.WorkingDirectory = $Kit
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
  try { $p = [System.Diagnostics.Process]::Start($psi) }
  catch { return [pscustomobject]@{ Code = -1; Sortie = "docker introuvable : $($_.Exception.Message)" } }
  $sortie = $p.StandardOutput.ReadToEndAsync()
  $erreurs = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit($Secondes * 1000)) {
    try { $p.Kill() } catch { }
    return [pscustomobject]@{ Code = -1; Sortie = "docker $Arguments : delai depasse ($Secondes s)" }
  }
  $p.WaitForExit()
  return [pscustomobject]@{ Code = $p.ExitCode; Sortie = ($sortie.Result + $erreurs.Result).Trim() }
}

function Test-DockerPret { return ((Invoke-Docker 'version --format {{.Server.Version}}' 20).Code -eq 0) }

function Test-DockerDesktopLance { return [bool](Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue) }

function Start-DockerDesktop {
  if (Test-DockerDesktopLance) { return $true }
  $dd = Find-DockerDesktop
  if (-not $dd) { return $false }
  Start-Process -FilePath $dd | Out-Null
  return $true
}

# Attend que Docker Engine reponde (en lancant Docker Desktop s'il est ferme). $Pendant est appele a chaque tour
# avec le nombre de secondes ecoulees (pour afficher la progression).
function Wait-Docker([int]$Secondes = 480, [scriptblock]$Pendant = $null) {
  $debut = Get-Date
  $lancements = 0
  while ($true) {
    if (Test-DockerPret) { return $true }
    $ecoule = [int]((Get-Date) - $debut).TotalSeconds
    if ($ecoule -ge $Secondes) { return $false }
    # Lance Docker Desktop s'il est ferme ; une seconde fois apres 2 minutes s'il s'est referme entre-temps.
    if (-not (Test-DockerDesktopLance) -and ($lancements -eq 0 -or ($lancements -eq 1 -and $ecoule -gt 120))) {
      if (-not (Start-DockerDesktop)) { return $false }
      $lancements++
    }
    if ($Pendant) { & $Pendant $ecoule }
    Start-Sleep -Seconds 3
  }
}

function Test-ConteneurSain([string]$Nom) {
  $r = Invoke-Docker "inspect -f {{.State.Health.Status}} $Nom" 20
  return ($r.Code -eq 0 -and $r.Sortie -eq 'healthy')
}

# ---------------------------------------------------------------------------------------------------------------
# Serveur web et API (vus depuis Windows, par la meme adresse que l'application)
# ---------------------------------------------------------------------------------------------------------------
function Test-Url([string]$Url, [hashtable]$Entetes = $null, [string]$Contient = '') {
  $reponse = $null
  try {
    $req = [System.Net.HttpWebRequest]::Create($Url)
    $req.Proxy = $null
    $req.Timeout = 5000
    $req.ReadWriteTimeout = 5000
    $req.KeepAlive = $false
    if ($Entetes) { foreach ($k in $Entetes.Keys) { $req.Headers[$k] = $Entetes[$k] } }
    $reponse = $req.GetResponse()
    if ([int]$reponse.StatusCode -ne 200) { return $false }
    if ($Contient) {
      $lecteur = New-Object System.IO.StreamReader($reponse.GetResponseStream())
      return ($lecteur.ReadToEnd().Contains($Contient))
    }
    return $true
  } catch {
    return $false
  } finally {
    if ($reponse) { $reponse.Close() }
  }
}

# Renvoie '' si l'application et toute l'API repondent, sinon le nom de ce qui ne repond pas encore.
function Get-ServeurManquant {
  $base = 'http://localhost{0}' -f (Get-SuffixePort)
  $cle = (Read-Env)['ANON_KEY']
  $jeton = @{ 'apikey' = $cle; 'Authorization' = "Bearer $cle" }
  if (-not (Test-Url "$base/healthz")) { return 'serveur web' }
  if (-not (Test-Url "$base/" $null 'id="root"')) { return 'application' }
  if (-not (Test-Url "$base/auth/v1/health")) { return 'authentification' }
  if (-not (Test-Url "$base/rest/v1/" $jeton)) { return 'API REST' }
  if (-not (Test-Url "$base/storage/v1/status")) { return 'stockage' }
  if (-not (Test-Url "$base/realtime/v1/api/tenants/realtime-dev/health" $jeton)) { return 'temps reel' }
  return ''
}

# ---------------------------------------------------------------------------------------------------------------
# Adresses du POS
# ---------------------------------------------------------------------------------------------------------------
function Test-AdresseTailscale([string]$Ip) {
  # Tailscale distribue des adresses 100.64.0.0 a 100.127.255.255.
  $o = $Ip.Split('.')
  return ($o.Count -eq 4 -and $o[0] -eq '100' -and [int]$o[1] -ge 64 -and [int]$o[1] -le 127)
}

function Get-AdressesLocales {
  try {
    return @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object {
        $_.InterfaceAlias -notmatch 'vEthernet|Loopback|WSL|Docker|Tailscale' -and
        $_.IPAddress -notlike '169.254*' -and $_.IPAddress -ne '127.0.0.1' -and
        -not (Test-AdresseTailscale $_.IPAddress)
      } | ForEach-Object { $_.IPAddress })
  } catch { return @() }
}

function Get-AdresseTailscale {
  $exe = $null
  $cmd = Get-Command tailscale.exe -ErrorAction SilentlyContinue
  if ($cmd) { $exe = $cmd.Source }
  elseif (Test-Path (Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe')) { $exe = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe' }
  if ($exe) {
    try {
      $ip = (& $exe ip -4 2>$null | Select-Object -First 1)
      if ($ip -and (Test-AdresseTailscale $ip.Trim())) { return $ip.Trim() }
    } catch { }
  }
  try {
    $a = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
      Where-Object { $_.InterfaceAlias -match 'Tailscale' -and (Test-AdresseTailscale $_.IPAddress) } | Select-Object -First 1
    if ($a) { return $a.IPAddress }
  } catch { }
  return $null
}

function Show-Adresses {
  $suffixe = Get-SuffixePort
  Write-Host ''
  Write-Host (' Sur ce PC (le POS) :        http://localhost{0}' -f $suffixe)
  Write-Host ' Sur les tablettes/telephones (Wi-Fi du restaurant) :'
  $ips = Get-AdressesLocales
  if ($ips.Count -eq 0) { Write-Host '                             (aucune adresse : le POS n''est pas connecte au reseau)' }
  foreach ($ip in $ips) { Write-Host ('                             http://{0}{1}' -f $ip, $suffixe) }
  $ts = Get-AdresseTailscale
  if ($ts) { Write-Host (' A distance (Tailscale) :    http://{0}{1}' -f $ts, $suffixe) }
  Write-Host ''
}

# ---------------------------------------------------------------------------------------------------------------
# Mode caisse (Microsoft Edge en plein ecran, profil a part)
# ---------------------------------------------------------------------------------------------------------------
function Find-Edge {
  foreach ($cle in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe',
                     'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe')) {
    try {
      $p = (Get-ItemProperty -Path $cle -ErrorAction Stop).'(default)'
      if ($p -and (Test-Path $p)) { return $p }
    } catch { }
  }
  foreach ($p in @((Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
                   (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'))) {
    if (Test-Path $p) { return $p }
  }
  return $null
}

function Get-ProcessusKiosque {
  try {
    return @(Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" -ErrorAction Stop |
      Where-Object { $_.CommandLine -and $_.CommandLine.Contains('SmileSignature\EdgeKiosque') })
  } catch { return @() }
}

function Close-Kiosque {
  $liste = Get-ProcessusKiosque
  if ($liste.Count -eq 0) { return $false }
  # D'abord une fermeture normale de la fenetre (Edge enregistre son etat), puis on termine ce qui reste.
  foreach ($p in $liste) {
    if (-not $p.CommandLine.Contains('--type=')) {
      try { (Get-Process -Id $p.ProcessId -ErrorAction Stop).CloseMainWindow() | Out-Null } catch { }
    }
  }
  for ($i = 0; $i -lt 10 -and (Get-ProcessusKiosque).Count -gt 0; $i++) { Start-Sleep -Milliseconds 500 }
  foreach ($p in (Get-ProcessusKiosque)) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch { } }
  return $true
}

function Open-Kiosque([string]$Url) {
  $edge = Find-Edge
  if (-not $edge) { throw 'Microsoft Edge est introuvable sur ce PC.' }
  if (-not (Test-Path $ProfilKiosque)) { New-Item -ItemType Directory -Path $ProfilKiosque -Force | Out-Null }
  # Apres une coupure de courant, Edge proposerait de "restaurer les pages" : on lui dit que tout s'est bien
  # termine.
  $prefs = Join-Path $ProfilKiosque 'Default\Preferences'
  if (Test-Path $prefs) {
    try {
      $texte = [System.IO.File]::ReadAllText($prefs)
      $corrige = $texte.Replace('"exit_type":"Crashed"', '"exit_type":"Normal"').Replace('"exited_cleanly":false', '"exited_cleanly":true')
      if ($corrige -ne $texte) { [System.IO.File]::WriteAllText($prefs, $corrige, (New-Object System.Text.UTF8Encoding($false))) }
    } catch { }
  }
  $arguments = @(
    "--kiosk `"$Url`"",
    '--edge-kiosk-type=fullscreen',
    "--user-data-dir=`"$ProfilKiosque`"",
    '--no-first-run',
    '--no-default-browser-check',
    # Ecran tactile : pas de zoom ni de retour arriere par glissement involontaires.
    '--disable-pinch',
    '--overscroll-history-navigation=0'
  )
  Start-Process -FilePath $edge -ArgumentList ($arguments -join ' ') | Out-Null
}

# Etat lu par la page d'attente (windows\attente\etat.js) : etape en cours et adresse de l'application.
$script:DebutEtat = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
function Write-Etat([string]$Etape, [string]$Detail = '') {
  try {
    $etat = [ordered]@{
      etape = $Etape; detail = $Detail; url = (Get-UrlLocale)
      depuis = $script:DebutEtat; maj = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    $js = 'window.ETAT = ' + ($etat | ConvertTo-Json -Compress) + ';'
    [System.IO.File]::WriteAllText($FichierEtat, $js, (New-Object System.Text.UTF8Encoding($false)))
  } catch { }
}

function Get-UrlAttente {
  $u = (New-Object System.Uri($PageAttente)).AbsoluteUri
  return '{0}?url={1}' -f $u, [System.Uri]::EscapeDataString((Get-UrlLocale))
}

# ---------------------------------------------------------------------------------------------------------------
# Sauvegardes
# ---------------------------------------------------------------------------------------------------------------
$MotifSauvegarde = '^(\d{4}-\d{2}-\d{2}_\d{2}h\d{2})(-.+)?$'

# Sauvegardes completes (dossiers avec infos.txt), de la plus recente a la plus ancienne.
function Get-Sauvegardes([string]$Dossier) {
  if (-not $Dossier -or -not (Test-Path $Dossier)) { return @() }
  $liste = foreach ($d in (Get-ChildItem -Path $Dossier -Directory -ErrorAction SilentlyContinue)) {
    if ($d.Name -notmatch $MotifSauvegarde) { continue }
    $infos = Join-Path $d.FullName 'infos.txt'
    if (-not (Test-Path $infos)) { continue }
    $date = [datetime]::ParseExact($Matches[1], 'yyyy-MM-dd_HH\hmm', [Globalization.CultureInfo]::InvariantCulture)
    $taille = (Get-ChildItem -Path $d.FullName -File | Measure-Object -Property Length -Sum).Sum
    $type = 'quotidienne'
    if ($Matches[2]) { $type = $Matches[2].TrimStart('-') }
    [pscustomobject]@{ Nom = $d.Name; Chemin = $d.FullName; Date = $date; Type = $type; Taille = [long]$taille; Infos = (Read-CleValeur $infos) }
  }
  return @($liste | Sort-Object -Property Nom -Descending)
}

function Format-Taille([long]$Octets) {
  if ($Octets -ge 1GB) { return ('{0:N1} Go' -f ($Octets / 1GB)) }
  if ($Octets -ge 1MB) { return ('{0:N1} Mo' -f ($Octets / 1MB)) }
  return ('{0:N0} Ko' -f [math]::Ceiling($Octets / 1KB))
}

# Efface les sauvegardes de plus de $Jours jours, en gardant toujours les 3 plus recentes (PC reste eteint
# longtemps, horloge dereglee...). Efface aussi les sauvegardes interrompues (.en-cours) de plus d'un jour.
function Remove-AnciennesSauvegardes([string]$Dossier, [int]$Jours) {
  $effacees = 0
  if ($Jours -lt 1) { $Jours = 1 }
  $limite = (Get-Date).AddDays(-$Jours)
  $liste = Get-Sauvegardes $Dossier
  for ($i = 3; $i -lt $liste.Count; $i++) {
    if ($liste[$i].Date -lt $limite) {
      try { Remove-Item -Path $liste[$i].Chemin -Recurse -Force; $effacees++ } catch { }
    }
  }
  foreach ($d in (Get-ChildItem -Path $Dossier -Directory -Filter '*.en-cours' -ErrorAction SilentlyContinue)) {
    if ($d.LastWriteTime -lt (Get-Date).AddDays(-1)) { try { Remove-Item -Path $d.FullName -Recurse -Force } catch { } }
  }
  return $effacees
}

# Le 2e emplacement des sauvegardes est-il branche ? (lecteur de la cle USB / du disque present)
function Test-CopieAccessible([string]$Chemin) {
  if (-not $Chemin) { return $false }
  try { $racine = [System.IO.Path]::GetPathRoot($Chemin) } catch { return $false }
  return ([bool]$racine -and (Test-Path -LiteralPath $racine))
}

# Verrou partage par la sauvegarde et la restauration (une seule a la fois).
function Lock-Sauvegarde([int]$Secondes) {
  $m = New-Object System.Threading.Mutex($false, 'Local\SmileSignatureSauvegarde')
  try { $ok = $m.WaitOne($Secondes * 1000) } catch [System.Threading.AbandonedMutexException] { $ok = $true }
  if ($ok) { return $m }
  $m.Dispose()
  return $null
}
