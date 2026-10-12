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
> synchronisent pas). Le serveur local part d'une base vide ; `IMPORTER-DEPUIS-EN-LIGNE.bat` y recopie la
> configuration faite en ligne (salles, carte, employés, photos…), sans les données de test.

---

## Installation, dans l'ordre

| Étape | Quoi | Fichier |
|---|---|---|
| 1 | Installer Docker Desktop | (site de Docker) |
| 2 | Copier ce dossier sur le PC | ZIP du projet |
| 3 | Installer le serveur et créer le compte administrateur | `1-INSTALLER.bat` |
| 3 bis | Récupérer la configuration du Supabase en ligne (salles, carte, employés, photos…) | `IMPORTER-DEPUIS-EN-LIGNE.bat` |
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

Ou, si **Git pour Windows** est installé (mises à jour plus simples par `git pull`), dans PowerShell :
`cd C:\SmileSignature` puis
`git clone -c core.autocrlf=false https://github.com/tarekinstr-cloud/Smile-Signature-app.git app` : le dossier
est alors `C:\SmileSignature\app\serveur-local`. POS déjà installé par ZIP : voir
[Passer d'une installation par ZIP à git](#passer-dune-installation-par-zip-à-git-sans-perdre-les-données).

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

Sur le POS, ouvrez <http://localhost> et connectez-vous avec le compte administrateur. La base est vide : soit
vous créez les salles, la carte et les comptes des employés, soit vous les **récupérez du Supabase en ligne**
(ci-dessous).

### Récupérer la configuration du Supabase en ligne (`IMPORTER-DEPUIS-EN-LIGNE.bat`)

Si la configuration réelle du restaurant a été faite dans la version en ligne, cet outil la copie sur le serveur
local, **sans les données de test**. Internet est nécessaire pendant l'import. Il peut être relancé à tout moment
(par exemple après avoir corrigé la carte en ligne) : rien n'est créé en double.

| Copié | Jamais copié |
|---|---|
| Salles, tables et plan, fonds d'écran | Commandes, tickets de cuisine, paiements |
| Catégories, articles, prix, options, photos des articles | Caisses et journées, clôtures |
| Imprimantes et liaisons catégorie → imprimante | Mouvements de stock, inventaires |
| Zones de livraison | Fournisseurs, factures et retours fournisseurs |
| Paramètres : caisse et minuteurs, ticket, modes de paiement, catégories de dépenses, permissions des rôles | Réservations |
| Employés, leurs permissions et codes PIN | Clients et crédits clients, dépenses, avances sur salaire |
| Articles de stock (**sans les quantités**) et fiches techniques | Historique des prix |

**Ce qu'il faut** : dans Supabase (<https://supabase.com/dashboard>) > votre projet > **Project Settings** >
**API** (ou **API Keys**) :

- **Project URL**, par exemple `https://abcdefghijkl.supabase.co` ;
- la clé **`service_role`** (ou clé **secrète** `sb_secret_…`), bouton *Reveal* puis copier. **Pas** la clé
  `anon` / *publishable* : l'outil la refuse. Si une clé `sb_secret_…` est refusée, prenez la clé `service_role`
  de l'onglet *Legacy API Keys*.

Le serveur local doit être **à la même version** que l'application en ligne : faites d'abord la mise à jour
(`METTRE-A-JOUR.bat`, ou `git pull` puis `METTRE-A-JOUR.bat`). Une colonne qui n'existe que d'un côté est ignorée.

La clé donne un accès complet au projet en ligne : elle est seulement tapée dans la fenêtre, **jamais enregistrée**
(ni dans un fichier, ni dans le dépôt), et oubliée à la fin de l'import.

**Déroulement** : double-cliquez **`IMPORTER-DEPUIS-EN-LIGNE.bat`**, collez l'adresse puis la clé (clic droit dans
la fenêtre ; rien ne s'affiche pour la clé, c'est normal).

