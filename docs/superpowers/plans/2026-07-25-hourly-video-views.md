# Variations de vues par heure et par jour — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Relever chaque heure le compteur de vues des 10 vidéos récentes de chaque canal, et en tirer une courbe de croissance par vidéo plus une heatmap jour × heure au niveau du canal.

**Architecture:** Un workflow Temporal horaire interroge `videosAnalytics` sur les providers qui l'implémentent et écrit un compteur cumulé par vidéo et par heure dans une table dédiée `VideoAnalytics`. La variation n'est jamais stockée : elle est calculée à la lecture en différenciant deux relevés consécutifs, ce qui rend un relevé manqué visible plutôt que faux. Le client reçoit une série horaire brute en UTC et la range lui-même en grille jour × heure dans son propre fuseau.

**Tech Stack:** NestJS, Prisma 6.5, Temporal (`nestjs-temporal-core`), React + Vite, SWR, Tailwind 3, Chart.js.

**Spec:** [`docs/superpowers/specs/2026-07-25-hourly-video-views-design.md`](../specs/2026-07-25-hourly-video-views-design.md)

## Global Constraints

- **pnpm uniquement.** Jamais npm ni yarn.
- **Jamais de SQL brut.** Tout passe par Prisma.
- **Trois couches sans raccourci :** DTO → Controller → Service → Repository. La logique serveur vit dans `libraries/nestjs-libraries`, le backend ne porte que les controllers.
- **Le code doit rester générique.** Aucun `if (provider === 'youtube')` dans un fichier générique : on étend l'interface du provider et on appelle la méthode.
- **Pas de migration Prisma.** Le dépôt n'a pas de dossier `migrations` : le schéma est appliqué par `pnpm run prisma-db-push`, et les types sont régénérés par `pnpm run prisma-generate`.
- **Aucun composant frontend depuis npmjs.** Composants natifs uniquement.
- **Tailwind 3.** Les couleurs viennent de `apps/frontend/src/app/colors.scss` ; les `--color-custom*` sont dépréciés. Les classes déjà utilisées dans `render.analytics.tsx` (`newTableHeader`, `newTableBorder`, `newTableText`, `#612bd3`) sont la référence.
- **Un hook SWR = un `useSWR`,** conforme à `react-hooks/rules-of-hooks`. Jamais de `eslint-disable-next-line` dessus.
- **Les workflows déjà sur `origin/main` ne se modifient pas.** On en crée un nouveau. `analytics.snapshot.workflow.ts` n'est pas sur `origin/main` mais tourne peut-être déjà : on n'y touche pas non plus.
- **Production avec des utilisateurs réels.** Toute évolution de schéma doit être additive.

## Vérification

Le dépôt n'a **aucun test qui s'exécute** : le `jest.config.ts` racine délègue à `getJestProjects()` de Nx, aucun projet n'a de config jest, et il n'existe pas un seul `.spec.ts`. Décision prise : on vérifie par la compilation et par l'écran, sans monter d'infrastructure de test.

Ce que cela laisse **non vérifié**, et qu'il faut donc relire à l'œil avec attention à la Task 4 : l'écartement du premier relevé, l'étalement d'une variation sur un trou, et le plancher à zéro sur un compteur qui baisse. Aucun de ces trois cas ne se voit à l'écran avant plusieurs jours de collecte.

Commandes de vérification utilisées dans ce plan :

| Commande | Ce qu'elle couvre |
|---|---|
| `pnpm run prisma-generate` | Régénère le client Prisma après une évolution du schéma |
| `pnpm run build:backend` | Compile le backend et, par transitivité, `libraries/nestjs-libraries` |
| `pnpm run build:orchestrator` | Compile les workflows et activités Temporal |
| `pnpm run build:frontend` | Compile le frontend Vite |

`pnpm run prisma-db-push` demande une base accessible ; il n'est nécessaire que pour faire tourner l'application, pas pour compiler.

## Structure des fichiers

| Fichier | Responsabilité | Task |
|---|---|---|
| `libraries/nestjs-libraries/src/database/prisma/schema.prisma` | Modèle `VideoAnalytics` + relation sur `Integration` | 1 |
| `.../prisma/integrations/integration.repository.ts` | Écriture, lecture et purge des relevés | 1 |
| `.../integrations/social/social.integrations.interface.ts` | `AnalyticsVideo`, `videosAnalytics`, mode `hourly` | 2 |
| `.../integrations/social/youtube.provider.ts` | Liste des vidéos extraite en `videosAnalytics` | 2 |
| `.../integrations/social/tiktok.provider.ts` | Liste des vidéos extraite en `videosAnalytics` | 2 |
| `.../prisma/integrations/integration.service.ts` | Balayage horaire, calcul des variations, heatmap | 3, 4, 5 |
| `apps/orchestrator/src/activities/integrations.activity.ts` | Activité `captureVideoAnalyticsSnapshots` | 3 |
| `apps/orchestrator/src/workflows/video.analytics.snapshot.workflow.ts` | **Créé** — workflow horaire | 3 |
| `apps/orchestrator/src/workflows/index.ts` | Export du workflow | 3 |
| `.../src/temporal/infinite.workflow.register.ts` | Démarrage du workflow | 3 |
| `apps/backend/src/api/routes/analytics.controller.ts` | `GET /analytics/:integration/videos/:videoId` | 5 |
| `apps/frontend/src/components/analytics/chart-social.tsx` | Prop `points` | 6 |
| `apps/frontend/src/components/platform-analytics/video.table.tsx` | **Créé** — tableau, ligne dépliable, courbe | 7 |
| `apps/frontend/src/components/platform-analytics/heatmap.grid.tsx` | **Créé** — grille jour × heure | 8 |
| `apps/frontend/src/components/platform-analytics/render.analytics.tsx` | Câblage des trois modes | 7, 8 |

`render.analytics.tsx` fait déjà 455 lignes. Le tableau et la heatmap partent donc dans leurs propres fichiers plutôt que de la gonfler encore : c'est une amélioration ciblée du fichier qu'on modifie, pas un refactoring opportuniste.

---

### Task 1: Modèle `VideoAnalytics` et accès repository

**Files:**
- Modify: `libraries/nestjs-libraries/src/database/prisma/schema.prisma` (modèle `Integration` ~ligne 341, fin de fichier)
- Modify: `libraries/nestjs-libraries/src/database/prisma/integrations/integration.repository.ts:16-24` (constructeur) et à la suite de `getAnalyticsHistory`

