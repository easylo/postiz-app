# Enrichissement des analytics — chantier A

**Date :** 2026-07-24
**Statut :** Approuvé
**Branche :** `feature/analytics-tiktok-youtube`

## Contexte

Les statistiques remontées pour TikTok et YouTube sont jugées trop pauvres.
L'audit du code montre une situation contrastée et trois défauts distincts.

**YouTube** interroge la YouTube Analytics API avec `dimensions: 'day'` : ce sont
de vraies séries journalières. Six métriques sont exposées (minutes visionnées,
durée et pourcentage moyens de visionnage, abonnés gagnés/perdus, likes). Mais
`views` est **demandé dans la requête puis jeté** — la métrique la plus
importante est payée en quota et jamais affichée.

**TikTok** ne renvoie qu'un **instantané** : un seul point daté du jour, avec
`percentageChange: 0` codé en dur et le paramètre `date` ignoré. Les libellés
mélangent sans le dire deux familles incompatibles — des compteurs de compte
(`Total Likes`, `Followers`, cumulés depuis toujours) et des agrégats calculés
sur les **20 dernières vidéos** (`Views`, `Recent Likes`).

**Transversalement**, `percentageChange` n'est calculé nulle part dans le
produit : `0` chez la plupart des providers, et `5` en dur chez LinkedIn,
Facebook et Threads. L'indicateur de tendance du composant `render.analytics`
est donc purement décoratif, et affiche une hausse fictive de 5 % sur trois
providers.

Ce document couvre le **chantier A** d'un découpage en trois, validé avec
l'utilisateur :

| Chantier | Objet | Statut |
|---|---|---|
| **A** | Plus de métriques à forme constante + tendance réelle | **ce document** |
| B | Historique en base + workflow de capture ⇒ vraies tendances TikTok | à venir |
| C | Répartitions (pays, sources de trafic, appareils) — YouTube uniquement | à venir |

## Objectif et périmètre

**Dans le périmètre :** exposer `views` côté YouTube, ajouter trois métriques
YouTube disponibles sans nouveau scope, ajouter deux métriques dérivées TikTok
sans appel supplémentaire, lever l'ambiguïté des libellés TikTok, et calculer
`percentageChange` de façon générique.

**Hors périmètre :** tout stockage en base, tout workflow planifié, toute
donnée de répartition, toute modification du composant de rendu, tout nouveau
scope OAuth. `estimatedRevenue` est explicitement exclu : il exigerait
`yt-analytics-monetary.readonly`, non demandé par le provider.

## Décisions

| Décision | Choix | Raison |
|---|---|---|
| Forme des données | On reste dans `AnalyticsData` | Aucun changement de front ; les répartitions relèvent du chantier C |
| Nouvelles métriques YouTube | `comments`, `shares`, `videosAddedToPlaylists` | Même appel `reports.query`, même quota, couvertes par `yt-analytics.readonly` déjà demandé ⇒ **aucune reconnexion de chaîne** |
| Métriques TikTok | Dérivées du calcul existant | Taux d'engagement et vues moyennes se calculent sur des données déjà en mémoire ⇒ zéro appel réseau |
| Libellés TikTok | Suffixer les agrégats de la fenêtre glissante | `Views` et `Total Likes` sont aujourd'hui côte à côte alors qu'ils ne mesurent pas la même chose |
| `percentageChange` | Calculé dans `checkAnalytics`, pas dans les providers | Générique, aucune logique par provider (contrainte CLAUDE.md), bénéficie à tous |
| Emplacement du calcul | Après l'appel provider, **avant** la mise en cache Redis | La valeur calculée est mise en cache avec le reste, pas recalculée à chaque lecture |

## Détail

### A1 — Exposer les vues YouTube

`views` figure déjà dans la chaîne `metrics` de `reports.query` et dans
`mappedData`, mais aucun `acc.push` ne l'expose. Ajouter l'entrée `Views`.

### A2 — Trois métriques YouTube

Ajouter `comments`, `shares`, `videosAddedToPlaylists` à la chaîne `metrics`,
puis une entrée `acc.push` par métrique, sur le modèle exact des existantes.
Libellés : `Comments`, `Shares`, `Added to Playlists`.

