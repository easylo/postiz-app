# Statistiques par vidéo (YouTube + TikTok)

**Date :** 2026-07-24
**Statut :** Approuvé
**Branche :** `feature/analytics-tiktok-youtube`

## Contexte

Les analytics de chaîne montrent des totaux et des tendances, mais pas le détail
par vidéo. On ne peut pas voir quelle publication a marché, ni quand elle est
sortie. Demande : vues, likes, commentaires et **date de publication** pour
chaque vidéo, côté YouTube comme TikTok.

Ce document prolonge [`2026-07-24-analytics-enrichment-design.md`](2026-07-24-analytics-enrichment-design.md),
dont les chantiers A, B et C sont livrés.

## Faisabilité

**TikTok** — `video/list` accepte `id`, `title`, `cover_image_url`, `share_url`,
`create_time`, `view_count`, `like_count`, `comment_count`, `share_count` en
**un seul appel**. Le provider en fait aujourd'hui deux (lister les ids, puis
requêter les statistiques) : la simplification est incluse au périmètre, les
agrégats existants se nourrissant de la même réponse.

**YouTube** — `videos.list(part: ['statistics','snippet'])` donne `publishedAt`,
`viewCount`, `likeCount`, `commentCount`. Les ids viennent de
`channels.list` → playlist « uploads » → `playlistItems.list`, à 1 unité de
quota par appel, plutôt que `search.list` qui en coûte 100.

## Décisions

| Décision | Choix | Raison |
|---|---|---|
| Forme des données | Troisième mode `videos` sur `AnalyticsData` | Ni une courbe ni un classement clé/valeur ne portent six colonnes |
| Exclusivité | `data`, `breakdown` et `videos` restent mutuellement exclusifs | Une métrique porte une courbe, un classement ou une liste, jamais deux |
| Rendu | Carte en pleine largeur (`col-span-full`) | Une carte de grille sur trois colonnes est trop étroite pour un tableau |
| Volume et tri | 10 dernières vidéos, date décroissante | La date de publication est au cœur de la demande, donc l'ordre chronologique |
| Appels TikTok | Fusionnés en un seul | `video/list` ramène déjà tout ; le second appel était redondant |
| Quota YouTube | `playlistItems` plutôt que `search` | 1 unité contre 100 pour le même résultat |

## Forme

```ts
videos?: Array<{
  id: string;
  title: string;
  url?: string;
  thumbnail?: string;
  date: string;      // date de publication
  views: number;
  likes: number;
  comments: number;
}>;
```

Une métrique portant `videos` n'a pas de `data`. Elle traverse donc sans effet
la fusion d'historique et le calcul de tendance, tous deux conditionnés à la
présence de points — même comportement que les répartitions du chantier C.

## Fichiers

| Fichier | Nature |
|---|---|
| `social.integrations.interface.ts` | Champ `videos` |
| `tiktok.provider.ts` | Fusion des deux appels + liste des vidéos |
| `youtube.provider.ts` | Uploads → statistiques + liste des vidéos |
| `render.analytics.tsx` | Tableau pleine largeur |

## Risques

- **Régression sur les agrégats TikTok** : la fusion des appels touche du code
  livré la veille. Les totaux doivent rester identiques ; la fenêtre glissante
  garde son libellé dynamique `(last N videos)`.
- **Quota YouTube** : deux appels supplémentaires par lecture d'analytics
  (`channels.list` puis `playlistItems.list`), à 1 unité chacun. Négligeable au
  regard du quota journalier, mais ce n'est pas gratuit.
- **Vidéos sans statistiques publiques** : YouTube masque `likeCount` sur
  certaines vidéos. Les compteurs absents tombent à 0 plutôt que de faire
  échouer la liste.