1. L'outil **lit** la configuration en ligne et affiche le nombre de lignes de chaque table et de photos. Rien n'est
   encore modifié sur le serveur local (une clé ou une adresse fausse s'arrête ici, avec un message clair).
2. Tapez **`OUI`** pour continuer.
3. **Sauvegarde locale** automatique (`sauvegardes\…-avant-import`) : `RESTAURER.bat` permet de revenir en arrière.
4. Chargement de la configuration, **en une seule fois** : en cas d'erreur, rien n'est modifié dans la base.
5. Copie des photos et fonds d'écran (les fichiers déjà présents ne sont pas recopiés).
6. **Résumé** : pour chaque table, lignes en ligne, ajoutées, mises à jour, supprimées, et total sur le serveur
   local.

**Règles de la copie**

- Les **identifiants** (UUID) d'en ligne sont conservés : tous les liens (article → catégorie, catégorie →
  imprimante, table → salle, fiche technique → article de stock…) restent justes, et un nouvel import met à jour
  les mêmes lignes au lieu d'en créer de nouvelles.
- **Le Supabase en ligne fait référence** : un élément de configuration présent sur le serveur local mais absent en
  ligne (exemples créés à l'installation, élément supprimé en ligne) est **supprimé**, sauf s'il est utilisé par
  des données locales (une commande, un mouvement de stock…) : il est alors gardé et signalé dans le résumé.
  Une imprimante ou une catégorie de dépense du même nom des deux côtés est fusionnée en une seule.
- **Stock** : les articles de stock arrivent avec une **quantité de 0** (les quantités en ligne viennent des
  essais) ; un nouvel import ne touche pas aux quantités locales. Faites un inventaire pour saisir le stock réel.
  Toutes les tables arrivent **libres**.
- **Employés** : leurs comptes sont créés avec le même identifiant, leurs permissions et leur **code PIN** sont
  copiés. Les **mots de passe** ne peuvent pas être lus en ligne (c'est voulu) : les employés se connectent par
  code PIN (si la connexion par PIN est activée dans les paramètres), ou l'administrateur leur donne un mot de passe
  dans *Fichier* > *Utilisateurs*.
- **Le compte administrateur local n'est jamais modifié**, ni aucun compte déjà présent sur le serveur local. Un
  employé en ligne dont le nom (ou l'e-mail) est déjà pris par un compte local — souvent `admin` — n'est pas
  importé : le résumé l'indique (`ATTENTION : employe "admin" non importe`).
- Les adresses des photos sont converties pour le serveur local : elles s'affichent sur le POS comme sur les
  tablettes, sans internet.

Après l'import : rechargez l'application sur chaque appareil, vérifiez la carte, les salles et les imprimantes,
puis donnez un mot de passe aux employés qui n'utilisent pas de code PIN.

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
| `IMPORTER-DEPUIS-EN-LIGNE.bat` | Recopier la configuration du Supabase en ligne (carte, salles, employés, photos), sans les données de test. |
| `OUVRIR-PARE-FEU.bat` | Si les tablettes ne joignent pas le POS. |
| `5-ACTIVER-DEMARRAGE-AUTO.bat` | Après une modification de `config.ini` ou une mise à jour. |
| `METTRE-A-JOUR.bat` | Après avoir copié une nouvelle version du projet (voir plus bas). |
| `STUDIO.bat` / `STUDIO-ARRETER.bat` | Facultatif : tableau de bord Supabase sur <http://localhost:3000> (POS uniquement). |

La base est protégée contre les coupures de courant (chaque encaissement validé est écrit sur le disque avant
d'être confirmé, et la base se répare toute seule au redémarrage). Un arrêt propre reste préférable : avant
d'éteindre le PC, double-cliquez `ARRETER.bat`.

## Mettre à jour vers une nouvelle version

Vos fichiers **`.env`** (mots de passe), **`config.ini`**, **`sauvegardes\`** et **`journaux\`** ne sont ni dans le
ZIP ni dans git : une mise à jour ne les touche jamais.

**Installation par ZIP :**

1. Lancez **`SAUVEGARDER-MAINTENANT.bat`**.
2. Téléchargez le nouveau ZIP (étape 2) et extrayez-le **par-dessus** l'ancien dossier, en acceptant de remplacer
   les fichiers.
3. Double-cliquez **`METTRE-A-JOUR.bat`** : il reconstruit l'application, applique les nouvelles migrations de la
   base (seulement celles qui manquent) et vérifie tout. Internet est nécessaire pendant la mise à jour.
4. Relancez **`5-ACTIVER-DEMARRAGE-AUTO.bat`** (met à jour les tâches et raccourcis si besoin).
5. Rechargez l'application sur chaque appareil.

**Installation par git** (voir la section suivante pour passer du ZIP à git), dans PowerShell :

```powershell
cd C:\SmileSignature\app
git pull
cd serveur-local
.\SAUVEGARDER-MAINTENANT.bat
.\METTRE-A-JOUR.bat
.\5-ACTIVER-DEMARRAGE-AUTO.bat
```

Puis rechargez l'application sur chaque appareil.

## Passer d'une installation par ZIP à git (sans perdre les données)

Pour un POS déjà installé à partir d'un ZIP (avec `1-INSTALLER.bat`), sur lequel **Git pour Windows** vient d'être
installé (<https://git-scm.com/download/win>). Ensuite, une mise à jour se fait par `git pull`.

**Ce qu'il faut savoir** : la base (compte admin, comptes, carte, commandes) et les photos ne sont **pas** dans le
dossier : elles sont dans des volumes Docker (`smile_db-data`, `smile_storage-data`…), dont le nom est fixé dans
`docker-compose.yml` (`name: smile`). Le nouveau dossier les retrouve tout seul.

| Élément | Où il est | À copier de l'ancien dossier ? |
|---|---|---|
| Base, compte admin, comptes, carte, commandes | volume Docker `smile_db-data` | non |
| Photos des plats, fonds de salle | volume Docker `smile_storage-data` | non |
| Secrets (mots de passe de la base, clés) | `serveur-local\.env` | **oui, obligatoire** |
| `.env` à la racine du projet | seulement si vous en avez créé un | oui s'il existe |
| `config.ini`, `sauvegardes\` | `serveur-local\` (si l'ancienne version les a) | oui s'ils existent |

> Sans l'ancien `.env`, de nouveaux mots de passe seraient générés et les services ne pourraient plus se connecter à
> la base existante.

Ouvrez **PowerShell** normalement (pas en administrateur), Docker Desktop lancé, puis :

**1. Repérer l'ancien dossier.** Cette commande liste les fichiers `.env` ; gardez celui qui finit par
`\serveur-local\.env` :

```powershell
Get-ChildItem C:\SmileSignature -Recurse -Force -Filter .env | Select-Object FullName
```

Adaptez la première ligne ci-dessous avec ce chemin (sans le `\.env` final), puis exécutez les quatre lignes :

```powershell
$ancien  = "C:\SmileSignature\Smile-Signature-app-main\serveur-local"   # <- votre chemin
$racine  = "C:\SmileSignature\app"
$nouveau = "$racine\serveur-local"
Test-Path "$ancien\.env"
```

Doit afficher `True`.

**2. Vérifier que les données sont dans les volumes Docker :**

```powershell
docker volume ls --filter name=smile_
```

Doit lister `smile_db-data`, `smile_db-config`, `smile_storage-data` et `smile_deno-cache`. **Sinon, arrêtez-vous
ici** et demandez de l'aide (envoyez le résultat de la commande).

**3. Copie de sécurité des secrets** (hors des deux dossiers) :

```powershell
New-Item -ItemType Directory -Force C:\SmileSignature\securite | Out-Null
Copy-Item "$ancien\.env" "C:\SmileSignature\securite\env-avant-git.txt"
```

**4. Cloner le projet :**

```powershell
cd C:\SmileSignature
git clone -c core.autocrlf=false https://github.com/tarekinstr-cloud/Smile-Signature-app.git app
Test-Path "$nouveau\5-ACTIVER-DEMARRAGE-AUTO.bat"
```

Doit afficher `True`. Si le dépôt est privé, Git ouvre une fenêtre de connexion GitHub.
`core.autocrlf=false` garde les fichiers identiques à ceux du ZIP : sans lui, Git changerait les fins de ligne
des migrations et `METTRE-A-JOUR.bat` afficherait des messages « a change depuis son application » (sans danger,
mais inquiétants).

**5. Copier les secrets (et le reste s'il existe) dans le nouveau dossier :**

```powershell
Copy-Item "$ancien\.env" "$nouveau\.env"
if (Test-Path "$ancien\..\.env")     { Copy-Item "$ancien\..\.env" "$racine\.env" }
if (Test-Path "$ancien\config.ini")  { Copy-Item "$ancien\config.ini" "$nouveau\config.ini" }
if (Test-Path "$ancien\sauvegardes") { Copy-Item "$ancien\sauvegardes" "$nouveau\sauvegardes" -Recurse }
Compare-Object (Get-Content "$ancien\.env") (Get-Content "$nouveau\.env")
git -C $racine status --short
```

Les deux dernières commandes ne doivent **rien** afficher (les deux `.env` sont identiques, et git ignore bien ces
fichiers).

**6. Sauvegarde de sécurité, avant de toucher au serveur :**

```powershell
cd $nouveau
.\SAUVEGARDER-MAINTENANT.bat
```

Elle ne modifie pas le serveur en place. Attendez **« OK : sauvegarde … »** avec la ligne
`Fichiers : floor-backgrounds:… item-photos:…`. Elle vérifie aussi que le `.env` est le bon (sinon : erreur de
connexion à la base). **En cas d'ERREUR, arrêtez-vous** : rien n'a été modifié. Copie sur clé USB (facultatif) :
`Copy-Item "$nouveau\sauvegardes\*" "E:\SauvegardesSmile\" -Recurse`.

**7. Basculer le serveur sur le nouveau dossier :**

```powershell
.\METTRE-A-JOUR.bat
```

Internet nécessaire. Les conteneurs sont recréés depuis le nouveau dossier, sur les mêmes volumes. Attendu :
« Migrations : … appliquee(s) maintenant » puis **« RESULTAT : tout fonctionne »**. Vérifiez à la main : connexion
sur <http://localhost> avec votre compte admin habituel, carte et photos présentes, une tablette sur
`http://IP-du-POS`.

**8. Mise en production :**

```powershell
.\5-ACTIVER-DEMARRAGE-AUTO.bat
```

Répondez *Oui* à l'autorisation administrateur. Les raccourcis et les tâches planifiées pointent désormais vers le
nouveau dossier. Redémarrez le PC, puis `.\VERIFIER.bat` (dans `C:\SmileSignature\app\serveur-local`).

**9. Mettre l'ancien dossier de côté** (une fois que tout fonctionne) :

```powershell
Rename-Item (Split-Path $ancien) "ANCIEN-ne-plus-utiliser"
```

Ne lancez plus aucun `.bat` de l'ancien dossier (il recréerait les conteneurs avec l'ancien code). Supprimez-le
après une semaine.

> **À ne jamais faire** : `docker compose down -v` ou supprimer des volumes dans Docker Desktop (cela efface la base
> et les photos) ; relancer `1-INSTALLER.bat` sans le bon `.env`. En cas d'oubli du `.env` : remettez
> `C:\SmileSignature\securite\env-avant-git.txt` sous le nom `serveur-local\.env`, puis `METTRE-A-JOUR.bat`.

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
- La clé `service_role` du Supabase en ligne (demandée par `IMPORTER-DEPUIS-EN-LIGNE.bat`) n'est jamais
  enregistrée ; ne la collez nulle part ailleurs. Les fichiers lus en ligne sont effacés à la fin de l'import.

## Pour les curieux : ce qu'il y a dans ce dossier

| Élément | Rôle |
|---|---|
| `docker-compose.yml` | Les services : Postgres, GoTrue (auth), PostgREST, Realtime, Storage, Edge Runtime (pin-login), nginx (web). Retirés pour la mémoire : analytics/logs (Logflare, Vector), pooler (Supavisor), imgproxy, Kong/Envoy. |
| `web/` | Construction de l'application (`npm run build`) et configuration nginx : l'app et l'API sur la même adresse (`/auth/v1`, `/rest/v1`, `/realtime/v1`, `/storage/v1`, `/functions/v1`). |
| `outils/` | Scripts lancés dans un conteneur par les `.bat` : secrets, attente des services, migrations (dans l'ordre, suivies dans `serveur_local.migrations`), compte admin, vérification, sauvegarde (`pg_dump`) et restauration, import de la configuration en ligne (`importer-en-ligne.mjs` lit l'API en ligne, `importer.sql` charge en une transaction). |
| `windows/` | Scripts PowerShell (fournis avec Windows, rien à installer) lancés par les `.bat` et les tâches planifiées : démarrage, mode caisse (Edge kiosque) et sa page d'attente, sauvegardes, restauration, état du POS, icône du raccourci. |
| `fonctions/main/` | Routeur des fonctions Edge ; `pin-login` est pris directement dans `supabase/functions/pin-login`. |
| `db/` | Réglages appliqués à la création de la base (rôles internes, Realtime, durée des sessions). |
| `.env.example` / `config.exemple.ini` | Modèles de `.env` (créé par `1-INSTALLER.bat`) et de `config.ini` (créé par `5-ACTIVER-DEMARRAGE-AUTO.bat`). |
| `sauvegardes/`, `journaux/` | Créés sur le POS : sauvegardes et journaux (démarrage, sauvegardes). |