### A3 — TikTok : métriques dérivées et libellés

À partir des totaux déjà calculés sur les 20 dernières vidéos :

- **Engagement Rate** = `(totalLikes + totalComments + totalShares) / totalViews × 100`,
  marquée `average: true` (c'est un pourcentage, donc une variation en points).
  Non poussée si `totalViews === 0`.
- **Avg. Views per Video** = `totalViews / nombre de vidéos`, marquée
  `average: true`. Non poussée si la liste est vide.

Libellés de la fenêtre glissante renommés pour dire ce qu'ils mesurent :
`Views` → `Views (last 20 videos)`, `Recent Likes` → `Likes (last 20 videos)`,
et de même pour les commentaires et partages. Les compteurs de compte
(`Followers`, `Following`, `Total Likes`, `Videos`) restent inchangés.

### A4 — Calcul générique de `percentageChange`

Dans `integration.service.ts`, entre l'appel `integrationProvider.analytics(...)`
et le `ioRedis.set(...)`, appliquer à chaque entrée :

- moins de 2 points de données ⇒ `0` ;
- série coupée en deux moitiés égales (la moitié impaire du milieu revient à la
  seconde) ;
- métrique `average: true` ⇒ différence des **moyennes** des deux moitiés,
  exprimée en points (l'UI affiche `pp`) ;
- sinon ⇒ variation relative des **sommes**, en pourcentage ;
- première moitié à 0 ⇒ `0`, pour éviter une division par zéro ;
- résultat arrondi à une décimale, cohérent avec le `toFixed(1)` du composant.

Une valeur `percentageChange` déjà posée par un provider est **écrasée**.

Le second point d'appel, `postAnalytics` (`posts.service.ts:210`), n'est
volontairement pas couvert : les implémentations TikTok et YouTube y renvoient
un instantané à un seul point (`data: [{ total, date: today }]`), le calcul
donnerait donc toujours 0. Ce chemin relève du chantier B, qui lui apportera un
historique.

`AnalyticsData` est mise en accord avec la réalité du code au passage :
`average` y est ajouté (YouTube l'émettait déjà en échappant au typage via
`any[]`, et le front le déclare depuis toujours) et `percentageChange` devient
optionnel, puisque les providers n'ont plus à le renseigner.

## Conséquences assumées

- **LinkedIn, Facebook, Threads** perdent leur `percentageChange: 5` fictif au
  profit de la variation réelle. C'est une correction, mais elle touche trois
  providers hors du périmètre TikTok/YouTube demandé.
- **TikTok reste à 0 %** : avec un seul point de mesure, aucune variation n'est
  calculable. C'est l'objet du chantier B, pas de celui-ci.
- Les libellés TikTok changent. Aucune donnée n'est persistée sous ces libellés
  (cache Redis d'une heure uniquement), donc aucune migration n'est requise.

## Fichiers

| Fichier | Nature |
|---|---|
| `libraries/nestjs-libraries/src/integrations/social/youtube.provider.ts` | A1 + A2 |
| `libraries/nestjs-libraries/src/integrations/social/tiktok.provider.ts` | A3 |
| `libraries/nestjs-libraries/src/database/prisma/integrations/integration.service.ts` | A4 |

Aucun changement dans `apps/frontend` : le composant `render.analytics` sait
déjà rendre `percentageChange` et la distinction `average`.

## Risques

- **Quota YouTube** : trois métriques de plus dans le même appel n'augmentent
  pas le nombre de requêtes. Aucun impact.
- **Métrique indisponible** : si l'API refuse une des trois nouvelles métriques
  pour une chaîne donnée, `reports.query` échoue en bloc et l'écran d'analytics
  se vide. Les trois sont des métriques de base du rapport `channel`, mais le
  comportement est à vérifier sur une chaîne réelle après déploiement.
- **Cache Redis** : les anciennes valeurs restent servies jusqu'à une heure
  après le déploiement. Ne pas conclure trop vite à un échec.
