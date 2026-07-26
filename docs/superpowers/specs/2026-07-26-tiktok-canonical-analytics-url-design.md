# URL canonique TikTok dans les analytics — design

## Contexte

Dans la table des vidéos des analytics, le lien d'une vidéo TikTok est le champ
`share_url` renvoyé tel quel par l'API TikTok (`/v2/video/list/`). TikTok y
appose des paramètres d'attribution (`utm_campaign=tt4d_open_api` et un
`utm_source` identifiant l'app développeur). Certains opérateurs d'instance
préfèrent des URLs propres, sans tracking.

## Décision

Un paramètre global d'instance, sous forme de variable d'environnement —
le pattern existant pour la configuration globale (`TIKTOK_CLIENT_ID`, etc.).

- **Variable** : `TIKTOK_ANALYTICS_CANONICAL_URL`
- **Valeur activante** : la chaîne `"true"` exactement.
- **Défaut** (absente ou autre valeur) : comportement actuel, `share_url`
  inchangée. Zéro impact sur les instances existantes en production.

## Implémentation

Dans `libraries/nestjs-libraries/src/integrations/social/tiktok.provider.ts`,
helper `toAnalyticsVideos` — l'unique point de mapping des vidéos analytics,
partagé par `analytics()` et `videosAnalytics()` (donc la table frontend et le
job horaire sont couverts par le même changement) :

- Quand la variable vaut `"true"`, l'URL devient `video.share_url` tronquée de
  sa query string (`.split('?')[0]`).
- On tronque plutôt que de reconstruire `https://www.tiktok.com/@handle/video/<id>`
  car le handle n'est pas présent dans la réponse `video/list`, et le résultat
  est identique.

`.env.example` : ajout de la variable à côté de `TIKTOK_CLIENT_ID` /
`TIKTOK_CLIENT_SECRET`.

## Hors périmètre

- Aucune migration : les snapshots horaires ne persistent que `videoId` et
  `views`, jamais l'URL.
- Aucun changement frontend, ni d'interface générique (`AnalyticsVideo`
  inchangé) — la logique reste confinée au provider TikTok, conformément à la
  règle « pas de logique spécifique dans le code générique ».

## Vérification

Lint depuis la racine (`pnpm`). Pas de tests existants sur ce provider.
