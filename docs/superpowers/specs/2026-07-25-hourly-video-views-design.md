# Variations de vues par jour et par heure, vidéo par vidéo

**Date :** 2026-07-25
**Statut :** Approuvé
**Branche :** `feature/analytics-tiktok-youtube`

## Contexte

Le tableau « Recent Videos » livré par [`2026-07-24-per-video-analytics-design.md`](2026-07-24-per-video-analytics-design.md)
montre un compteur figé : 12 400 vues, sans dire si elles sont arrivées hier ou
il y a trois mois. Demande : voir **comment les vues évoluent, heure par heure et
jour par jour, pour chaque vidéo**, et à quels moments de la semaine l'audience
regarde.

Deux lectures, une seule collecte :

- une **courbe de croissance** par vidéo — « celle-ci décolle ou est-elle morte ? »
- une **heatmap jour × heure** au niveau du canal — « quand mon audience regarde ? »

## Faisabilité

Aucun des deux providers ne rend d'historique horaire.

- **YouTube Analytics API** expose les dimensions `day`, `month`, `video`, mais
  **pas `hour`**.
- **TikTok Display API** n'expose que des compteurs courants, sans aucune
  profondeur temporelle.

L'heure ne peut donc venir que de nos propres relevés. C'est le prolongement
direct de `IntegrationAnalytics`, qui donne déjà une histoire quotidienne aux
providers ne rendant qu'un point.

## Décisions

| Décision | Choix | Raison |
|---|---|---|
| Périmètre | Les 10 vidéos récentes du canal | Celles déjà listées dans « Recent Videos », publiées via Postiz ou non |
| Stockage | Table dédiée, compteurs cumulés | Un relevé manqué laisse un trou visible, jamais un chiffre faux |
| Variation | Calculée à la lecture | Un compteur cumulé se recale seul au relevé suivant ; un delta stocké reste faux |
| Cadence | Nouveau workflow horaire | Ne pas toucher au workflow quotidien, qui tourne peut-être déjà |
| Rétention | 28 j en horaire, quotidien sans limite | 4 mesures par case de heatmap ; au-delà, seul le relevé de minuit survit |
| Fuseau | Stockage UTC, conversion navigateur | `User.timezone` vaut `0` pour les comptes créés côté organisation |
| Emplacement | Ligne dépliable du tableau | Pas de nouvel écran, le tri existant reste intact |
| Métriques | Vues seulement | Likes et commentaires tiendraient dans la même ligne, mais personne ne les lit encore |

### Le stockage, en détail

Trois formes ont été pesées :

1. **Élargir `IntegrationAnalytics` d'une colonne `hour`.** Écarté : `postId`
   devrait porter deux sens — id de post Postiz *ou* id de vidéo provider — sur
   une colonne dont le commentaire du schéma explique justement qu'elle a été
   rendue non-nullable pour garder la clé unique propre. Et la table mélangerait
   deux granularités et deux cadences, ce qui rend la purge délicate : supprimer
   les lignes horaires sans toucher aux quotidiennes.
2. **Stocker directement les variations.** Écarté : un relevé manqué produit
   silencieusement une variation fausse, qui absorbe deux heures, et rien ne
   permet de la recalculer après coup.
3. **Table dédiée, compteurs cumulés.** Retenu.

Un job horaire *va* rater des créneaux — redémarrages, quotas, tokens expirés.
La robustesse à ces trous pèse plus que les quelques lignes de code économisées.

## Collecte

### Interface provider

`AnalyticsData.videos` porte aujourd'hui un type inline. Il est extrait en
`AnalyticsVideo` nommé, et l'interface gagne une méthode optionnelle :

```ts
videosAnalytics?(id: string, accessToken: string): Promise<AnalyticsVideo[]>;
```

Les blocs qui construisent déjà cette liste dans `youtube.provider.ts` et
`tiktok.provider.ts` y déménagent ; `analytics()` les appelle. Un seul endroit
produit la liste, et le job reste générique : il interroge
`provider.videosAnalytics` quand elle existe, sans jamais nommer un provider.

