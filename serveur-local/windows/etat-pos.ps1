# Etat du POS, affiche par VERIFIER.bat : adresses (et changement d'IP), demarrage automatique, mode caisse,
# sauvegardes (derniere, copie), place sur le disque.

. "$PSScriptRoot\commun.ps1"
$ErrorActionPreference = 'Continue'
$alertes = 0
function Write-Ligne([string]$Statut, [string]$Texte) {
  $couleur = 'Gray'
  if ($Statut -eq 'OK') { $couleur = 'Green' }
  if ($Statut -eq 'ALERTE' -or $Statut -eq 'ERREUR') { $couleur = 'Red'; $script:alertes++ }
  if ($Statut -eq 'NOTE') { $couleur = 'Yellow' }
  Write-Host ('  {0,-8}' -f $Statut) -ForegroundColor $couleur -NoNewline
  Write-Host $Texte
}

$config = Read-Config

# ---- Adresses ----
Write-Host ''
Write-Host 'Adresses :'
Show-Adresses
$ips = @(Get-AdressesLocales)
$ipConfig = $config['IP_POS']
if (-not $ipConfig) {
  Write-Ligne 'NOTE' 'Adresse du POS non enregistree dans config.ini (IP_POS) : lancez 5-ACTIVER-DEMARRAGE-AUTO.bat.'
} elseif ($ips.Count -eq 0) {
  Write-Ligne 'ALERTE' "Le POS n'a pas d'adresse sur le reseau (cable ou Wi-Fi debranche ?). Adresse attendue : $ipConfig"
} elseif ($ips -contains $ipConfig) {
  Write-Ligne 'OK' "Adresse IP du POS : $ipConfig (identique a config.ini)"
} else {
  Write-Ligne 'ALERTE' ("L'adresse IP du POS a change : {0} dans config.ini, {1} maintenant." -f $ipConfig, ($ips -join ', '))
  Write-Host '          Les tablettes ne trouvent plus le serveur a l''ancienne adresse. Reservez l''adresse dans le routeur'
  Write-Host '          (LISEZMOI.md, section Reseau), ou relancez 5-ACTIVER-DEMARRAGE-AUTO.bat pour noter la nouvelle.'
}
$ts = Get-AdresseTailscale
if ($ts) { Write-Ligne 'OK' "Tailscale connecte : acces a distance par http://$ts$(Get-SuffixePort)" }
else { Write-Ligne 'NOTE' 'Tailscale absent ou deconnecte (facultatif : acces a distance, LISEZMOI.md).' }

# ---- Demarrage automatique ----
Write-Host ''
Write-Host 'Demarrage automatique :'
function Show-Tache([string]$Nom, [string]$Libelle, [bool]$Obligatoire) {
  $t = Get-ScheduledTask -TaskName $Nom -ErrorAction SilentlyContinue
  if (-not $t) {
    if ($Obligatoire) { Write-Ligne 'ALERTE' "$Libelle : tache absente (lancez 5-ACTIVER-DEMARRAGE-AUTO.bat)." }
    else { Write-Ligne 'NOTE' "$Libelle : tache absente." }
    return
  }
  $info = Get-ScheduledTaskInfo -TaskName $Nom -ErrorAction SilentlyContinue
  $etat = [string]$t.State
  $texte = $Libelle + ' : ' + @{ 'Ready' = 'active'; 'Running' = 'en cours'; 'Disabled' = 'DESACTIVEE'; 'Queued' = 'en attente' }[$etat]
  if ($info -and $info.LastRunTime -and $info.LastRunTime.Year -gt 2000) {
    $texte += ', derniere execution ' + $info.LastRunTime.ToString('dd/MM HH:mm')
    # 0 = reussie ; 267009 = encore en cours ; 267011 = jamais lancee ; 2147750687 = deja en cours (ignoree).
    if (@(0, 267009, 267011, 2147750687) -notcontains $info.LastTaskResult) {
      $texte += (' (ECHEC, code {0} : voir journaux\)' -f $info.LastTaskResult)
      Write-Ligne 'ALERTE' $texte
      return
    }
  }
  if ($etat -eq 'Disabled') { Write-Ligne 'NOTE' $texte } else { Write-Ligne 'OK' $texte }
}
Show-Tache $TacheDemarrage 'Serveur a l''ouverture de session' $true
if (Test-Oui $config['KIOSQUE_AU_DEMARRAGE']) { Write-Ligne 'OK' 'Mode caisse plein ecran a l''ouverture de session : oui' }
else { Write-Ligne 'NOTE' 'Mode caisse plein ecran a l''ouverture de session : non (KIOSQUE_AU_DEMARRAGE dans config.ini)' }
$journalDemarrage = Join-Path $DossierJournaux 'demarrage.log'
if (Test-Path $journalDemarrage) {
  $derniere = Get-Content -Path $journalDemarrage -Tail 1 -Encoding UTF8
  if ($derniere -match 'ERREUR') { Write-Ligne 'ALERTE' "Dernier demarrage : $derniere" }
  else { Write-Ligne 'OK' "Dernier demarrage : $derniere" }
}

