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

## Application Android autonome (sans serveur)

L'APK embarque le moteur : il récupère les prix, détecte les signaux et **notifie directement
sur le téléphone**, sans hébergement ni Firebase. Telegram reste possible (token et chat ID dans
les réglages de l'app).

1. Onglet **Actions → Build Android APK → Run workflow** (ou `git push` sur `main`).
2. Installer l'APK depuis **Releases → « APK le plus récent »**.
3. Au premier lancement : accepter les **notifications** et la demande
   « ignorer l'optimisation de batterie ».
4. Une notification permanente « Surveillance active » apparaît : c'est le service qui garde le
   moteur en vie écran éteint. Ne la désactivez pas.

Le bouton ⚙ (en bas à gauche) permet de passer en **mode serveur** (voir plus bas).

### Limites à connaître
- Le moteur tourne **sur le téléphone** : si Android tue l'app (économiseur de batterie agressif,
  « fermeture des apps en arrière-plan » sur Xiaomi/Huawei/Oppo/Samsung…), la détection s'arrête.
  Désactivez l'optimisation de batterie pour l'app et verrouillez-la dans les apps récentes.
- Pas de connexion internet = pas de signaux.
- Mode non validé sur un vrai appareil au moment de l'écriture : les tests couvrent le moteur,
  l'API locale et les notifications côté code, pas le comportement d'Android en veille prolongée.

## Mode serveur (optionnel, plus fiable en veille profonde)

Un serveur qui tourne en continu détecte les signaux même téléphone éteint ou app tuée, et peut
envoyer un push Firebase instantané (priorité haute, passe le mode Doze).

Variables du serveur : `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ACCESS_TOKEN` (recommandé),
`FCM_SERVICE_ACCOUNT_BASE64` (pour le push).
Côté GitHub : secret `GOOGLE_SERVICES_JSON` (fichier Firebase de l'app Android
`com.cisd.killzonedesk`) pour que l'APK active le push.
Un `Dockerfile` est fourni. Sur Cloud Run : `--min-instances=1 --no-cpu-throttling`.

## Notes

- L'APK est signé avec une clé de debug **commitée** (`android-signing/`) : pratique pour installer
  les mises à jour par-dessus, suffisant pour un usage personnel, **inadapté au Play Store**.
- `.push-tokens.json` (appareils enregistrés, mode serveur) est local au serveur.


## M3 / M5 et notifications Telegram

Le moteur CISD M3 reste actif. Un moteur M5 independant peut etre active dans les parametres; ses bougies sont construites a partir des donnees 1 minute Yahoo (pas en agregant artificiellement des bougies M3). Les alertes affichent tous les niveaux de session de meme sens balayes dans la fenetre de confluence (par exemple NY AM et NY PM). Les biais Daily et H4 sont affiches separement; les configurations divergentes restent autorisees et continuent a declencher une alerte dans la Killzone. La probabilite est classee HAUTE lorsque Daily et H4 confirment tous deux la direction du CISD; sinon le signal reste visible avec son classement MEDIUM ou CONTRE-TENDANCE. Telegram envoie un message initial puis des rappels a l'intervalle configure, jusqu'a « J'ai vu », 10 envois au total ou expiration du setup. Le journal conserve jusqu'a 300 signaux reconstruits a partir de l'historique de marche disponible.


### Delayed CISD after a Killzone sweep

A qualifying sweep must occur while one of the configured Killzones is active. After that initial sweep, the engine continues to look for a same-direction CISD on M3 and M5 until 23:59 New York time on the same trading day. The CISD may therefore confirm after the Killzone has ended, including after a retest or re-entry through the swept level. A sweep from a prior New York day, or a sweep that first occurs outside a Killzone, cannot trigger the setup. Daily/H4 alignment determines the probability classification and does not suppress divergent setups.


## Session sweep-to-CISD eligibility (V4)

- Session high/low levels from today, yesterday, and the previous New York calendar day remain eligible until swept.
- A level may be swept outside its original Killzone; CISD confirmation may also occur after a Killzone ends.
- A matching directional CISD (bearish after a session high sweep, bullish after a session low sweep) is alertable later on the same New York day as the sweep.
- Confirmation is accepted whether it occurs before or after a retest/re-entry of the swept level.
- Multiple same-direction session levels swept before the CISD are grouped in the alert.
