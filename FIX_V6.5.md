# Killzone CHoCH Desk — V6.5

## Moteur de structure
- Remplacement de la confirmation CISD M3 par la logique fractale Market Structure LuxAlgo (longueur 5, p=2).
- Seuls les événements CHoCH sont émis. Les BOS mettent à jour l'état structurel mais ne déclenchent pas de signal.
- Sweep d'un plus bas + CHoCH haussier = BUY ; sweep d'un plus haut + CHoCH baissier = SELL.
- CHoCH accepté avant ou après la réintégration du niveau cassé.
- Deux moteurs indépendants M2 et M3. M2 est agrégé directement depuis les bougies 1 minute, jamais depuis M3.

## Liquidité inter-session
- Lorsqu'un niveau d'une session est cassé, le moteur suit l'extrême du mouvement après la cassure.
- Au démarrage de la session suivante, cet extrême devient une liquidité GAP à balayer.
- Tant que cette liquidité GAP n'est pas balayée, la cassure source ne peut pas justifier un CHoCH de la nouvelle session.
- Si aucune liquidité intermédiaire n'a été créée, les niveaux high/low classiques des sessions restent utilisables.
- Les horaires et la construction des boxes des sessions existantes sont conservés.

## Daily / H4
- Daily et H4 alignés : HIGH.
- Un seul aligné : MEDIUM.
- Tous deux opposés : COUNTER_TREND.
- La classification n'empêche jamais un signal valide.

## Alertes et historique
- Telegram et notification applicative restent reliés au même signal.
- Déduplication basée sur timeframe, niveau de liquidité et horodatage du sweep/CHoCH.
- Un signal n'affiche que le dernier sweep responsable (ou les sweeps au même instant).
- « J'ai vu » arrête les rappels ; 10 envois maximum au total, intervalle par défaut de 30 secondes.
- Historique filtrable sur 3 ou 4 jours. Les flux chargent jusqu'à 5 jours pour alimenter cet historique.

## Tests
- Tests ajoutés pour CHoCH-only, liquidité inter-session, M2 indépendant, pré-réintégration, attribution du sweep, classification D1/H4, rappels et notification locale.
- Les scripts de test ont été exécutés individuellement avec Node.js TypeScript stripping dans l'environnement de préparation.
- `npm run build` et `npm test` via leurs scripts npm n'ont pas pu être exécutés ici : les dépendances du projet ne sont pas installées et l'installation npm a expiré. Le build Vite doit être vérifié après `npm install`.