**Interfaces:**
- Consumes: rien.
- Produces:
  - `saveVideoSnapshots(integrationId: string, capturedAt: Date, hour: number, videos: { videoId: string; views: number }[]): Promise<unknown>`
  - `getVideoSnapshots(integrationId: string, since: Date, videoId?: string): Promise<{ videoId: string; capturedAt: Date; views: number }[]>`
  - `purgeVideoSnapshots(before: Date): Promise<{ count: number }>`

- [ ] **Step 1: Ajouter le champ de relation au modèle `Integration`**

Dans `schema.prisma`, sous la ligne `analyticsHistory        IntegrationAnalytics[]` du modèle `Integration` :

```prisma
  videoAnalytics        VideoAnalytics[]
```

- [ ] **Step 2: Ajouter le modèle `VideoAnalytics` en fin de `schema.prisma`**

À la suite du modèle `IntegrationAnalytics` :

```prisma
// Hourly readings of the view counter of a tracked video.
//
// Neither the YouTube Analytics API nor TikTok's Display API exposes an hourly
// history, so the only way to know when views arrived is to keep asking. What
// is stored is the counter as the provider gives it, never the variation: a
// cumulative counter re-syncs itself on the next reading, where a stored delta
// would stay wrong forever once a run is missed.
model VideoAnalytics {
  id            String      @id @default(cuid())
  integrationId String
  videoId       String
  // Truncated to the hour, in UTC. The unique key makes a replayed reading
  // overwrite the row instead of piling up.
  capturedAt    DateTime
  // Redundant with capturedAt, but Prisma cannot filter on the hour part of a
  // date without raw SQL, and the purge needs exactly that.
  hour          Int
  views         Int
  createdAt     DateTime    @default(now())
  integration   Integration @relation(fields: [integrationId], references: [id])

  @@unique([integrationId, videoId, capturedAt])
  @@index([integrationId, capturedAt])
}
```

- [ ] **Step 3: Régénérer le client Prisma**

Run: `pnpm run prisma-generate`
Expected: `Generated Prisma Client` sans erreur. Si la relation est incomplète, Prisma échoue ici avec `Error validating field`.

- [ ] **Step 4: Injecter le repository Prisma**

Dans `integration.repository.ts`, ajouter un paramètre au constructeur, après `private _analyticsHistory: PrismaRepository<'integrationAnalytics'>` :

```ts
    private _videoAnalytics: PrismaRepository<'videoAnalytics'>
```

Attention à la virgule sur la ligne précédente. Aucun enregistrement de module n'est nécessaire : `PrismaRepository<T extends keyof PrismaService>` est générique, c'est déjà ainsi que `_analyticsHistory` est fourni.

- [ ] **Step 5: Ajouter les trois méthodes d'accès**

Dans `integration.repository.ts`, juste après `getAnalyticsHistory` :

```ts
  /**
   * One reading per video per hour. A replayed run lands on the same row and
   * overwrites it, so a retry never inflates the history.
   */
  saveVideoSnapshots(
    integrationId: string,
    capturedAt: Date,
    hour: number,
    videos: { videoId: string; views: number }[]
  ) {
    return Promise.all(
      videos.map(({ videoId, views }) =>
        this._videoAnalytics.model.videoAnalytics.upsert({
          where: {
            integrationId_videoId_capturedAt: {
              integrationId,
              videoId,
              capturedAt,
            },
          },
          create: { integrationId, videoId, capturedAt, hour, views },
          update: { views },
        })
      )
    );
  }

  /**
   * Ordered by video then by time: the variation is a subtraction between two
   * consecutive readings of the same video, so the caller relies on that order.
   */
  getVideoSnapshots(integrationId: string, since: Date, videoId?: string) {
    return this._videoAnalytics.model.videoAnalytics.findMany({
      where: {
        integrationId,
        capturedAt: { gte: since },
        ...(videoId ? { videoId } : {}),
      },
      orderBy: [{ videoId: 'asc' }, { capturedAt: 'asc' }],
      select: { videoId: true, capturedAt: true, views: true },
    });
  }

  /**
   * Past the cutoff only the midnight reading survives, which leaves an
   * unbounded daily history at one row per video per day. The variation logic
   * does not notice: it differences consecutive readings whatever their spacing.
   */
  purgeVideoSnapshots(before: Date) {
    return this._videoAnalytics.model.videoAnalytics.deleteMany({
      where: { capturedAt: { lt: before }, hour: { not: 0 } },
    });
  }
```

- [ ] **Step 6: Compiler**

Run: `pnpm run build:backend`
Expected: build réussi. Une erreur `Property 'videoAnalytics' does not exist` signifie que le Step 3 n'a pas été relancé.

- [ ] **Step 7: Commit**

```bash
git add libraries/nestjs-libraries/src/database/prisma/schema.prisma \
        libraries/nestjs-libraries/src/database/prisma/integrations/integration.repository.ts
git commit -m "feat(analytics): store hourly view counters per video"
```

---

### Task 2: `videosAnalytics` sur l'interface et les deux providers

Le but est qu'un seul endroit produise la liste des vidéos, et que le job horaire puisse l'obtenir **sans** déclencher tout `analytics()` — côté YouTube, cela économise 4 requêtes Analytics API par heure et par canal.

**Files:**
- Modify: `libraries/nestjs-libraries/src/integrations/social/social.integrations.interface.ts:53-89`
- Modify: `libraries/nestjs-libraries/src/integrations/social/youtube.provider.ts:703-757`
- Modify: `libraries/nestjs-libraries/src/integrations/social/tiktok.provider.ts:987-1006`

**Interfaces:**
- Consumes: rien.
- Produces:
  - `type AnalyticsVideo = { id: string; title: string; url?: string; thumbnail?: string; date: string; views: number; likes: number; comments: number }`
  - `ISocialMediaIntegration.videosAnalytics?(id: string, accessToken: string): Promise<AnalyticsVideo[]>`
  - `AnalyticsData.hourly?: Array<{ at: string; value: number }>`

- [ ] **Step 1: Extraire `AnalyticsVideo` et ajouter le mode `hourly`**

Dans `social.integrations.interface.ts`, au-dessus de `export interface AnalyticsData {` :

```ts
/**
 * One row of the per-video table. Named rather than inlined because the hourly
 * snapshot job consumes it directly, without going through AnalyticsData.
 */
export type AnalyticsVideo = {
  id: string;
  title: string;
  url?: string;
  thumbnail?: string;
  date: string;
  views: number;
  likes: number;
  comments: number;
};
```

