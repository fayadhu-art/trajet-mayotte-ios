# Trajet Mayotte

Appli de trajet maison–travail à Mayotte, toujours reliée à Internet :

- heure de départ conseillée d'après ton heure de service ;
- chrono par étapes (barge, taxi…) ;
- carte avec ta position GPS, le tracé parcouru et l'avancement sur l'itinéraire ;
- signalements partagés ;
- veille route et barge, et itinéraires calculés en ligne ;
- statistiques, historique et export CSV.

L'écran de l'iPhone reste allumé tant que l'appli est ouverte.

Cette appli réunit la version en ligne (https://trajet-mayotte.web.app) et l'ancienne version iPhone autonome.

## Installer avec Sideloadly

1. Ouvre l'onglet **Releases** du dépôt et télécharge le dernier `TrajetMayotte.ipa`.
2. Ouvre Sideloadly, branche l'iPhone et glisse `TrajetMayotte.ipa` dans la fenêtre.
3. Réinstalle toujours par-dessus l'ancienne version : tes trajets restent dans ton carnet en ligne.

## Fabrication

Chaque envoi sur `main` déclenche GitHub Actions, qui :

1. construit la page avec Vite ;
2. crée le projet iOS avec Capacitor ;
3. compile, puis publie `TrajetMayotte.ipa` dans les Releases.

La même page est publiée sur Firebase Hosting.
