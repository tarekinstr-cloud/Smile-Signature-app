# Serveur local Smile Signature (sans internet)

Ce dossier transforme **un PC Windows** (le POS du restaurant, ou votre PC portable pour essayer) en serveur pour
toute l'application. Les tablettes et les téléphones des serveurs s'y connectent par le **Wi-Fi du restaurant**.
Une fois installé, **tout fonctionne sans internet**.

```
                 Wi-Fi du restaurant (routeur)
        ┌───────────────┼────────────────┐
   Tablette 1      Téléphone 2      POS Windows  ← caisse + serveur
 http://192.168.1.50   …           http://localhost
```

> **Important :** les données du serveur local et celles du Supabase en ligne sont **séparées** (elles ne se
> synchronisent pas). Pour l'essai sur votre PC portable, vous partez d'une base vide.

---

## Ce qu'il faut

| | Minimum | Recommandé |
|---|---|---|
| Windows | 10 (version 22H2) ou 11, 64 bits | Windows 11 |
| Mémoire (RAM) | 8 Go | 8 Go ou plus |
| Disque libre | 20 Go | SSD avec 40 Go libres |
| Internet | seulement pour l'installation et les mises à jour | |

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
   **redémarrez le PC** quand il le demande.
4. Au premier lancement de Docker Desktop : acceptez les conditions, puis choisissez **Continue without signing in**
   (aucun compte n'est nécessaire). Si une fenêtre demande de mettre à jour WSL, acceptez.
5. Dans Docker Desktop, roue dentée ⚙ **Settings** > **General** : cochez
   **Start Docker Desktop when you sign in to your computer**. Cliquez *Apply*.
6. (Conseillé) Limiter la mémoire de Docker : ouvrez le Bloc-notes, collez les 3 lignes ci-dessous, puis
   *Fichier > Enregistrer sous* : nom **`.wslconfig`** (avec le point), type *Tous les fichiers*, dans votre dossier
   utilisateur (`C:\Users\VotreNom\`). Redémarrez ensuite le PC.

   ```
   [wsl2]
   memory=3GB
   swap=2GB
   ```

## Étape 2 — Copier le dossier sur le PC

1. Sur la page GitHub du projet : bouton vert **Code** > **Download ZIP**.
2. Faites un clic droit sur le fichier téléchargé > **Extraire tout…** vers **`C:\SmileSignature`**
   (un chemin simple, sans accent ni espace).
3. Ouvrez `C:\SmileSignature\…\serveur-local` : c'est ce dossier qui contient les fichiers `.bat` ci-dessous.

## Étape 3 — Installer le serveur (une seule fois, internet nécessaire)

1. Vérifiez que Docker Desktop est lancé (icône de baleine en bas à droite, près de l'horloge).
2. Double-cliquez **`1-INSTALLER.bat`**. Si Windows affiche « Windows a protégé votre ordinateur » :
   *Informations complémentaires* > *Exécuter quand même*.
3. Patientez : le premier lancement télécharge environ **2 Go** (5 Go une fois installés sur le disque), soit 10 à 30 minutes selon la connexion.
4. Le script demande le **compte administrateur** de l'application : un nom d'utilisateur (ex. `admin`) et un mot
   de passe (tapé deux fois ; rien ne s'affiche pendant la frappe, c'est normal).
5. À la fin, il affiche **« RESULTAT : tout fonctionne »** et les adresses de l'application.

Si une étape échoue (coupure internet…), relancez simplement `1-INSTALLER.bat` : ce qui est déjà fait n'est pas
refait, et les mots de passe internes ne sont jamais régénérés.

## Étape 4 — Ouvrir l'application

- **Sur le POS** : <http://localhost> — connectez-vous avec le compte administrateur créé à l'étape 3, puis créez
  les salles, la carte et les comptes des employés comme d'habitude.
- **Sur les tablettes et téléphones** : ils doivent être sur **le même Wi-Fi** que le POS. Dans le navigateur
  (Chrome conseillé), tapez **`http://` suivi de l'adresse IP du POS**, par exemple `http://192.168.1.50`.
  L'adresse est affichée à la fin de `1-INSTALLER.bat`, `DEMARRER.bat` et `VERIFIER.bat`.

Si les tablettes n'arrivent pas à se connecter :

1. Double-cliquez **`OUVRIR-PARE-FEU.bat`** (Windows demande l'autorisation administrateur : *Oui*).
2. Le Wi-Fi du POS doit être en **réseau privé** : *Paramètres Windows* > *Réseau et Internet* > *Wi-Fi* > nom du
   réseau > **Type de profil réseau : Privé**.
3. Si Windows a affiché une fenêtre « Autoriser Docker Desktop Backend… », cochez **Réseaux privés** et
   *Autoriser*.

> Astuce : sur chaque tablette, ajoutez l'adresse à l'écran d'accueil (menu ⋮ de Chrome > *Ajouter à l'écran
> d'accueil*) pour l'ouvrir comme une application. Le réseau local étant en `http` (pas `https`), le navigateur
> n'installe pas le mode hors ligne de l'application sur les tablettes : elles ont simplement besoin du Wi-Fi du
> restaurant, pas d'internet.

## Étape 5 — Fixer l'adresse IP du POS sur le routeur

Les tablettes retiennent l'adresse du POS (ex. `192.168.1.50`). Pour qu'elle ne change jamais (après une coupure
de courant, par exemple), on la **réserve** dans le routeur :

1. Sur le POS, ouvrez **Invite de commandes** (touche Windows, tapez `cmd`, Entrée), puis tapez `ipconfig /all`.
   Dans le bloc de la carte **Wi-Fi** (ou *Ethernet* si le POS est branché par câble — c'est le plus fiable),
   notez :
   - **Adresse physique** (ex. `A4-5E-60-12-34-56`) ;
   - **Adresse IPv4** (ex. `192.168.1.50`) ;
   - **Passerelle par défaut** (ex. `192.168.1.1`) : c'est l'adresse du routeur.
2. Dans un navigateur, ouvrez l'adresse du routeur (ex. `http://192.168.1.1`) et connectez-vous (identifiant et
   mot de passe souvent écrits sous le routeur).
3. Cherchez le menu **DHCP** puis **Réservation d'adresse** / **IP statique** / **Address Reservation** /
   **DHCP Binding** (le nom dépend du modèle : TP-Link, Huawei, ZTE, D-Link…).
4. Ajoutez une réservation : l'**adresse physique** (MAC) du POS et l'**adresse IPv4** notée. Enregistrez.
5. Redémarrez le POS : `VERIFIER.bat` doit afficher la même adresse.

Si le routeur n'a pas ce menu, on peut fixer l'adresse dans Windows (*Paramètres* > *Réseau et Internet* > carte
réseau > *Attribution d'adresse IP* > *Modifier* > *Manuel*), avec une adresse hors de la plage DHCP du routeur :
demandez à votre installateur réseau.

---

## Au quotidien

| Fichier | Quand |
|---|---|
| `DEMARRER.bat` | Lance Docker, le serveur, puis ouvre l'application. (Le démarrage automatique avec Windows et le mode plein écran arrivent à l'étape suivante du projet.) |
| `ARRETER.bat` | **Arrêt propre** avant d'éteindre le PC : la base enregistre tout puis s'arrête. |
| `VERIFIER.bat` | Contrôle complet : services, lecture de toutes les tables, mémoire, adresses. |
| `CREER-ADMIN.bat` | Mot de passe administrateur oublié : le remet, ou crée un autre administrateur. |
| `OUVRIR-PARE-FEU.bat` | Une fois, si les tablettes ne joignent pas le POS. |
| `METTRE-A-JOUR.bat` | Après avoir copié une nouvelle version du projet (voir plus bas). |
| `STUDIO.bat` / `STUDIO-ARRETER.bat` | Facultatif : tableau de bord Supabase sur <http://localhost:3000> (POS uniquement). |

La base est protégée contre les coupures de courant (chaque encaissement validé est écrit sur le disque avant
d'être confirmé, et la base se répare toute seule au redémarrage). Un arrêt propre reste préférable.

## Mettre à jour vers une nouvelle version

1. Téléchargez le nouveau ZIP (étape 2) et extrayez-le **par-dessus** l'ancien dossier, en acceptant de remplacer
   les fichiers. Votre fichier **`.env`** (mots de passe) n'est pas dans le ZIP : il est conservé.
2. Double-cliquez **`METTRE-A-JOUR.bat`** : il reconstruit l'application, applique les nouvelles migrations de la
   base (seulement celles qui manquent) et vérifie tout. Internet est nécessaire pendant la mise à jour.
3. Rechargez l'application sur chaque appareil.

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

## Dépannage

| Problème | Solution |
|---|---|
| « Docker Desktop ne demarre pas » | Lancez Docker Desktop à la main et attendez la baleine immobile. Message *Virtualization* : activer la virtualisation dans le BIOS. |
| `1-INSTALLER.bat` : erreur « port is already allocated » ou « 0.0.0.0:80 » | Le port 80 est pris par un autre logiciel (IIS, Skype…). Dans `.env`, mettez `HTTP_PORT=8080`, relancez `1-INSTALLER.bat`, puis utilisez `http://localhost:8080` et `http://IP-du-POS:8080`. |
| Tablette : « Ce site est inaccessible » | Même Wi-Fi ? Adresse IP correcte (voir `VERIFIER.bat`) ? `OUVRIR-PARE-FEU.bat` lancé ? Wi-Fi du POS en réseau **privé** ? |
| Connexion par PIN : « erreur serveur » juste après l'installation | La fonction PIN télécharge ses modules au premier appel : `1-INSTALLER.bat` le fait (internet nécessaire). Relancez `METTRE-A-JOUR.bat` avec internet. |
| Une ligne `ERREUR` dans `VERIFIER.bat` | Relancez `DEMARRER.bat` ; si l'erreur reste, envoyez une photo de la fenêtre de `VERIFIER.bat`. |

## Sécurité

- Le fichier **`.env`** contient les mots de passe internes de la base : ne le partagez pas, ne l'envoyez pas.
- Le serveur n'est joignable que depuis le réseau du restaurant. **N'ouvrez aucun port** vers internet sur le
  routeur (pas de « redirection de port » / *port forwarding*). L'accès à distance sécurisé fera l'objet d'une étape
  suivante.
- Studio n'écoute que sur le POS lui-même (`localhost:3000`) et reste arrêté par défaut.

## Pour les curieux : ce qu'il y a dans ce dossier

| Élément | Rôle |
|---|---|
| `docker-compose.yml` | Les services : Postgres, GoTrue (auth), PostgREST, Realtime, Storage, Edge Runtime (pin-login), nginx (web). Retirés pour la mémoire : analytics/logs (Logflare, Vector), pooler (Supavisor), imgproxy, Kong/Envoy. |
| `web/` | Construction de l'application (`npm run build`) et configuration nginx : l'app et l'API sur la même adresse (`/auth/v1`, `/rest/v1`, `/realtime/v1`, `/storage/v1`, `/functions/v1`). |
| `outils/` | Scripts lancés par les `.bat` : secrets, attente des services, migrations (dans l'ordre, suivies dans `serveur_local.migrations`), compte admin, vérification. |
| `fonctions/main/` | Routeur des fonctions Edge ; `pin-login` est pris directement dans `supabase/functions/pin-login`. |
| `db/` | Réglages appliqués à la création de la base (rôles internes, Realtime, durée des sessions). |
| `.env.example` | Modèle du fichier de réglages `.env` (créé par `1-INSTALLER.bat`). |
