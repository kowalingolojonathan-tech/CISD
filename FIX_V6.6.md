# Killzone CHoCH Desk — V6.6

## Historique M3 uniquement
- L’onglet historique des signaux filtre désormais les alertes M3 uniquement.
- Les alertes M2 restent actives dans le moteur et les notifications, mais ne sont pas mélangées à cet historique de consultation.
- Les filtres 3 jours / 4 jours sont conservés.

## Graphiques : cassures des sessions
- Les niveaux hauts/bas issus des sessions sont tracés sur le graphique avec leur identifiant de session (Asia, London, NY AM, NY PM).
- Les niveaux déjà balayés/cassés restent visibles jusqu’à la bougie de cassure, avec une ligne pleine, un marqueur et le libellé « CASSÉ ».
- Les niveaux non cassés restent en pointillés avec le libellé « EN ATTENTE ».
- Le contrôle « Niveaux sessions » permet d’afficher/masquer ces lignes.
- Le moteur des sessions et les timeframes de détection M2/M3 ne sont pas modifiés par cette évolution d’affichage.

## Vérification
- Modifications limitées à l’affichage de l’historique et du graphique.
- Le build Vite doit être exécuté dans l’environnement disposant des dépendances du projet.