Puis, dans `AnalyticsData`, remplacer le bloc `videos?: Array<{ ... }>;` par :

```ts
  /**
   * Per-video rows rather than an aggregate. Mutually exclusive with `data`,
   * `breakdown` and `hourly`: a metric carries a series, a ranking, a list or a
   * grid, never two.
   */
  videos?: AnalyticsVideo[];
  /**
   * Views gained hour by hour, summed over the tracked videos. The client turns
   * it into a day-by-hour grid in its own timezone — which is why the raw
   * series travels rather than a ready-made grid: a server-side axis rotation
   * would be wrong for the timezones offset by half an hour.
   */
  hourly?: Array<{ at: string; value: number }>;
```

- [ ] **Step 2: Déclarer `videosAnalytics` sur l'interface du provider**

Toujours dans `social.integrations.interface.ts`, dans `ISocialMediaIntegration`, juste sous la déclaration de `analytics?` :

```ts
  /**
   * The per-video rows on their own. The hourly snapshot job calls this instead
   * of `analytics`, which would drag along aggregate queries it has no use for.
   */
  videosAnalytics?(id: string, accessToken: string): Promise<AnalyticsVideo[]>;
```

Si le nom exact de l'interface diffère, le repère est la ligne qui déclare `analytics?(` : `videosAnalytics` se place immédiatement en dessous.

- [ ] **Step 3: Extraire la liste YouTube**

Dans `youtube.provider.ts`, ajouter cette méthode **avant** `async analytics(`, et importer `AnalyticsVideo` depuis `social.integrations.interface` :

```ts
  /**
   * Going through the channel's uploads playlist costs one quota unit per call,
   * where search.list would cost a hundred for the same list.
   */
  async videosAnalytics(
    id: string,
    accessToken: string
  ): Promise<AnalyticsVideo[]> {
    try {
      const { client, youtube } = clientAndYoutube();
      client.setCredentials({ access_token: accessToken });
      const dataClient = youtube(client);

      const { data: channel } = await dataClient.channels.list({
        part: ['contentDetails'],
        mine: true,
      });

      const uploads =
        channel?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;

      if (!uploads) {
        return [];
      }

      const { data: items } = await dataClient.playlistItems.list({
        part: ['contentDetails'],
        playlistId: uploads,
        maxResults: 10,
      });

      const ids = (items?.items || [])
        .map((i) => i?.contentDetails?.videoId)
        .filter(Boolean) as string[];

      if (!ids.length) {
        return [];
      }

      const { data: details } = await dataClient.videos.list({
        part: ['snippet', 'statistics'],
        id: ids,
      });

      return (details?.items || []).map((video) => ({
        id: String(video.id),
        title: video.snippet?.title || 'Untitled',
        url: `https://www.youtube.com/watch?v=${video.id}`,
        thumbnail:
          video.snippet?.thumbnails?.medium?.url ||
          video.snippet?.thumbnails?.default?.url ||
          undefined,
        date: video.snippet?.publishedAt || '',
        // Counters are hidden on some videos; treat a missing one as 0 rather
        // than dropping the row.
        views: Number(video.statistics?.viewCount) || 0,
        likes: Number(video.statistics?.likeCount) || 0,
        comments: Number(video.statistics?.commentCount) || 0,
      }));
    } catch (e) {
      return [];
    }
  }
```

- [ ] **Step 4: Faire appeler `videosAnalytics` par `analytics()` côté YouTube**

Dans `youtube.provider.ts`, remplacer intégralement le bloc `try { ... } catch (e) { ... }` des lignes 703-757 (celui commenté « Per-video rows ») par :

```ts
      // The channel-level metrics are worth showing even without the list, and
      // videosAnalytics already swallows its own failures.
      const videos = await this.videosAnalytics(id, accessToken);
      if (videos.length) {
        acc.push({ label: 'Recent Videos', data: [], videos });
      }
```

- [ ] **Step 5: Extraire la liste TikTok**

Dans `tiktok.provider.ts`, ajouter cette méthode **avant** `async analytics(`, et importer `AnalyticsVideo` :

```ts
  /**
   * One call is enough: video/list returns the statistics alongside the ids.
   */
  async videosAnalytics(
    id: string,
    accessToken: string
  ): Promise<AnalyticsVideo[]> {
    try {
      const videoListResponse = await fetch(
        'https://open.tiktokapis.com/v2/video/list/?fields=id,title,cover_image_url,share_url,create_time,view_count,like_count,comment_count,share_count',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ max_count: 20 }),
        }
      );

      const videoListData = await videoListResponse.json();
      const videos = videoListData?.data?.videos;

      if (!videos?.length) {
        return [];
      }

      return [...videos]
        .sort((a: any, b: any) => (b.create_time || 0) - (a.create_time || 0))
        .slice(0, 10)
        .map((video: any) => ({
          id: String(video.id),
          title: video.title || 'Untitled',
          url: video.share_url,
          thumbnail: video.cover_image_url,
          // TikTok hands back seconds since epoch, not milliseconds.
          date: new Date((video.create_time || 0) * 1000).toISOString(),
          views: video.view_count || 0,
          likes: video.like_count || 0,
          comments: video.comment_count || 0,
        }));
    } catch (e) {
      return [];
    }
  }
```

- [ ] **Step 6: Faire appeler `videosAnalytics` par `analytics()` côté TikTok**

Dans `tiktok.provider.ts`, remplacer le `result.push({ label: 'Recent Videos', ... })` des lignes 987-1006 par :

```ts
        const videos = await this.videosAnalytics(id, accessToken);
        if (videos.length) {
          result.push({ label: 'Recent Videos', data: [], videos });
        }
```

**Attention :** cela ajoute un second appel à `video/list` par lecture d'analytics TikTok, alors que le commit `6e0f394` avait justement fusionné les deux. C'est le prix de la généricité — la même liste doit être joignable sans passer par `analytics()`. Les agrégats des lignes 924-985 continuent d'utiliser `videoDetails`, la variable issue du premier appel, et **ne doivent pas être touchés** : leurs totaux doivent rester identiques, y compris le libellé dynamique `(last N videos)`.

- [ ] **Step 7: Compiler**

Run: `pnpm run build:backend`
Expected: build réussi.

- [ ] **Step 8: Commit**

```bash
git add libraries/nestjs-libraries/src/integrations/social/social.integrations.interface.ts \
        libraries/nestjs-libraries/src/integrations/social/youtube.provider.ts \
        libraries/nestjs-libraries/src/integrations/social/tiktok.provider.ts
