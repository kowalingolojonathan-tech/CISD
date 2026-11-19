# Killzone CHoCH Desk — V6.7

## Historique détaillé et chronologique
- L'historique reste limité aux signaux M3. Les moteurs M2 et M3 et leurs notifications restent actifs.
- Chaque signal conserve la date/heure NY du sweep, du CHoCH et, si elle a eu lieu avant le CHoCH, de la première clôture de réintégration.
- Pour chaque liquidité responsable : nom de la session, HIGH/LOW, prix exact du niveau et extrême de la bougie de cassure.
- Le journal affiche le prix et l'heure du CHoCH, son niveau structurel, sa position avant/après réintégration, les biais Daily/H4 capturés au signal, le classement et le SL.
- Les événements sont horodatés à partir des bougies du flux. L'heure est donc celle de la bougie, pas une heure tick/seconde reconstruite.

## Notifications
- Notifications Android locales, push FCM et Telegram partagent désormais le résumé détaillé : date/heure, session et niveau cassé, prix de cassure, heure/prix CHoCH, état et heure/prix de réintégration, biais Daily/H4 et SL.
- Le panneau des alertes en cours dans l'application reprend la même chronologie.
- Le bouton « J'ai vu », les rappels et leur limite restent inchangés.

## Logique de trading
- Aucun changement aux règles de sweep, CHoCH, sessions, biais ou déclenchement des signaux.
- Les données de réintégration sont calculées à partir des clôtures des bougies et servent uniquement à décrire le setup.
- Le modèle actuel ne contient pas de TP ni de ratio risque/rendement : aucun TP/RR fictif n'est affiché.

## Vérification
- Tests ajoutés pour les horodatages, l'absence de réintégration et l'enregistrement de la première réintégration.
- Build et suite complète à exécuter dans un environnement avec les dépendances npm installées.
