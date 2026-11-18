# Killzone CISD Desk

Moteur temps réel Killzones ICT + CISD M3 (XAU/USD, EUR/USD) avec alertes Telegram
et **notifications push instantanées sur Android (APK)**.

```bash
npm install
npm run dev      # développement (Vite + serveur)
npm run build && npm start   # production
npm test         # tests du moteur (DST, pipeline de signaux, flux de marché, push)
```

## Corrections apportées

| Problème | Effet | Correction |
|---|---|---|
| **Heure d'été NY fausse** du 8 au 14 mars et du 1er au 7 novembre | Killzones décalées d'1 h pendant ~12 jours/an | Calcul exact (2e dimanche de mars 07:00 UTC → 1er dimanche de novembre 06:00 UTC), vérifié contre `America/New_York` sur 2025-2027 |
| **Or : futures `GC=F` mélangés au spot Swissquote** | Bougies live fausses (ex. open 4040 / low 4003 pour un spot à 4003) → faux sweeps et faux CISD | Ticker spot `XAUUSD=X` en priorité ; si seul `GC=F` répond, les prix sont recalés sur le spot. La bougie live n'est plus fusionnée avec Yahoo tant que le spot répond |
| Requêtes réseau **sans timeout** | Une requête bloquée gelait le flux ou les alertes | Timeout de 8 s partout (Yahoo, Swissquote, Twelve Data, Telegram, webhook) |
| Polls spot qui **se chevauchent** | Traitements concurrents de la même bougie | Verrou anti-chevauchement (tick et sync) |
| Statut « déconnecté » à tort | Un échec de l'historique Yahoo marquait le flux hors ligne alors que le spot arrivait | Le statut tient compte du spot ; repli sur Yahoo si le spot est muet > 20 s |
| `npm start` lançait Vite en dev | Mauvais mode en production | `NODE_ENV=production`, `tsx` en dépendance |
| API ouverte à tous | Quiconque pouvait changer le token Telegram ou spammer le webhook TradingView | `ACCESS_TOKEN` optionnel + CORS |

## Notifications push instantanées (APK)

Le push part **en parallèle** de Telegram, sans attendre sa réponse (testé : push émis ~300 ms avant
la réponse de Telegram). Mécanisme : Firebase Cloud Messaging en priorité haute, qui réveille le
téléphone même en veille profonde (Doze) et application fermée.

### 1. Firebase (gratuit, ~5 min)
1. https://console.firebase.google.com → **Ajouter un projet**.
2. Dans le projet → **Ajouter une application Android**, nom de package : `com.cisd.killzonedesk`.
3. Télécharger **`google-services.json`**.
4. ⚙ Paramètres du projet → **Comptes de service** → **Générer une nouvelle clé privée** → fichier JSON.

### 2. GitHub (dépôt → Settings → Secrets and variables → Actions)
- Secret **`GOOGLE_SERVICES_JSON`** : contenu complet du `google-services.json`.
- *(optionnel)* Variable **`SERVER_URL`** : adresse de votre serveur, pré-remplie dans l'APK.

### 3. Serveur
Variables d'environnement :
```
FCM_SERVICE_ACCOUNT_BASE64   # base64 -w0 service-account.json
ACCESS_TOKEN                 # recommandé dès que le serveur est sur Internet
```

### 4. Construire l'APK
Onglet **Actions → Build Android APK → Run workflow** (ou simple `git push` sur `main`).
L'APK est publié dans **Releases → « APK le plus récent »** et dans les artefacts du run.

### 5. Installer
Télécharger l'APK sur le téléphone, l'installer (autoriser les sources inconnues), ouvrir l'app,
saisir l'adresse du serveur (et le jeton), **accepter les notifications**.
Le bouton « Tester » des intégrations envoie un test Telegram **et** un push.

## ⚠️ Le serveur doit tourner en continu

Le moteur tourne en tâche de fond sur le serveur : s'il dort, **aucune alerte ne part**, ni push ni Telegram.
- Cloud Run : `--min-instances=1 --no-cpu-throttling`.
- Les hébergements gratuits qui s'endorment ne conviennent pas.

Sur certains Android (Xiaomi, Huawei, Oppo…), désactiver l'optimisation de batterie pour l'app
et autoriser le démarrage automatique, sinon le système peut retarder les notifications.

## Notes

- L'APK est signé avec une clé de debug **commitée** (`android-signing/`) : pratique pour installer
  les mises à jour par-dessus, suffisant pour un usage personnel, **inadapté au Play Store**.
- `.push-tokens.json` (appareils enregistrés) est local au serveur ; sur un hébergement à disque
  éphémère, l'app se ré-enregistre à chaque lancement.