git commit -m "feat(analytics): expose the video list as its own provider method"
```

---

### Task 3: Balayage horaire — service, activité, workflow

**Files:**
- Modify: `libraries/nestjs-libraries/src/database/prisma/integrations/integration.service.ts` (constantes en tête, méthode après `captureAnalyticsSnapshots`)
- Modify: `apps/orchestrator/src/activities/integrations.activity.ts:20-23`
- Create: `apps/orchestrator/src/workflows/video.analytics.snapshot.workflow.ts`
- Modify: `apps/orchestrator/src/workflows/index.ts`
- Modify: `libraries/nestjs-libraries/src/temporal/infinite.workflow.register.ts:18-26`

**Interfaces:**
- Consumes: `saveVideoSnapshots`, `purgeVideoSnapshots` (Task 1) ; `videosAnalytics` (Task 2).
- Produces:
  - `IntegrationService.captureVideoAnalyticsSnapshots(): Promise<void>`
  - `IntegrationsActivity.captureVideoAnalyticsSnapshots()`
  - `videoAnalyticsSnapshotWorkflow()`

- [ ] **Step 1: Ajouter les constantes de fenêtre**

Dans `integration.service.ts`, sous la constante `SNAPSHOT_WINDOW_DAYS` existante :

```ts
/**
 * Past this, only the midnight reading of each video survives the purge. Four
 * weeks is what makes the day-by-hour grid readable: it puts four measurements
 * in each of its 168 cells, where two would let a single viral evening pass for
 * a habit.
 */
const HOURLY_RETENTION_DAYS = 28;
```

- [ ] **Step 2: Écrire le balayage**

Dans `integration.service.ts`, juste après la méthode `captureAnalyticsSnapshots()` :

```ts
  /**
   * Records the view counter of every tracked video, once an hour.
   *
   * Providers expose no hourly history at all, so this sweep is the only source
   * of the growth curve and of the day-by-hour grid. It calls `videosAnalytics`
   * rather than `analytics`, which would drag along aggregate queries nobody
   * reads here.
   *
   * One failing integration — expired token, provider outage — must not stop
   * the sweep, so each is isolated.
   */
  async captureVideoAnalyticsSnapshots() {
    const integrations =
      await this._integrationRepository.getIntegrationsForAnalyticsSnapshot();

    // Every video of this run lands on the same hour, so a retry overwrites the
    // same rows instead of scattering readings a few minutes apart.
    const capturedAt = dayjs().utc().startOf('hour');

    for (const integration of integrations) {
      try {
        const provider = this._integrationManager.getSocialIntegration(
          integration.providerIdentifier
        );

        if (!provider?.videosAnalytics) {
          continue;
        }

        const videos = await provider.videosAnalytics(
          integration.internalId,
          integration.token
        );

        if (!videos?.length) {
          continue;
        }

        await this._integrationRepository.saveVideoSnapshots(
          integration.id,
          capturedAt.toDate(),
          capturedAt.hour(),
          videos.map((video) => ({ videoId: video.id, views: video.views }))
        );
      } catch (e) {
        // Nothing to do: the next hour picks it up again.
      }
    }

    await this._integrationRepository.purgeVideoSnapshots(
      dayjs().utc().subtract(HOURLY_RETENTION_DAYS, 'day').toDate()
    );
  }
```

`dayjs.extend(utc)` est déjà appelé en tête de ce fichier, aucun import supplémentaire n'est nécessaire.

- [ ] **Step 3: Exposer l'activité Temporal**

Dans `integrations.activity.ts`, juste après la méthode `captureAnalyticsSnapshots` :

```ts
  @ActivityMethod()
  async captureVideoAnalyticsSnapshots() {
    return this._integrationService.captureVideoAnalyticsSnapshots();
  }
```

- [ ] **Step 4: Créer le workflow horaire**

Créer `apps/orchestrator/src/workflows/video.analytics.snapshot.workflow.ts` :

```ts
import { proxyActivities, sleep } from '@temporalio/workflow';
import { IntegrationsActivity } from '@gitroom/orchestrator/activities/integrations.activity';

const { captureVideoAnalyticsSnapshots } = proxyActivities<IntegrationsActivity>(
  {
    startToCloseTimeout: '30 minute',
    retry: {
      maximumAttempts: 3,
      backoffCoefficient: 1,
      initialInterval: '5 minutes',
    },
  }
);

/**
 * Records the view counter of every tracked video, once an hour.
 *
 * Separate from analyticsSnapshotWorkflow rather than folded into it: that one
 * is keyed by date, so running it hourly would only overwrite the same row, and
 * amending a workflow that may already be running would break the determinism
 * of its live execution.
 */
export async function videoAnalyticsSnapshotWorkflow() {
  await captureVideoAnalyticsSnapshots();
  while (true) {
    await sleep('1 hour');
    await captureVideoAnalyticsSnapshots();
  }
}
```

- [ ] **Step 5: Exporter le workflow**

Dans `apps/orchestrator/src/workflows/index.ts`, ajouter à la suite de la ligne qui exporte `analytics.snapshot.workflow` :

```ts
export * from './video.analytics.snapshot.workflow';
```

Si le fichier utilise une autre forme d'export, reproduire celle de `analytics.snapshot.workflow` à l'identique.

- [ ] **Step 6: Démarrer le workflow**

Dans `infinite.workflow.register.ts`, à la suite du bloc `try` qui démarre `analyticsSnapshotWorkflow` :

```ts
      try {
        await this._temporalService.client
          ?.getRawClient()
          ?.workflow?.start('videoAnalyticsSnapshotWorkflow', {
            workflowId: 'video-analytics-snapshot-workflow',
            taskQueue: 'main',
          });
      } catch (err) {}
```

Le `workflowId` doit être **différent** de `analytics-snapshot-workflow`, sans quoi le démarrage est silencieusement ignoré comme doublon.

- [ ] **Step 7: Compiler les deux applications concernées**

Run: `pnpm run build:backend && pnpm run build:orchestrator`
Expected: les deux builds réussissent.

- [ ] **Step 8: Commit**

```bash
git add libraries/nestjs-libraries/src/database/prisma/integrations/integration.service.ts \
        libraries/nestjs-libraries/src/temporal/infinite.workflow.register.ts \
        apps/orchestrator/src/activities/integrations.activity.ts \
        apps/orchestrator/src/workflows/video.analytics.snapshot.workflow.ts \
        apps/orchestrator/src/workflows/index.ts