Le job n'appelle **que** `videosAnalytics`, pas `analytics()` complet. Côté
YouTube, cela évite 4 requêtes Analytics API par heure et par canal pour ne
garder que les 3 unités de Data API réellement utiles.

### Workflow

Nouveau `videoAnalyticsSnapshotWorkflow`, qui dort 1 heure, plutôt qu'une
modification de `analytics.snapshot.workflow.ts`. Ce fichier n'est pas encore
sur `origin/main` — la règle du CLAUDE.md ne l'interdit donc pas formellement —
mais s'il tourne déjà sous l'id `analytics-snapshot-workflow`, changer son code
casserait le déterminisme du run en cours. Deux workflows, deux cadences.

Nouvelle activité `captureVideoAnalyticsSnapshots()` : elle réutilise
`getIntegrationsForAnalyticsSnapshot()`, isole chaque intégration dans son
`try/catch` comme le fait déjà `captureAnalyticsSnapshots`, et purge en fin de
passage.

## Modèle

```prisma
model VideoAnalytics {
  id            String      @id @default(cuid())
  integrationId String
  videoId       String
  // Tronqué à l'heure, en UTC. La clé unique fait qu'un relevé rejoué
  // écrase la ligne au lieu de l'empiler.
  capturedAt    DateTime
  // Redondant avec capturedAt, mais Prisma ne sait pas filtrer sur l'heure
  // d'une date sans SQL brut, et la purge en a besoin.
  hour          Int
  views         Int
  createdAt     DateTime    @default(now())
  integration   Integration @relation(fields: [integrationId], references: [id])

  @@unique([integrationId, videoId, capturedAt])
  @@index([integrationId, capturedAt])
}
```

Table purement additive. Rien ne change sur les tables existantes hormis le
champ de relation côté `Integration`, qui ne crée pas de colonne : la migration
est sans risque pour les données en production.

### Purge

C'est elle qui réalise le « 28 jours en horaire, quotidien sans limite » :

```ts
deleteMany({ capturedAt: { lt: cutoff28j }, hour: { not: 0 } })
```

Au-delà de 28 jours, seul le relevé de minuit survit. On garde donc un compteur
quotidien par vidéo sans limite de durée — environ 3 600 lignes par canal et par
an — dans la même table et la même forme. Le calcul de variation ne voit pas la
différence : il diffère deux relevés consécutifs quel que soit leur espacement.

Volume en régime stable : 10 vidéos × 24 relevés × 28 jours ≈ 6 700 lignes
horaires par canal, plus le sédiment quotidien.

## Lecture

On stocke des compteurs cumulés ; la variation est une soustraction faite à la
lecture. Trois règles :

- Le **premier** relevé d'une vidéo n'a pas de prédécesseur : il porte tout
  l'historique d'avant notre suivi. Sa variation est indéfinie, la ligne est
  écartée — sinon la courbe démarre sur un pic de 12 000 vues qui n'a jamais eu
  lieu.
- Un compteur peut **baisser** — suppression de spam, vidéo dépubliée. Une
  variation négative est ramenée à 0.
- Un relevé manqué laisse un trou de plusieurs heures. La variation qui
  l'enjambe est répartie à parts égales sur les heures couvertes, plutôt que
  concentrée sur la dernière.

### Heatmap du canal

Nouveau mode sur `AnalyticsData`, exclusif avec `data`, `breakdown` et `videos` —
une métrique porte une série, un classement, une liste ou une grille, jamais
deux :

```ts
/**
 * Vues gagnées heure par heure, agrégées sur les vidéos suivies. Le client en
 * fait une grille jour × heure dans son propre fuseau.
 */
hourly?: Array<{ at: string; value: number }>;  // `at` : heure ISO en UTC
```

28 jours × 24 heures = 672 points, environ 20 Ko. Injectée dans
`checkAnalytics`, pas dans `enrichAnalytics` : cette dernière est aussi appelée
par le job de snapshot, qui n'a que faire d'une heatmap.

La série brute part au client plutôt que la grille toute faite. C'est ce qui
garde le résultat exact pour les fuseaux décalés d'une demi-heure, là où une
rotation d'axe côté serveur ne le serait pas.

### Courbe par vidéo

Chargée seulement au dépliage de la ligne :

