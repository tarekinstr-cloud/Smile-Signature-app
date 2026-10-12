# Serveur local Smile Signature (sans internet)

Ce dossier transforme **un PC Windows** (le POS du restaurant, ou votre PC portable pour essayer) en serveur pour
toute l'application. Les tablettes et les téléphones des serveurs s'y connectent par le **Wi-Fi du restaurant**.
Une fois installé, **tout fonctionne sans internet**.

```
                       Routeur / box internet (192.168.1.1)
                ┌──────────────┼───────────────────────┐
           câble RJ45      câble RJ45              Wi-Fi « restaurant »
                │              │                        │
     POS Windows (caisse     Point d'accès Wi-Fi    Tablettes, téléphones
     + serveur, IP réservée)  en mode AP             http://192.168.1.9
     http://localhost
```

> **Important :** les données du serveur local et celles du Supabase en ligne sont **séparées** (elles ne se
> synchronisent pas). Pour l'essai sur votre PC portable, vous partez d'une base vide.

---

## Installation, dans l'ordre

| Étape | Quoi | Fichier |
|---|---|---|
| 1 | Installer Docker Desktop | (site de Docker) |
| 2 | Copier ce dossier sur le PC | ZIP du projet |
| 3 | Installer le serveur et créer le compte administrateur | `1-INSTALLER.bat` |
| 4 | Réseau : pare-feu, IP du POS réservée, Wi-Fi, tablettes | `OUVRIR-PARE-FEU.bat` |
| 5 | Mise en production : démarrage automatique, caisse plein écran, sauvegardes | `5-ACTIVER-DEMARRAGE-AUTO.bat` |
| (6) | Facultatif : accès à distance pour le gérant (Tailscale) | — |

Ensuite, `VERIFIER.bat` contrôle tout : services, base, démarrage automatique, sauvegardes, adresse IP.

---

## Ce qu'il faut

| | Minimum | Recommandé |
|---|---|---|
| Windows | 10 (version 22H2) ou 11, 64 bits | Windows 11 |
| Mémoire (RAM) | 8 Go | 8 Go ou plus |
| Disque libre | 20 Go | SSD avec 40 Go libres |
| Internet | seulement pour l'installation et les mises à jour | |
| Réseau | POS branché **par câble (RJ45)** au routeur | |

**Mémoire mesurée** (serveur au repos après un service d'essai : commandes, encaissements, photos, deux appareils
connectés) :

| Service | Rôle | Mémoire |
|---|---|---|
| db | base de données Postgres | 80 à 180 Mo |
| realtime | mises à jour en direct entre appareils | 185 à 200 Mo |
| storage | photos des plats et fonds de salle | 110 Mo |
| functions | connexion par code PIN | 45 à 90 Mo |
| rest | API des tables | 25 à 30 Mo |
| auth | comptes et connexions | 10 Mo |
| web | application + entrée de l'API | 5 Mo |
| **Total des services** | | **environ 0,5 à 0,65 Go** |
| Studio + meta (facultatif, arrêté par défaut) | tableau de bord Supabase | + 320 Mo |

Il faut ajouter Docker Desktop lui-même (environ 0,5 à 1 Go), Windows (2 à 3 Go) et le navigateur de la caisse
(0,5 à 1 Go). **4 Go de RAM ne suffisent pas** : prévoyez **8 Go**.

---

## Étape 1 — Installer Docker Desktop (une seule fois)