git commit -m "feat(analytics): hourly sweep recording per-video view counters"
```

---

### Task 4: Variations et heatmap du canal

C'est la tâche la plus délicate du plan, et celle qu'aucune vérification automatique ne couvre. À relire posément.

**Files:**
- Modify: `libraries/nestjs-libraries/src/database/prisma/integrations/integration.service.ts` (helper de module près de `withPercentageChange`, méthode privée, appel dans `checkAnalytics:546-571`)

**Interfaces:**
- Consumes: `getVideoSnapshots` (Task 1) ; `AnalyticsData.hourly` (Task 2).
- Produces:
  - `toHourlyDeltas(snapshots: { capturedAt: Date; views: number }[]): Array<{ at: string; value: number }>` — helper de module, non exporté
  - `IntegrationService.viewsHeatmap(integrationId: string): Promise<Array<{ at: string; value: number }>>` — privée

- [ ] **Step 1: Écrire le calcul des variations**

Dans `integration.service.ts`, juste après la constante `withPercentageChange` — même emplacement et même forme, ce fichier place déjà ses helpers de calcul au niveau du module plutôt que dans un fichier d'algorithmes séparé :

```ts
/**
 * Turns cumulative view counters into what was gained between two readings.
 *
 * Three cases the stored counters cannot express on their own:
 *
 * - The **first** reading has no predecessor. It carries every view the video
 *   collected before we started watching it, so it is dropped rather than drawn
 *   as a spike of twelve thousand views that never happened.
 * - A counter can **go down** — spam removal, a video pulled offline. A negative
 *   gain means nothing here, so it is floored at zero.
 * - A **missed run** leaves a gap of several hours. The gain straddling it is
 *   spread evenly over the hours it covers, instead of landing entirely on the
 *   hour the job came back and inventing a peak there.
 *
 * That spreading is a smoothing, not a measurement: if the sweep skipped a
 * night, the grid will show activity at 4am that nobody actually produced.
 */
const toHourlyDeltas = (
  snapshots: { capturedAt: Date; views: number }[]
): Array<{ at: string; value: number }> => {
  const points: Array<{ at: string; value: number }> = [];

  for (let i = 1; i < snapshots.length; i++) {
    const previous = snapshots[i - 1];
    const current = snapshots[i];

    const hours = Math.max(
      1,
      Math.round(
        (current.capturedAt.getTime() - previous.capturedAt.getTime()) / 3600000
      )
    );
    const perHour = Math.max(0, current.views - previous.views) / hours;

    // Walked backwards from `current`, so the gain is credited to the hours
    // that follow `previous` up to and including `current`.
    for (let hour = hours; hour > 0; hour--) {
      points.push({
        at: new Date(
          current.capturedAt.getTime() - (hour - 1) * 3600000
        ).toISOString(),
        value: Math.round(perHour),
      });
    }
  }

  return points;
};
```

- [ ] **Step 2: Écrire l'agrégation en heatmap**

Dans `integration.service.ts`, juste après la méthode `captureVideoAnalyticsSnapshots` :

```ts
  /**
   * Views gained hour by hour across every tracked video of a channel.
   *
   * The variation is per video — two videos are two independent counters and
   * subtracting across them would be meaningless — so the series are computed
   * separately and only then summed on the hour.
   */
  private async viewsHeatmap(integrationId: string) {
    const snapshots = await this._integrationRepository.getVideoSnapshots(
      integrationId,
      dayjs().utc().subtract(HOURLY_RETENTION_DAYS, 'day').toDate()
    );

    const byVideo = new Map<string, { capturedAt: Date; views: number }[]>();
    for (const snapshot of snapshots) {
      const readings = byVideo.get(snapshot.videoId) || [];
      readings.push(snapshot);
      byVideo.set(snapshot.videoId, readings);
    }

    const totals = new Map<string, number>();
    for (const readings of byVideo.values()) {
      for (const point of toHourlyDeltas(readings)) {
        totals.set(point.at, (totals.get(point.at) || 0) + point.value);
      }
    }

    return Array.from(totals.entries())
      .map(([at, value]) => ({ at, value }))
      .sort((a, b) => a.at.localeCompare(b.at));
  }
```

- [ ] **Step 3: Injecter la carte heatmap dans `checkAnalytics`**

Dans `checkAnalytics`, remplacer le bloc `try` des lignes 547-565 par :

```ts
      try {
        const loadAnalytics = await this.enrichAnalytics(
          getIntegration.id,
          await integrationProvider.analytics(
            getIntegration.internalId,
            getIntegration.token,
            +date
          ),
          +date
        );

        // Built here rather than in enrichAnalytics: that one is also called by
        // the snapshot sweep, which has no use for a heatmap. A failure must not
        // cost the whole screen, so it degrades to no card at all.
        try {
          const hourly = await this.viewsHeatmap(getIntegration.id);
          if (hourly.length) {
            loadAnalytics.push({ label: 'Views by Day and Hour', data: [], hourly });
          }
        } catch (e) {}

        await ioRedis.set(
          `integration:${org.id}:${integration}:${date}`,
          JSON.stringify(loadAnalytics),
          'EX',
          !process.env.NODE_ENV || process.env.NODE_ENV === 'development'
            ? 1
            : 3600
        );
        return loadAnalytics;
      } catch (e) {
        if (e instanceof RefreshToken) {
          return this.checkAnalytics(org, integration, date, true);
        }
      }