```
GET /analytics/:integration/videos/:videoId
```

Trois segments : aucun conflit avec le `@Get('/:integration')` existant.
Traversée complète des couches — Controller → IntegrationService, qui contrôle
l'appartenance à l'organisation → IntegrationRepository. Renvoie la série
horaire de cette vidéo. Le basculement heure/jour est un regroupement côté
client sur la même charge utile, pas un second appel.

## Rendu

Dans `render.analytics.tsx` :

- Une ligne de `VideoTable` devient cliquable et déplie un `<tr>` supplémentaire
  sur toute la largeur. Une seule vidéo ouverte à la fois. Le tri existant n'y
  touche pas.
- Un composant `VideoHistory` avec **son propre hook SWR** (`useVideoHistory`),
  conforme à la règle rules-of-hooks du CLAUDE.md, plus le sélecteur
  `[Heure] [Jour]`.
- Un composant `HeatmapGrid` pour le mode `hourly`, en `col-span-full` comme le
  tableau.

### Ce que `ChartSocial` impose

`chart-social.tsx` écrase toute série de plus de 7 points en 7 paquets
(`mergeDataPoints(data, 7)`), axes masqués. Une courbe horaire passée telle
quelle y serait illisible. Il reçoit donc une prop optionnelle
`points?: number`, à 7 par défaut — rétrocompatible pour tous ses appelants
actuels — pour qu'une courbe de 72 points ne soit pas réduite en bouillie.

Son `useEffect` a par ailleurs un tableau de dépendances vide : le graphe est
construit une fois et ne réagit pas aux changements de `data`. Le basculement
heure/jour le remonte via `key`, comme le fait déjà l'appelant existant avec
`key={chart-${index}}`.

## Risques

- **Une vidéo qui sort du top 10 cesse d'être suivie.** Sa courbe s'arrête là,
  sans rattrapage quand elle revient.
- **La première semaine est creuse.** Tout ce qui s'affiche vient de nos
  relevés : la heatmap ne devient honnête qu'au bout de ~4 semaines, et une
  vidéo publiée avant la mise en service n'aura jamais sa courbe de démarrage.
- **Quota YouTube** : 3 unités par heure et par canal, soit 72 par jour contre
  un plafond de 10 000. Négligeable par canal, mais multiplié par le nombre de
  canaux d'une instance.
- **Charge du job horaire.** Il balaie toutes les intégrations sociales saines à
  chaque heure, là où le job existant le fait une fois par jour. L'isolation par
  intégration évite qu'une seule panne arrête le balayage, mais le temps total
  croît avec le nombre de canaux.

## Fichiers

| Fichier | Nature |
|---|---|
| `schema.prisma` | Modèle `VideoAnalytics` + relation sur `Integration` |
| `social.integrations.interface.ts` | `AnalyticsVideo`, `videosAnalytics`, mode `hourly` |
| `youtube.provider.ts` | Extraction de la liste vers `videosAnalytics` |
| `tiktok.provider.ts` | Extraction de la liste vers `videosAnalytics` |
| `integration.repository.ts` | Écriture, lecture et purge des relevés |
| `integration.service.ts` | Variations, heatmap dans `checkAnalytics`, balayage horaire |
| `analytics.controller.ts` | `GET /analytics/:integration/videos/:videoId` |
| `integrations.activity.ts` | `captureVideoAnalyticsSnapshots` |
| `video.analytics.snapshot.workflow.ts` | Nouveau workflow horaire |
| `infinite.workflow.register.ts` | Enregistrement du nouveau workflow |
| `chart-social.tsx` | Prop `points` |
| `render.analytics.tsx` | Ligne dépliable, `VideoHistory`, `HeatmapGrid` |

## Hors périmètre

- **Likes et commentaires.** Ils arrivent dans la même réponse provider et
  tiendraient dans la même ligne, mais la demande porte sur les vues. Les
  ajouter plus tard, c'est deux colonnes, pas une refonte.
- **Les autres providers.** La collecte est générique : tout provider
  implémentant `videosAnalytics` est suivi. Aucun autre ne l'implémente ici.
- **Comparer deux vidéos sur un même graphe.**
