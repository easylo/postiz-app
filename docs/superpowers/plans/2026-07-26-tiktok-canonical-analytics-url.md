# TikTok Canonical Analytics URL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an instance-level env var `TIKTOK_ANALYTICS_CANONICAL_URL` that, when set to `"true"`, strips the query string (TikTok's UTM attribution params) from video URLs in the analytics video table.

**Architecture:** One-point change in the TikTok provider's private `toAnalyticsVideos` helper — the single mapping shared by `analytics()` and the hourly snapshot job. No frontend, interface, or database change; snapshots persist only `videoId` + `views`, never URLs.

**Tech Stack:** NestJS (libraries/nestjs-libraries), pnpm monorepo.

## Global Constraints

- Default behavior (var absent or ≠ `"true"`) must be byte-identical to today: `video.share_url` untouched — the system is in production.
- TikTok-specific logic stays inside `tiktok.provider.ts`; the generic `AnalyticsVideo` type and all callers are untouched.
- The repo has no `.spec.ts` files and no root lint script; verification is `pnpm run build:backend` (compiles nestjs-libraries). Do not create new test infrastructure.
- Use pnpm only.

---

### Task 1: Env-gated canonical URL in the TikTok provider

**Files:**
- Modify: `libraries/nestjs-libraries/src/integrations/social/tiktok.provider.ts:967-982` (the `toAnalyticsVideos` helper)
- Modify: `.env.example:64-65` (add the new var next to `TIKTOK_CLIENT_ID`/`TIKTOK_CLIENT_SECRET`)

**Interfaces:**
- Consumes: `video.share_url` (string) from TikTok's `/v2/video/list/` response; `process.env.TIKTOK_ANALYTICS_CANONICAL_URL`.
- Produces: unchanged `AnalyticsVideo` shape — `url: string` — consumed by `analytics()`, `videosAnalytics()`, and the frontend video table.

- [ ] **Step 1: Edit `toAnalyticsVideos`**

The current mapping is:

```typescript
      .map((video: any) => ({
        id: String(video.id),
        title: video.title || 'Untitled',
        url: video.share_url,
```

Change the `url` line so the query string is dropped when the instance opts in.
TikTok decorates `share_url` with attribution params (`utm_campaign=tt4d_open_api`,
`utm_source=<app id>`); the path alone (`https://www.tiktok.com/@handle/video/<id>`)
opens the video identically. We truncate rather than rebuild the URL because the
handle is not part of the `video/list` response.

```typescript
      .map((video: any) => ({
        id: String(video.id),
        title: video.title || 'Untitled',
        // TikTok decorates share_url with its Open API attribution params
        // (utm_campaign=tt4d_open_api & an app-identifying utm_source); the
        // bare path opens the video identically.
        url:
          process.env.TIKTOK_ANALYTICS_CANONICAL_URL === 'true'
            ? (video.share_url || '').split('?')[0]
            : video.share_url,
```

- [ ] **Step 2: Document the var in `.env.example`**

After the existing lines

```
TIKTOK_CLIENT_ID=""
TIKTOK_CLIENT_SECRET=""
```

add:

```
TIKTOK_ANALYTICS_CANONICAL_URL=""
```

(Empty string keeps the default; the section is a flat list without comments —
match it.)

- [ ] **Step 3: Verify the backend compiles**

Run from the repo root:

```bash
pnpm run build:backend
```

Expected: build completes with no TypeScript errors.

- [ ] **Step 4: Spot-check the mapping logic**

Run:

```bash
node -e "const f=(u,on)=>on==='true'?(u||'').split('?')[0]:u; console.log(f('https://www.tiktok.com/@x/video/1?utm_campaign=tt4d_open_api','true')); console.log(f('https://www.tiktok.com/@x/video/1?utm_campaign=tt4d_open_api',undefined)); console.log(f(undefined,'true'));"
```

Expected output, line by line:

```
https://www.tiktok.com/@x/video/1
https://www.tiktok.com/@x/video/1?utm_campaign=tt4d_open_api

```

(third line is the empty string — no crash on a missing `share_url`).

- [ ] **Step 5: Commit**

```bash
git add libraries/nestjs-libraries/src/integrations/social/tiktok.provider.ts .env.example
git commit -m "feat(tiktok): option d'URL canonique dans les analytics vidéo

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