```

Le reste de la méthode — le cache Redis lu en amont, le `catch (RefreshToken)` — ne change pas. La heatmap est donc mise en cache une heure comme le reste, ce qui correspond exactement à sa cadence de rafraîchissement.

- [ ] **Step 4: Compiler**

Run: `pnpm run build:backend`
Expected: build réussi.

- [ ] **Step 5: Relire les trois règles à l'œil**

Aucun test ne couvre `toHourlyDeltas`. Vérifier manuellement, en lisant le code :

1. La boucle démarre à `i = 1` — le premier relevé ne produit donc aucun point. ✅ si `points` reste vide pour un tableau d'un seul élément.
2. `Math.max(0, current.views - previous.views)` — un compteur qui baisse donne 0, jamais un négatif.
3. Pour deux relevés espacés de 3 h et un gain de 30 : `hours` vaut 3, `perHour` vaut 10, et la boucle pousse 3 points à 10, horodatés `current - 2h`, `current - 1h`, `current`.

- [ ] **Step 6: Commit**

```bash
git add libraries/nestjs-libraries/src/database/prisma/integrations/integration.service.ts
git commit -m "feat(analytics): derive hourly view variations and a channel heatmap"
```

---

### Task 5: Route d'historique par vidéo

**Files:**
- Modify: `libraries/nestjs-libraries/src/database/prisma/integrations/integration.service.ts` (constante, méthode publique)
- Modify: `apps/backend/src/api/routes/analytics.controller.ts:25-32`

**Interfaces:**
- Consumes: `getVideoSnapshots` (Task 1), `toHourlyDeltas` (Task 4).
- Produces:
  - `IntegrationService.videoHistory(orgId: string, integrationId: string, videoId: string): Promise<Array<{ at: string; value: number }>>`
  - `GET /analytics/:integration/videos/:videoId`

- [ ] **Step 1: Ajouter la fenêtre d'historique**

Dans `integration.service.ts`, sous `HOURLY_RETENTION_DAYS` :

```ts
/**
 * How far back a single video's curve reaches. Well past the hourly retention
 * on purpose: beyond 28 days the readings survive at one per day, and those
 * daily points are exactly what the "day" view of the curve shows.
 */
const VIDEO_HISTORY_WINDOW_DAYS = 180;
```

- [ ] **Step 2: Écrire la méthode de service**

Dans `integration.service.ts`, juste après `viewsHeatmap` :

```ts
  /**
   * The growth curve of one video, hour by hour. The day view is the same
   * payload regrouped by the client, so there is no second route for it.
   *
   * Goes through the org-scoped lookup: a video id alone must never be enough
   * to read another organization's analytics.
   */
  async videoHistory(orgId: string, integrationId: string, videoId: string) {
    const integration = await this._integrationRepository.getIntegrationById(
      orgId,
      integrationId
    );

    if (!integration) {
      return [];
    }

    return toHourlyDeltas(
      await this._integrationRepository.getVideoSnapshots(
        integration.id,
        dayjs().utc().subtract(VIDEO_HISTORY_WINDOW_DAYS, 'day').toDate(),
        videoId
      )
    );
  }
```

Vérifier au passage la signature réelle de `getIntegrationById` dans `integration.repository.ts` : elle est appelée ailleurs sous la forme `getIntegrationById(orgId, id)`. Si l'ordre des paramètres diffère, l'adapter ici plutôt que de modifier le repository.

- [ ] **Step 3: Ajouter la route**

Dans `analytics.controller.ts`, après `getPostAnalytics` :

```ts
  @Get('/:integration/videos/:videoId')
  async getVideoHistory(
    @GetOrgFromRequest() org: Organization,
    @Param('integration') integration: string,
    @Param('videoId') videoId: string
  ) {
    return this._integrationService.videoHistory(org.id, integration, videoId);
  }
```

Trois segments contre un pour `@Get('/:integration')` : aucun conflit de routage, l'ordre de déclaration n'a pas d'importance ici.

- [ ] **Step 4: Compiler**

Run: `pnpm run build:backend`
Expected: build réussi.

- [ ] **Step 5: Commit**

```bash
git add libraries/nestjs-libraries/src/database/prisma/integrations/integration.service.ts \
        apps/backend/src/api/routes/analytics.controller.ts
