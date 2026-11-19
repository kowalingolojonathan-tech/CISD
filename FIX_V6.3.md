# Correctif V6.3 — alertes CISD après historique et Stop Loss

## Correction
- Les alertes historiques issues du chargement/recalcul des bougies ne bloquent plus les nouvelles alertes CISD en temps réel.
- Le contrôle s'applique de façon identique aux sessions Asia, London, NY AM et NY PM.
- Les alertes live déjà envoyées conservent leur protection anti-doublon : un setup actif ou acquitté n'est pas renvoyé ; un setup invalidé par le Stop Loss peut être retenté dans sa fenêtre de 60 minutes.
- La validation de direction reste stricte : un CISD baissier doit correspondre à un sweep de sommet, un CISD haussier à un sweep de creux.
- Un nouveau sweep avec un nouvel identifiant de niveau peut ouvrir un nouveau setup après expiration de l'ancienne fenêtre.

## Tests exécutés
Réussis : `dst.test.mts`, `level-age.test.mts`, `pipeline.test.mts`, `feed.test.mts`, `localmode.test.mts`, `stoploss.test.mts`.

`push.test.mts` et le build Vite n'ont pas été exécutés dans cet environnement : les dépendances du projet (`tsx`, `vite` et types associés) n'étaient pas installées et l'installation npm a expiré.
