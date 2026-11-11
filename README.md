# Trajet (Mayotte) : version autonome pour iPhone

Appli de trajet maison-travail à Mayotte, pour n'importe quels villages : heure de départ conseillée,
chrono par étapes, statistiques, historique et export. Cette version fonctionne sans réseau et garde
toutes les données sur le téléphone.

## Installer avec Sideloadly

1. Ouvre l'onglet **Releases** du dépôt et télécharge le dernier `Trajet.ipa`.
2. Sur ton ordinateur, ouvre Sideloadly, branche l'iPhone, glisse `Trajet.ipa` dans la fenêtre.
3. Saisis ton identifiant Apple et lance l'installation.
4. Sur l'iPhone : Réglages > Général > VPN et gestion de l'appareil, puis fais confiance à ton identifiant.
   Sur iOS 16 et plus, active aussi le mode développeur si l'iPhone le demande.

Avec un identifiant Apple gratuit, l'appli doit être réinstallée tous les 7 jours. Réinstalle par-dessus
l'ancienne, sans la supprimer : la supprimer efface les trajets. Exporte tes trajets de temps en temps
(Réglages, en bas de l'appli).

## Ce que cette version ne fait pas

Sans Claude, il n'y a ni calcul d'itinéraires en ligne, ni veille route et barge, ni signalements
partagés, ni conseil rédigé. Tu saisis toi-même tes itinéraires (nom, durée, villages traversés).

## Mettre à jour l'appli

- `source/trajet.html` : la page de l'appli, la même que la version en ligne.
- `outils/carnet-local.js` : le stockage sur le téléphone.
- `outils/construire.py` : assemble `www/index.html`.

Chaque envoi sur la branche `main` refabrique `Trajet.ipa` (GitHub Actions, sur Mac) et le publie
dans les Releases.