git commit -m "feat(analytics): per-video view history endpoint"
```

---

### Task 6: `ChartSocial` accepte plus de 7 points

`chart-social.tsx:27` écrase toute série de plus de 7 points en 7 gros paquets. Une courbe horaire y serait illisible.

**Files:**
- Modify: `apps/frontend/src/components/analytics/chart-social.tsx:19-36`

**Interfaces:**
- Consumes: rien.
- Produces: `ChartSocial` accepte `points?: number` (défaut 7).

- [ ] **Step 1: Ajouter la prop**

Remplacer la signature et le `useMemo` des lignes 19-36 par :

```tsx
export const ChartSocial: FC<{
  data: TotalList[];
  color?: 'purple' | 'green' | 'blue';
  /**
   * How many buckets the series is squeezed into. Seven suits a sparkline, but
   * an hourly curve needs far more before it stops being a straight line.
   */
  points?: number;
}> = (props) => {
  const { data, color = 'purple', points = 7 } = props;
  const [mode] = useCookie('mode', 'dark');

  const list = useMemo(() => {
    const merged = data.length < points ? data : mergeDataPoints(data, points);
    if (merged.length === 1) {
      return [
        // duplicating single datapoints metrics for chart to display a line on analytics
        merged[0],
        merged[0],
      ];
    }
    return merged;
  }, [data, points]);
```

Le défaut à 7 laisse tous les appelants actuels inchangés.

- [ ] **Step 2: Compiler**

Run: `pnpm run build:frontend`
Expected: build réussi.

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/src/components/analytics/chart-social.tsx
git commit -m "feat(analytics): let ChartSocial render more than seven buckets"
```

---

### Task 7: Ligne dépliable et courbe par vidéo

**Files:**
- Create: `apps/frontend/src/components/platform-analytics/video.table.tsx`
- Modify: `apps/frontend/src/components/platform-analytics/render.analytics.tsx` (retirer `SortableHeader` et `VideoTable`, lignes 27-165 ; passer `integrationId`)

**Interfaces:**
- Consumes: `GET /analytics/:integration/videos/:videoId` (Task 5) ; `ChartSocial` avec `points` (Task 6).
- Produces:
  - `export type AnalyticsVideoRow` — même forme que `AnalyticsVideo` côté serveur
  - `export const VideoTable: FC<{ videos: AnalyticsVideoRow[]; integrationId: string }>`

- [ ] **Step 1: Créer `video.table.tsx`**

Déplacer `SortableHeader` et `VideoTable` depuis `render.analytics.tsx` (lignes 27-165) **à l'identique**, en tête du nouveau fichier, avec ces imports :

```tsx
import { FC, Fragment, useCallback, useMemo, useState } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { ChartSocial } from '@gitroom/frontend/components/analytics/chart-social';

export type AnalyticsVideoRow = {
  id: string;
  title: string;
  url?: string;
  thumbnail?: string;
  date: string;
  views: number;
  likes: number;
  comments: number;
};

type VideoSortKey = 'date' | 'views' | 'likes' | 'comments';
```

Le type `VideoSortKey` et les deux composants sont repris tels quels ; seule la signature de `VideoTable` change au Step 3.

- [ ] **Step 2: Écrire le hook et le composant de courbe**

À la suite, dans `video.table.tsx` :

```tsx
/**
 * One hook, one useSWR — the analytics screen already follows that rule and
 * react-hooks/rules-of-hooks depends on it.
 *
 * Loaded on expand rather than with the table: a channel's ten videos carry
 * several thousand points between them, and nobody opens ten at once.
 */
const useVideoHistory = (integrationId: string, videoId: string) => {
  const fetch = useFetch();

  return useSWR(
    `/analytics/${integrationId}/videos/${videoId}`,
    async (url: string) => (await fetch(url)).json(),
    {
      revalidateOnFocus: false,
      revalidateIfStale: false,
    }
  );
};

const VideoHistory: FC<{ integrationId: string; videoId: string }> = ({
  integrationId,
  videoId,
}) => {
  const { data, isLoading } = useVideoHistory(integrationId, videoId);
  const [granularity, setGranularity] = useState<'hour' | 'day'>('hour');

  const series = useMemo(() => {
    const points: Array<{ at: string; value: number }> = data || [];

    if (granularity === 'hour') {
      return points.map((point) => ({
        date: new Date(point.at).toLocaleString(),
        total: point.value,
      }));
    }

    // The day view is this same payload regrouped, not a second request.
    const perDay = new Map<string, number>();
    for (const point of points) {
      const day = new Date(point.at).toLocaleDateString();
      perDay.set(day, (perDay.get(day) || 0) + point.value);
    }

    return Array.from(perDay.entries()).map(([date, total]) => ({
      date,
      total,
    }));
  }, [data, granularity]);

  if (isLoading) {
    return (
      <div className="py-[24px] text-center text-[13px] text-newTableText">
        Loading…
      </div>
    );
  }

  if (!series.length) {
    return (
      <div className="py-[24px] text-center text-[13px] text-newTableText">
        No reading yet — the hourly sweep needs at least two passes before a
        variation can be drawn.
      </div>
    );
  }

  return (
    <div className="py-[12px]">
      <div className="flex items-center gap-[8px] mb-[8px]">
        {(['hour', 'day'] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setGranularity(option)}
            className={`px-[10px] py-[4px] text-[12px] rounded-[6px] transition-colors ${
              granularity === option
                ? 'bg-[#612bd3] text-white'
                : 'bg-newTableHeader text-newTableText hover:text-white'
            }`}
          >
            {option === 'hour' ? 'Hour' : 'Day'}
          </button>
        ))}
      </div>
      <div className="h-[160px]">
        {/* ChartSocial builds its chart once and ignores later data changes,
            so switching granularity has to remount it. */}
        <ChartSocial
          key={`${videoId}-${granularity}`}
          data={series}
          color="purple"
          points={granularity === 'hour' ? 72 : 30}
        />
      </div>
    </div>
  );
};
```

- [ ] **Step 3: Rendre les lignes dépliables**

Dans `video.table.tsx`, changer la signature de `VideoTable` :

```tsx
export const VideoTable: FC<{
  videos: AnalyticsVideoRow[];
  integrationId: string;
}> = ({ videos, integrationId }) => {
```

Ajouter cet état auprès de `sortKey` et `ascending` :

```tsx
  // One video open at a time: two curves side by side compete for the same
  // vertical space and neither gets enough of it.
  const [openId, setOpenId] = useState<string | null>(null);
```

Puis remplacer le `sorted.map(...)` du `<tbody>` par :

```tsx
          {sorted.map((video) => (
            <Fragment key={video.id}>
              <tr
                className="border-t border-newTableBorder cursor-pointer hover:bg-newTableHeader/50"
                onClick={() =>
                  setOpenId((current) =>
                    current === video.id ? null : video.id
                  )
                }
              >
                <td className="py-[10px] pr-[12px]">
                  <div className="flex items-center gap-[10px] min-w-[220px]">
                    <span
                      className={`text-[10px] text-newTableText transition-transform ${
                        openId === video.id ? 'rotate-90' : ''
                      }`}
                    >
                      ▶
                    </span>
                    {video.thumbnail && (
                      <img
                        src={video.thumbnail}
                        alt=""
                        className="w-[64px] h-[36px] object-cover rounded-[4px] flex-none"
                      />
                    )}
                    {video.url ? (
                      <a
                        href={video.url}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="hover:underline line-clamp-2"
                      >
                        {video.title}
                      </a>
                    ) : (
                      <span className="line-clamp-2">{video.title}</span>
                    )}
                  </div>
                </td>
                <td className="py-[10px] px-[12px] text-newTableText whitespace-nowrap">
                  {video.date ? new Date(video.date).toLocaleDateString() : '—'}
                </td>
                <td className="py-[10px] px-[12px] text-right tabular-nums">
                  {format(video.views)}
                </td>
                <td className="py-[10px] px-[12px] text-right tabular-nums">
                  {format(video.likes)}
                </td>
                <td className="py-[10px] pl-[12px] text-right tabular-nums">
                  {format(video.comments)}
                </td>
              </tr>
              {openId === video.id && (
                <tr className="border-t border-newTableBorder">
                  <td colSpan={5}>
                    <VideoHistory
                      integrationId={integrationId}
                      videoId={video.id}
                    />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
```

Le `stopPropagation` sur le lien évite qu'un clic destiné à ouvrir la vidéo déplie aussi la ligne.

- [ ] **Step 4: Câbler dans `render.analytics.tsx`**

Supprimer `SortableHeader` et `VideoTable` (lignes 27-165) ainsi que le type `VideoSortKey`, et ajouter l'import :

```tsx
import {
  VideoTable,
  AnalyticsVideoRow,
} from '@gitroom/frontend/components/platform-analytics/video.table';
```

Dans `AnalyticsDataItem`, remplacer le champ `videos` par `videos?: AnalyticsVideoRow[];`.

`AnalyticsCard` doit recevoir l'intégration. Changer sa signature :

```tsx
const AnalyticsCard: FC<{
  item: AnalyticsDataItem;
  total: string | number;
  index: number;
  integrationId: string;
}> = ({ item, total, index, integrationId }) => {
```

et son appel du tableau :

```tsx
              <VideoTable videos={item.videos} integrationId={integrationId} />
```

Enfin, dans `RenderAnalytics`, passer la prop :

```tsx
        <AnalyticsCard
          key={`analytics-${index}`}
          item={item}
          total={totals[index]}
          index={index}
          integrationId={integration.id}
        />
```

- [ ] **Step 5: Compiler**

Run: `pnpm run build:frontend`
Expected: build réussi. Un `Cannot find name 'SortableHeader'` signale un reste de l'ancien bloc dans `render.analytics.tsx`.

- [ ] **Step 6: Vérifier à l'écran**

Run: `pnpm run dev`
Ouvrir les analytics d'un canal YouTube ou TikTok. Attendu : chaque ligne du tableau porte un chevron et se déplie au clic ; le tri par colonne fonctionne toujours ; une ligne fraîchement dépliée affiche le message « No reading yet » tant que le balayage horaire n'a pas fait deux passages.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/components/platform-analytics/video.table.tsx \
        apps/frontend/src/components/platform-analytics/render.analytics.tsx
git commit -m "feat(analytics): expandable video rows with their growth curve"
```

---

### Task 8: Grille jour × heure

**Files:**
- Create: `apps/frontend/src/components/platform-analytics/heatmap.grid.tsx`
- Modify: `apps/frontend/src/components/platform-analytics/render.analytics.tsx` (`AnalyticsDataItem`, rendu de `AnalyticsCard`)

**Interfaces:**
- Consumes: `AnalyticsData.hourly` (Task 2), produit par `checkAnalytics` (Task 4).
- Produces: `export const HeatmapGrid: FC<{ points: Array<{ at: string; value: number }> }>`

- [ ] **Step 1: Créer `heatmap.grid.tsx`**

```tsx
import { FC, useMemo } from 'react';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Views gained, laid out as day of week against hour of day.
 *
 * The bucketing happens here rather than on the server because the reading only
 * means anything in the viewer's own timezone, and `new Date` already knows it.
 * The server sends the raw UTC series precisely so this stays exact for the
 * timezones offset by half an hour.
 */
export const HeatmapGrid: FC<{
  points: Array<{ at: string; value: number }>;
}> = ({ points }) => {
  const grid = useMemo(() => {
    const cells = Array.from({ length: 7 }, () => new Array(24).fill(0));

    for (const point of points) {
      const at = new Date(point.at);
      cells[at.getDay()][at.getHours()] += point.value;
    }

    return cells;
  }, [points]);

  const max = useMemo(
    () => Math.max(...grid.flat(), 1),
    [grid]
  );

  return (
    <div className="px-[16px] pb-[14px] overflow-x-auto">
      <div className="min-w-[560px]">
        <div className="flex gap-[3px] mb-[4px] pl-[36px]">
          {Array.from({ length: 24 }, (_, hour) => (
            <div
              key={hour}
              className="flex-1 text-[10px] text-newTableText text-center"
            >
              {hour % 3 === 0 ? hour : ''}
            </div>
          ))}
        </div>
        {grid.map((row, day) => (
          <div key={day} className="flex items-center gap-[3px] mb-[3px]">
            <div className="w-[36px] text-[11px] text-newTableText">
              {DAYS[day]}
            </div>
            {row.map((value, hour) => (
              <div
                key={hour}
                title={`${DAYS[day]} ${hour}:00 — ${value.toLocaleString()}`}
                className="flex-1 h-[18px] rounded-[3px] bg-[#612bd3]"
                // Opacity rather than a colour scale: it keeps the empty cells
                // readable against both themes without a second palette.
                style={{ opacity: value === 0 ? 0.06 : 0.15 + (value / max) * 0.85 }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
};
```

- [ ] **Step 2: Câbler dans `render.analytics.tsx`**

Ajouter l'import :

```tsx
import { HeatmapGrid } from '@gitroom/frontend/components/platform-analytics/heatmap.grid';
```

Dans `AnalyticsDataItem`, ajouter le champ :

```tsx
  hourly?: Array<{ at: string; value: number }>;
```

Dans `AnalyticsCard`, étendre la condition `col-span-full` — la grille a besoin de la largeur au même titre que le tableau :

```tsx
    <div
      className={`group relative ${
        item.videos?.length || item.hourly?.length ? 'col-span-full' : ''
      }`}
    >
```

Puis ajouter la branche de rendu, **avant** `item.breakdown?.length` :

```tsx
        {item.videos?.length ? (
          <div className="px-[16px] pb-[14px]">
            <VideoTable videos={item.videos} integrationId={integrationId} />
          </div>
        ) : item.hourly?.length ? (
          <HeatmapGrid points={item.hourly} />
        ) : item.breakdown?.length ? (
```

L'ordre compte : une métrique `hourly` a `data: []`, donc `hasDataPoints` vaut `false` et elle tomberait sinon dans l'affichage « valeur unique », qui montrerait un gros zéro.

- [ ] **Step 3: Compiler**

Run: `pnpm run build:frontend`
Expected: build réussi.

- [ ] **Step 4: Vérifier à l'écran**

Run: `pnpm run dev`
Attendu : tant que le balayage horaire n'a pas tourné, **aucune** carte « Views by Day and Hour » n'apparaît — c'est le comportement voulu, `checkAnalytics` ne pousse la carte que si la série n'est pas vide. Après deux passages du workflow, la grille apparaît en pleine largeur, la plupart des cases quasi transparentes.

Pour ne pas attendre une heure : redémarrer l'orchestrateur relance `videoAnalyticsSnapshotWorkflow`, qui capture une fois avant son premier `sleep`.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/components/platform-analytics/heatmap.grid.tsx \
        apps/frontend/src/components/platform-analytics/render.analytics.tsx
git commit -m "feat(analytics): day-by-hour heatmap of the views gained"
```

---

## Après la dernière tâche

- [ ] `pnpm run build` — les trois applications ensemble.
- [ ] `pnpm run prisma-db-push` sur une base de développement, pour vérifier que le schéma s'applique réellement.
- [ ] Relire le diff complet à la recherche de motifs étrangers au reste du code : c'est une exigence explicite du CLAUDE.md du projet.

## Ce que ce plan ne fait pas

- **Likes et commentaires.** Ils arrivent dans la même réponse provider et tiendraient dans la même ligne, mais la demande porte sur les vues.
- **Les autres providers.** La collecte est générique : tout provider implémentant `videosAnalytics` est suivi. Aucun autre ne l'implémente ici.
- **Comparer deux vidéos sur un même graphe.**
- **Rattraper une vidéo sortie du top 10.** Sa courbe s'arrête où le suivi s'arrête.
