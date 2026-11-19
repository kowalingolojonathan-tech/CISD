# CISD V6.4 — séquencement des sweeps et probabilité D1/H4

## Correction de la logique de retournement
- Un CISD ne peut utiliser que des sweeps correspondants à sa direction : sweep d'un plus bas → bullish ; sweep d'un plus haut → bearish.
- Les sweeps déjà utilisés avant la dernière alerte live sont consommés et ne peuvent plus justifier un nouveau CISD.
- Après un Stop Loss, la surveillance reste verrouillée sur la direction du setup invalidé pendant 60 minutes.
- Pendant cette fenêtre, un nouveau sweep du bon côté suivi d'un nouveau CISD peut déclencher une nouvelle alerte, y compris si le même niveau source est balayé à nouveau.
- Un CISD opposé pendant cette fenêtre est ignoré.
- Après expiration des 60 minutes, un sweep réellement nouveau, postérieur à l'expiration, est obligatoire pour repartir.
- Les alertes historiques/backfill n'interfèrent pas avec le séquencement live.

## Probabilité D1/H4
La classification existante est conservée :
- D1 et H4 alignés avec le signal : HIGH.
- Un seul des deux aligné : MEDIUM.
- D1 et H4 contraires au signal : COUNTER_TREND.

Aucune catégorie de probabilité ne supprime le signal : les signaux contraires restent visibles et notifiables si leur sweep et leur CISD sont valides.

## Vérification
Les tests ont été étendus pour couvrir les sweeps répétés du même niveau source, le verrouillage directionnel après SL, l'expiration de la fenêtre, les sessions et les trois niveaux de probabilité. Exécution locale des tests/build non effectuée dans l'environnement de préparation car les dépendances npm du projet ne sont pas installées.