# ---- Sauvegardes ----
Write-Host ''
Write-Host 'Sauvegardes :'
Show-Tache $TacheSauvegarde ("Sauvegarde quotidienne ({0})" -f $config['HEURE_SAUVEGARDE']) $true
Show-Tache $TacheCloture 'Sauvegarde apres cloture' $false
$liste = @(Get-Sauvegardes $DossierSauvegardes)
if ($liste.Count -eq 0) {
  Write-Ligne 'ALERTE' 'Aucune sauvegarde : lancez SAUVEGARDER-MAINTENANT.bat.'
} else {
  $s = $liste[0]
  $age = (Get-Date) - $s.Date
  $texte = 'Derniere sauvegarde : {0} ({1}), {2}' -f $s.Date.ToString('dd/MM/yyyy HH:mm'), $s.Type, (Format-Taille $s.Taille)
  if ($age.TotalHours -gt 36) { Write-Ligne 'ALERTE' ("$texte - il y a {0} jours !" -f [int][math]::Floor($age.TotalDays)) }
  else { Write-Ligne 'OK' $texte }
  $total = ($liste | Measure-Object -Property Taille -Sum).Sum
  Write-Ligne 'OK' ('{0} sauvegarde(s) gardee(s) ({1} jours), {2} au total dans {3}' -f $liste.Count, $config['JOURS_A_GARDER'], (Format-Taille $total), $DossierSauvegardes)
}
$resultat = Read-CleValeur (Join-Path $DossierJournaux 'derniere-sauvegarde.txt')
if ($resultat['statut'] -and $resultat['statut'] -ne 'OK') {
  Write-Ligne 'ALERTE' ("Derniere tentative ({0}, {1}) : {2} - {3}" -f $resultat['date'], $resultat['mode'], $resultat['statut'], $resultat['message'])
}
$copie = $config['COPIE_SAUVEGARDES']
if (-not $copie) {
  Write-Ligne 'NOTE' 'Pas de copie sur un 2e emplacement (COPIE_SAUVEGARDES dans config.ini : cle USB, disque D:).'
} elseif (-not (Test-CopieAccessible $copie)) {
  Write-Ligne 'ALERTE' "Copie des sauvegardes : $copie inaccessible (cle USB debranchee ?)."
} else {
  $c = @(Get-Sauvegardes $copie)
  if ($c.Count -gt 0) { Write-Ligne 'OK' ('Copie dans {0} : {1} sauvegarde(s), derniere le {2}' -f $copie, $c.Count, $c[0].Date.ToString('dd/MM/yyyy HH:mm')) }
  else { Write-Ligne 'NOTE' "Copie dans $copie : aucune sauvegarde pour l'instant." }
}

# ---- Disque ----
try {
  $disque = New-Object System.IO.DriveInfo([System.IO.Path]::GetPathRoot($Kit))
  $texte = 'Place libre sur le disque {0} : {1}' -f $disque.Name, (Format-Taille $disque.AvailableFreeSpace)
  if ($disque.AvailableFreeSpace -lt 5GB) { Write-Ligne 'ALERTE' "$texte (moins de 5 Go)" } else { Write-Ligne 'OK' $texte }
} catch { }

Write-Host ''
if ($alertes -gt 0) { Write-Host "POS : $alertes alerte(s) ci-dessus." -ForegroundColor Red }
else { Write-Host 'POS : tout est en ordre.' -ForegroundColor Green }