1. Dans le BIOS du PC, la **virtualisation** doit être activée (Intel VT-x / AMD-V, souvent activée d'origine).
   Si Docker affiche plus tard « Virtualization support not detected », c'est ce réglage.
2. Téléchargez **Docker Desktop for Windows** sur <https://www.docker.com/products/docker-desktop/>
   (bouton *Download for Windows – AMD64*).
3. Lancez l'installateur. Laissez cochée l'option **Use WSL 2 instead of Hyper-V**. Cliquez *OK*, puis
   **redémarrez le PC** quand il le demande. (L'installation « pour tous les utilisateurs » ou « pour moi seul »
   fonctionne dans les deux cas.)
4. Au premier lancement de Docker Desktop : acceptez les conditions, puis choisissez **Continue without signing in**
   (aucun compte n'est nécessaire). Si une fenêtre demande de mettre à jour WSL, acceptez.
5. (Conseillé) Limiter la mémoire de Docker : ouvrez le Bloc-notes, collez les 3 lignes ci-dessous, puis
   *Fichier > Enregistrer sous* : nom **`.wslconfig`** (avec le point), type *Tous les fichiers*, dans votre dossier
   utilisateur (`C:\Users\VotreNom\`). Redémarrez ensuite le PC.

   ```
   [wsl2]
   memory=3GB
   swap=2GB
   ```

Le démarrage de Docker avec Windows est réglé à l'étape 5.

## Étape 2 — Copier le dossier sur le PC

1. Sur la page GitHub du projet : bouton vert **Code** > **Download ZIP**.
2. Faites un clic droit sur le fichier téléchargé > **Extraire tout…** vers **`C:\SmileSignature`**
   (un chemin simple, sans accent ni espace).
3. Ouvrez `C:\SmileSignature\…\serveur-local` : c'est ce dossier qui contient les fichiers `.bat` ci-dessous.

## Étape 3 — Installer le serveur (une seule fois, internet nécessaire)

1. Vérifiez que Docker Desktop est lancé (icône de baleine en bas à droite, près de l'horloge).
2. Double-cliquez **`1-INSTALLER.bat`**. Si Windows affiche « Windows a protégé votre ordinateur » :
   *Informations complémentaires* > *Exécuter quand même*.
3. Patientez : le premier lancement télécharge environ **2 Go** (5 Go une fois installés sur le disque), soit 10 à
   30 minutes selon la connexion.
4. Le script demande le **compte administrateur** de l'application : un nom d'utilisateur (ex. `admin`) et un mot
   de passe (tapé deux fois ; rien ne s'affiche pendant la frappe, c'est normal).
   **Mot de passe sans accent** : lettres `a-z A-Z`, chiffres et signes du clavier (`! ? @ # - _ .`), par exemple
   `Cafe2026!`. Une lettre accentuée (é, à, ç…) tapée dans la fenêtre noire de Windows n'arrive pas avec le même
   codage que dans le navigateur : le script la refuse et redemande.
5. À la fin, il affiche **« RESULTAT : tout fonctionne »** et les adresses de l'application.

Si une étape échoue (coupure internet…), relancez simplement `1-INSTALLER.bat` : ce qui est déjà fait n'est pas
refait, et les mots de passe internes ne sont jamais régénérés.

Sur le POS, ouvrez <http://localhost> et connectez-vous avec le compte administrateur, puis créez les salles, la
carte et les comptes des employés comme d'habitude.

## Étape 4 — Réseau et tablettes

### Le POS sur le réseau

- **Branchez le POS au routeur par un câble RJ45** (Ethernet) : c'est le serveur de tout le restaurant, le Wi-Fi
  du PC est moins stable (coupures, mise en veille de la carte Wi-Fi).
- Le réseau du POS doit être en **réseau privé** : *Paramètres Windows* > *Réseau et Internet* > *Ethernet* (ou
  *Wi-Fi*) > nom du réseau > **Type de profil réseau : Privé**.
- Double-cliquez **`OUVRIR-PARE-FEU.bat`** (Windows demande l'autorisation administrateur : *Oui*). Il autorise
  les tablettes à joindre le serveur (et Tailscale, voir plus bas). `5-ACTIVER-DEMARRAGE-AUTO.bat` le refait aussi.
- Si Windows a affiché une fenêtre « Autoriser Docker Desktop Backend… », cochez **Réseaux privés** et
  *Autoriser*.

### Réserver l'adresse IP du POS dans le routeur (réservation DHCP)

Les tablettes retiennent l'adresse du POS (ex. `192.168.1.9`). Sans réservation, le routeur peut lui en donner une
autre après une coupure de courant : les tablettes ne trouvent plus le serveur. On la **réserve** une fois pour
toutes :

1. Sur le POS, ouvrez **Invite de commandes** (touche Windows, tapez `cmd`, Entrée), puis tapez `ipconfig /all`.
   Dans le bloc de la carte **Ethernet** (celle du câble), notez :
   - **Adresse physique** = adresse MAC (ex. `A4-5E-60-12-34-56`) ;
   - **Adresse IPv4** (ex. `192.168.1.9`) ;
   - **Passerelle par défaut** (ex. `192.168.1.1`) : c'est l'adresse du routeur.
2. Dans un navigateur, ouvrez l'adresse du routeur (ex. `http://192.168.1.1`) et connectez-vous (identifiant et
   mot de passe souvent écrits sous le routeur).
3. Cherchez le menu **DHCP** puis **Réservation d'adresse** / **IP statique** / **Address Reservation** /
   **DHCP Binding** (le nom dépend du modèle : TP-Link, Huawei, ZTE, D-Link…).
4. Ajoutez une réservation : l'**adresse MAC** du POS et l'**adresse IPv4** notée. Enregistrez.
5. Redémarrez le POS : `VERIFIER.bat` doit afficher la même adresse, sans alerte « l'adresse IP du POS a changé ».

Si le routeur n'a pas ce menu, on peut fixer l'adresse dans Windows (*Paramètres* > *Réseau et Internet* > carte
réseau > *Attribution d'adresse IP* > *Modifier* > *Manuel*), avec une adresse hors de la plage DHCP du routeur :
demandez à votre installateur réseau.

> Si vous changez de carte réseau (passage du Wi-Fi au câble), l'adresse MAC change : refaites la réservation
> avec la nouvelle.

### Les points d'accès Wi-Fi : en mode AP, pas en mode routeur

Si la salle est couverte par des **points d'accès Wi-Fi** ou des répéteurs en plus du routeur, ils doivent être en
**mode Point d'accès** (*Access Point*, *AP*, *Bridge*, *Pont*) et **pas en mode Routeur** :

- en mode routeur, le point d'accès crée son propre petit réseau (ex. `192.168.0.x`) : les tablettes qui s'y
  connectent **ne voient plus le POS** (`192.168.1.9`) ;
- en mode AP, toutes les tablettes sont sur le même réseau que le POS, quel que soit le point d'accès.

Réglage dans la page d'administration du point d'accès (*Mode de fonctionnement* > *Point d'accès*), le point
d'accès étant relié au routeur **par câble**. Le DHCP doit rester actif **seulement sur le routeur**.

### Les tablettes : Wi-Fi du restaurant, pas le Wi-Fi clients

- Les tablettes et téléphones des serveurs se connectent au **Wi-Fi du restaurant** (le réseau privé, celui du
  POS).
- **Pas au Wi-Fi clients / invités** : ce réseau est volontairement isolé du POS (c'est bien pour la sécurité),
  l'application n'y fonctionne pas.
- **En données mobiles (4G/5G), l'application n'est pas accessible** : le serveur est dans le restaurant, il n'est
  pas sur internet. Seule exception : un téléphone avec Tailscale (voir *Accès à distance*).

### Installer l'application sur les tablettes

1. Sur la tablette (Wi-Fi du restaurant), ouvrez **Chrome** et tapez **`http://` suivi de l'adresse IP du POS**,
   par exemple `http://192.168.1.9`. L'adresse est affichée par `VERIFIER.bat` et à la fin de `1-INSTALLER.bat`.
2. Menu **⋮** de Chrome (en haut à droite) > **Ajouter à l'écran d'accueil** > *Ajouter*.
3. L'icône Smile Signature apparaît sur l'écran d'accueil : elle ouvre l'application directement.

(iPad / iPhone : Safari > bouton *Partager* > *Sur l'écran d'accueil*.)

Le réseau local étant en `http` (pas `https`), le navigateur n'installe pas le mode hors ligne sur les tablettes :
elles ont simplement besoin du Wi-Fi du restaurant, pas d'internet.

## Étape 5 — Mise en production du POS

### `5-ACTIVER-DEMARRAGE-AUTO.bat`

Double-cliquez **`5-ACTIVER-DEMARRAGE-AUTO.bat`** (Windows demande une fois l'autorisation administrateur :
*Oui*). Il fait tout ceci, et peut être relancé sans risque (après une modification de `config.ini`, une mise à
jour…) :

1. crée **`config.ini`** (réglages du POS, voir plus bas) et y note l'**adresse IP actuelle du POS** ;
2. active dans Docker Desktop **Start Docker Desktop when you sign in** (sans ouvrir sa fenêtre) ;
3. crée sur le Bureau le raccourci **Caisse Smile Signature** (icône de l'application) et **Quitter la caisse** ;
4. crée les **tâches planifiées** :
   - *Smile Signature - Demarrage* : à chaque ouverture de session, attend que Docker soit prêt, lance les services
     (`docker compose up -d`), attend que l'application et l'API répondent (8 minutes au plus pour Docker,
     5 minutes pour le serveur, puis message d'erreur clair), et ouvre la **caisse en plein écran** ;
   - *Smile Signature - Sauvegarde quotidienne* : chaque jour à 4 h (ou dès le démarrage suivant si le PC était
     éteint) ;
   - *Smile Signature - Sauvegarde apres cloture* : sauvegarde après chaque clôture de caisse ;
5. désactive la **mise en veille** du PC sur secteur (les tablettes perdraient le serveur) et ouvre le pare-feu ;
6. fait une **première sauvegarde** de contrôle.

Rien ne s'affiche en fenêtre noire au démarrage : le suivi est dans `serveur-local\journaux\demarrage.log`.

### Ouverture de session automatique (POS sans clavier)

Le démarrage automatique a lieu **à l'ouverture de session**. Pour que le POS arrive tout seul jusqu'à la caisse
après une coupure de courant, la session doit s'ouvrir sans mot de passe :

1. **Windows 11** : *Paramètres* > *Comptes* > *Options de connexion* : **désactivez** « Pour une sécurité
   renforcée, autoriser uniquement la connexion Windows Hello pour les comptes Microsoft sur cet appareil »
   (sinon la case de l'étape 3 n'apparaît pas).
2. Touche **Windows + R**, tapez **`netplwiz`**, Entrée.
3. Sélectionnez le compte du POS, **décochez** « Les utilisateurs doivent entrer un nom d'utilisateur et un mot de
   passe pour utiliser cet ordinateur », puis *Appliquer*.
4. Tapez deux fois le **mot de passe du compte** (pour un compte Microsoft : le mot de passe du compte Microsoft,
   pas le code PIN), puis *OK*.
5. *Paramètres* > *Comptes* > *Options de connexion* > « Si vous vous êtes absenté, quand Windows doit-il vous
   demander de vous reconnecter ? » : **Jamais**.
6. Redémarrez le PC : la session s'ouvre seule, puis la page « Démarrage du serveur… », puis la caisse.

Si la case de l'étape 3 reste absente, l'outil gratuit **Autologon** de Microsoft (Sysinternals) fait la même chose.
Le PC s'ouvrant sans mot de passe, gardez-le dans un endroit non accessible aux clients : l'application garde ses
propres comptes et codes PIN.

### Conseillé pour un POS

- **Redémarrage après coupure de courant** : dans le BIOS du PC, réglez *Restore on AC Power Loss* /
  *AC Power Recovery* sur **Power On** : le PC se rallume seul au retour du courant.
- **Windows Update** : *Paramètres* > *Windows Update* > *Options avancées* > **Heures d'activité** (ex. 8 h à 2 h)
  pour qu'il ne redémarre jamais pendant le service.
- Gardez un **petit clavier USB** à portée pour l'administrateur.

### `config.ini` (réglages du POS)

Ouvrez `serveur-local\config.ini` avec le Bloc-notes, modifiez, enregistrez, puis relancez
`5-ACTIVER-DEMARRAGE-AUTO.bat`. Ce fichier n'est jamais remplacé par une mise à jour.

| Réglage | Par défaut | Rôle |
|---|---|---|
| `IP_POS` | (notée par l'étape 5) | Adresse attendue du POS ; `VERIFIER.bat` alerte si elle change. |
| `KIOSQUE_AU_DEMARRAGE` | `oui` | Caisse plein écran à l'ouverture de session. |
| `HEURE_SAUVEGARDE` | `04:00` | Heure de la sauvegarde quotidienne. |
| `SAUVEGARDE_APRES_CLOTURE` | `oui` | Sauvegarde après chaque clôture de caisse. |
| `JOURS_A_GARDER` | `30` | Les sauvegardes plus anciennes sont effacées (les 3 dernières jamais). |
| `COPIE_SAUVEGARDES` | (vide) | Copie de chaque sauvegarde sur une clé USB ou un disque D: (ex. `E:\SauvegardesSmile`). |

---

## Mode caisse (plein écran)

- La caisse s'ouvre dans **Microsoft Edge en plein écran** (mode kiosque), sans barre d'adresse ni onglets.
- **Ouvrir** : raccourci **Caisse Smile Signature** sur le Bureau, ou `OUVRIR-CAISSE.bat`. S'il est déjà ouvert, il
  est fermé puis rouvert (pratique si l'écran est figé).
- Si le serveur n'est pas encore prêt, une page **« Démarrage du serveur… »** s'affiche (étape en cours, temps
  écoulé) et ouvre l'application toute seule dès qu'il répond. En cas d'échec, elle indique quoi faire.
- **Quitter** (administrateur) : avec un clavier, **Alt+F4** ; ou touche Windows / **Alt+Tab** pour atteindre le
  Bureau, puis **Quitter la caisse** (ou `QUITTER-KIOSQUE.bat`). Le serveur continue de tourner pour les tablettes.
- La caisse utilise son **propre profil Edge** : connectez-vous une fois dans la caisse, la session est gardée.
  Votre Edge habituel n'est pas touché.
- Pour ne plus ouvrir la caisse au démarrage : `KIOSQUE_AU_DEMARRAGE=non` dans `config.ini`.

## Sauvegardes

**Ce qui est sauvegardé** : toute la base (commandes, encaissements, clôtures, carte, comptes…) en `pg_dump`
compressé, et les fichiers du stockage (**photos des plats** `item-photos`, **fonds de salle**
`floor-backgrounds`). Chaque sauvegarde est relue avant d'être validée.

**Où** : `serveur-local\sauvegardes\`, un dossier par sauvegarde, par exemple :

```
sauvegardes\2026-10-12_04h00-quotidienne\   base.dump  stockage.tar.gz  infos.txt
sauvegardes\2026-10-12_23h41-cloture\
```

**Quand** : chaque jour à 4 h (tâche planifiée ; si le PC était éteint, dès le démarrage suivant), **après chaque
clôture de caisse** (vérifié toutes les 10 minutes), et à la demande avec **`SAUVEGARDER-MAINTENANT.bat`**.
Les sauvegardes de plus de 30 jours sont effacées.

**Copie sur un 2e emplacement** (fortement conseillé : si le disque du POS lâche, les sauvegardes du POS sont
perdues avec lui) : mettez `COPIE_SAUVEGARDES=E:\SauvegardesSmile` (clé USB laissée branchée) ou
`D:\SauvegardesSmile` (2e disque) dans `config.ini`. Si la clé est débranchée, la sauvegarde est quand même faite
sur le POS et `VERIFIER.bat` le signale. La même règle des 30 jours s'applique à la copie.

**Restaurer** : double-cliquez **`RESTAURER.bat`**. Il liste les sauvegardes (date, type, taille, dernière clôture
— y compris celles de la clé USB), demande le numéro, puis de taper `OUI`. Il fait d'abord une sauvegarde de
l'état actuel (`…-avant-restauration`), restaure la base et les photos, redémarre le serveur et vérifie tout.
La sauvegarde est d'abord chargée à part : si elle est illisible, la base actuelle n'est pas touchée.
Après une restauration, rechargez l'application sur chaque appareil.

## Accès à distance (Tailscale, facultatif)

Pour que le **gérant** consulte l'application depuis son téléphone, **hors du restaurant** (4G, maison), sans rien
ouvrir sur internet :

1. **Sur le POS** : téléchargez et installez **Tailscale** (<https://tailscale.com/download/windows>), puis
   connectez-vous (compte Google, Microsoft ou Apple du gérant). Dans le menu de Tailscale (icône près de
   l'horloge) > *Preferences*, cochez **Run unattended** (Tailscale reste connecté même avant l'ouverture de
   session).
2. **Sur le téléphone du gérant** : installez l'application **Tailscale** (Play Store / App Store) et connectez-vous
   **avec le même compte**.
3. Sur le téléphone, Tailscale activé, ouvrez **`http://100.x.y.z`** : l'adresse Tailscale du POS, affichée par
   `VERIFIER.bat` (ligne *A distance (Tailscale)*) et dans l'application Tailscale (liste des appareils).
4. Dans la console Tailscale (<https://login.tailscale.com/admin/machines>), menu **…** du POS >
   **Disable key expiry** : sinon le POS se déconnecte de Tailscale au bout de 6 mois.

Le pare-feu autorise les adresses Tailscale (`100.64.0.0/10`) : c'est fait par `OUVRIR-PARE-FEU.bat` et
`5-ACTIVER-DEMARRAGE-AUTO.bat`.

> **Ne JAMAIS ouvrir de port sur le routeur** (pas de « redirection de port » / *port forwarding* / *DMZ*) pour
> accéder au POS depuis internet. Tailscale crée un tunnel chiffré entre les seuls appareils de votre compte :
> rien n'est exposé sur internet. Téléphone perdu : supprimez-le de la console Tailscale.

---

## Au quotidien

| Fichier | Quand |
|---|---|
| Raccourci **Caisse Smile Signature** / `OUVRIR-CAISSE.bat` | Ouvre (ou rouvre) la caisse en plein écran ; démarre le serveur si besoin. |
| Raccourci **Quitter la caisse** / `QUITTER-KIOSQUE.bat` | Administrateur : ferme la caisse plein écran (le serveur continue). |
| `VERIFIER.bat` | Contrôle complet : services, tables, mémoire, adresses (et changement d'IP), Tailscale, démarrage automatique, dernière sauvegarde. |
| `SAUVEGARDER-MAINTENANT.bat` | Sauvegarde immédiate (avant une manipulation, une mise à jour…). |
| `RESTAURER.bat` | Revenir à une sauvegarde. |
| `DEMARRER.bat` | Lance Docker et le serveur, puis ouvre l'application dans le navigateur normal. |
| `ARRETER.bat` | **Arrêt propre** du serveur (la base enregistre tout puis s'arrête). |
| `CREER-ADMIN.bat` | Mot de passe administrateur oublié : le remet, ou crée un autre administrateur. |
| `OUVRIR-PARE-FEU.bat` | Si les tablettes ne joignent pas le POS. |
| `5-ACTIVER-DEMARRAGE-AUTO.bat` | Après une modification de `config.ini` ou une mise à jour. |
| `METTRE-A-JOUR.bat` | Après avoir copié une nouvelle version du projet (voir plus bas). |
| `STUDIO.bat` / `STUDIO-ARRETER.bat` | Facultatif : tableau de bord Supabase sur <http://localhost:3000> (POS uniquement). |

La base est protégée contre les coupures de courant (chaque encaissement validé est écrit sur le disque avant
d'être confirmé, et la base se répare toute seule au redémarrage). Un arrêt propre reste préférable : avant
d'éteindre le PC, double-cliquez `ARRETER.bat`.

## Mettre à jour vers une nouvelle version

1. Lancez **`SAUVEGARDER-MAINTENANT.bat`**.
2. Téléchargez le nouveau ZIP (étape 2) et extrayez-le **par-dessus** l'ancien dossier, en acceptant de remplacer
   les fichiers. Vos fichiers **`.env`** (mots de passe), **`config.ini`**, **`sauvegardes\`** et **`journaux\`** ne
   sont pas dans le ZIP : ils sont conservés.
3. Double-cliquez **`METTRE-A-JOUR.bat`** : il reconstruit l'application, applique les nouvelles migrations de la
   base (seulement celles qui manquent) et vérifie tout. Internet est nécessaire pendant la mise à jour.
4. Relancez **`5-ACTIVER-DEMARRAGE-AUTO.bat`** (met à jour les tâches et raccourcis si besoin).
5. Rechargez l'application sur chaque appareil.

## Basculer entre le serveur local et le Supabase en ligne

L'adresse et la clé Supabase sont dans des fichiers `.env`, jamais dans le code :

- **Version servie par ce serveur local** : fichier `serveur-local\.env`.
  - `APP_SUPABASE_URL` et `APP_SUPABASE_ANON_KEY` **vides** (par défaut) : l'application utilise **ce serveur
    local**.
  - Pour que le POS utilise le **Supabase en ligne** : remplissez-les avec l'URL du projet
    (`https://xxxx.supabase.co`) et la clé *anon public* (Supabase > *Project Settings* > *API*), puis
    double-cliquez `METTRE-A-JOUR.bat`. Videz-les et relancez `METTRE-A-JOUR.bat` pour revenir au serveur local.
- **Version en ligne actuelle** (compilée avec `npm run build`) : fichier `.env` à la racine du projet, inchangé
  (`VITE_SUPABASE_URL=https://…`). Elle continue de fonctionner exactement comme avant.

---

## En cas de panne

Premier réflexe : **`VERIFIER.bat`**. Les lignes `ERREUR` et `ALERTE` indiquent ce qui ne va pas. Les détails sont
dans `serveur-local\journaux\` (`demarrage.log`, `sauvegarde.log`).

| Situation | Que faire |
|---|---|
| **Coupure de courant** | Rien : au retour du courant (BIOS sur *Power On*), le PC redémarre, la session s'ouvre, le serveur et la caisse se lancent. La base se répare seule. Comptez 2 à 4 minutes. |
| **La page « Démarrage du serveur… » reste affichée** | Attendez 5 minutes (premier démarrage après une mise à jour de Windows ou de Docker). Sinon : Alt+Tab, ouvrez Docker Desktop (baleine près de l'horloge) et lisez son message ; puis `VERIFIER.bat` ; puis redémarrez le PC. |
| **« Docker ne démarre pas »** | Ouvrez Docker Desktop à la main et attendez la baleine immobile. Message *WSL* : acceptez la mise à jour. Message *Virtualization* : activer la virtualisation dans le BIOS. Dernier recours : redémarrer le PC. |
| **Les tablettes n'ouvrent plus l'application** (« Ce site est inaccessible ») | `VERIFIER.bat` : alerte « l'adresse IP du POS a changé » ? Utilisez la nouvelle adresse sur les tablettes et faites la **réservation DHCP** (étape 4). Sinon : tablette sur le Wi-Fi du restaurant (pas clients) ? Point d'accès en mode AP ? POS en réseau privé ? `OUVRIR-PARE-FEU.bat`. |
| **La caisse est figée / écran noir** | Raccourci **Caisse Smile Signature** (ferme et rouvre la caisse). |
| **Une ligne `ERREUR` dans `VERIFIER.bat`** | Relancez `DEMARRER.bat`. Si l'erreur reste : redémarrez le PC. Toujours là : envoyez une photo de la fenêtre de `VERIFIER.bat`. |
| **Données abîmées, erreur de manipulation** (articles effacés…) | `RESTAURER.bat` : choisissez la dernière sauvegarde **avant** le problème. L'état actuel est sauvegardé avant. |
| **Le PC du POS est mort** | Sur un PC de remplacement : étapes 1, 2 et 3 (nouveau compte admin provisoire), copiez le dossier de la dernière sauvegarde depuis la clé USB dans `serveur-local\sauvegardes\`, puis `RESTAURER.bat` (les comptes, la carte et les données reviennent), puis étapes 4 et 5. |
| **Alerte « dernière sauvegarde il y a … jours »** | `SAUVEGARDER-MAINTENANT.bat` et lisez le message. Tâche absente : relancez `5-ACTIVER-DEMARRAGE-AUTO.bat`. |
| **Alerte copie des sauvegardes inaccessible** | Rebranchez la clé USB (même lettre de lecteur), ou corrigez `COPIE_SAUVEGARDES` dans `config.ini`. |
| **Disque presque plein** | Réduisez `JOURS_A_GARDER` dans `config.ini`, ou copiez les vieilles sauvegardes ailleurs puis effacez-les de `sauvegardes\`. |
| **Mot de passe administrateur oublié** | `CREER-ADMIN.bat` avec le même nom d'utilisateur : le mot de passe est remplacé. |
| **Mot de passe refusé à la création** (« lettre accentuée ») | Choisissez un mot de passe sans accent (ex. `Cafe2026!`). |
| `1-INSTALLER.bat` : « port is already allocated » ou « 0.0.0.0:80 » | Le port 80 est pris par un autre logiciel (IIS, Skype…). Dans `.env`, mettez `HTTP_PORT=8080`, relancez `1-INSTALLER.bat`, puis utilisez `http://localhost:8080` et `http://IP-du-POS:8080` (relancez aussi `5-ACTIVER-DEMARRAGE-AUTO.bat`). |
| Connexion par PIN : « erreur serveur » juste après l'installation | La fonction PIN télécharge ses modules au premier appel : `1-INSTALLER.bat` le fait (internet nécessaire). Relancez `METTRE-A-JOUR.bat` avec internet. |

## Sécurité

- Le fichier **`.env`** contient les mots de passe internes de la base : ne le partagez pas, ne l'envoyez pas. Il
  n'est **pas** copié dans les sauvegardes (une restauration sur un nouveau PC utilise le `.env` de ce PC).
- Les sauvegardes contiennent toutes les données du restaurant : gardez la clé USB en lieu sûr.
- Le serveur n'est joignable que depuis le réseau du restaurant, et par Tailscale pour les appareils de votre
  compte. **N'ouvrez jamais de port** vers internet sur le routeur.
- Studio n'écoute que sur le POS lui-même (`localhost:3000`) et reste arrêté par défaut.

## Pour les curieux : ce qu'il y a dans ce dossier

| Élément | Rôle |
|---|---|
| `docker-compose.yml` | Les services : Postgres, GoTrue (auth), PostgREST, Realtime, Storage, Edge Runtime (pin-login), nginx (web). Retirés pour la mémoire : analytics/logs (Logflare, Vector), pooler (Supavisor), imgproxy, Kong/Envoy. |
| `web/` | Construction de l'application (`npm run build`) et configuration nginx : l'app et l'API sur la même adresse (`/auth/v1`, `/rest/v1`, `/realtime/v1`, `/storage/v1`, `/functions/v1`). |
| `outils/` | Scripts lancés dans un conteneur par les `.bat` : secrets, attente des services, migrations (dans l'ordre, suivies dans `serveur_local.migrations`), compte admin, vérification, sauvegarde (`pg_dump`) et restauration. |
| `windows/` | Scripts PowerShell (fournis avec Windows, rien à installer) lancés par les `.bat` et les tâches planifiées : démarrage, mode caisse (Edge kiosque) et sa page d'attente, sauvegardes, restauration, état du POS, icône du raccourci. |
| `fonctions/main/` | Routeur des fonctions Edge ; `pin-login` est pris directement dans `supabase/functions/pin-login`. |
| `db/` | Réglages appliqués à la création de la base (rôles internes, Realtime, durée des sessions). |
| `.env.example` / `config.exemple.ini` | Modèles de `.env` (créé par `1-INSTALLER.bat`) et de `config.ini` (créé par `5-ACTIVER-DEMARRAGE-AUTO.bat`). |
| `sauvegardes/`, `journaux/` | Créés sur le POS : sauvegardes et journaux (démarrage, sauvegardes). |
