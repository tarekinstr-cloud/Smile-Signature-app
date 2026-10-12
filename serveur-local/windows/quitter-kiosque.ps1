# Ferme le mode caisse plein ecran (QUITTER-KIOSQUE.bat). Le serveur continue de tourner pour les tablettes.
. "$PSScriptRoot\commun.ps1"
if (Close-Kiosque) { Write-Host 'Mode caisse ferme.' }
else { Write-Host 'Le mode caisse n''etait pas ouvert.' }
Write-Host 'Le serveur continue de fonctionner pour les tablettes.'
Write-Host 'Pour rouvrir la caisse : raccourci "Caisse Smile Signature" sur le Bureau (ou OUVRIR-CAISSE.bat).'
$config = Read-Config
if (Test-Oui $config['KIOSQUE_AU_DEMARRAGE']) {
  Write-Host 'Elle se rouvrira aussi au prochain demarrage du PC (KIOSQUE_AU_DEMARRAGE=non dans config.ini pour l''eviter).'
}
