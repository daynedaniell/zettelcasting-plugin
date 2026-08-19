# Dashboard blocks — specification

Status: in progress on branch `reporting-dashboard`.

This document is the brief for the dashboard/widget feature, written down so a
later session can pick the work up without re-deriving the decisions. It covers
the first block, `zc-connections`, and the shared layer every later block sits
on.

---

## Goal

One markdown code block processor, `zc-connections`, rendering account
connection health inside any note.

The scope is deliberately narrow. The block exists to prove out the shared
**block + cached-API-client layer**; the queue, performance and publish blocks
come later and are explicitly *not* part of this branch. Nothing here touches
the existing publish path.

---

## Architecture decisions

These were settled before implementation. They are not open questions.

**Panels are markdown code blocks, not a custom `ItemView`.** The dashboard is
a normal note the user composes. Each block is independent, so a dashboard note
can freely interleave `zc-*` blocks with Bases, Kanban, Todoist and Meta Bind
blocks. A custom view would own the whole leaf and make that impossible.

**All HTTP goes through Obsidian's `requestUrl()`, never `fetch`.** `fetch`
from the renderer is subject to CORS, which the ZettelCasting API does not
grant. This matches what `src/api.ts` already does.

**Plain TypeScript + DOM.** No React, no Angular, no new runtime. (Svelte 4 is
already in the bundle for the Flatpickr date picker — if a component model is
ever genuinely needed, reach for that rather than adding a second framework.)

**Every block reads cache-first.** A block returns the last-known-good response
from `data.json` immediately and revalidates in the background, re-rendering
when the new data lands. A block must render something useful offline and must
never show a bare spinner on note open.

**No network calls until the user has explicitly connected an account.** This
is a community-store review requirement, not a preference. With no API key
stored, a block renders a "connect your account" state and issues zero
requests.

---

## Block syntax

````markdown
```zc-connections
platforms: [x, linkedin, ghost]   # optional; omit for all
compact: true                     # optional
```
````

The body is parsed as YAML via `parseYaml` from the `obsidian` package — no new
dependency.

Config rules:

- Empty body is valid: all platforms, non-compact.
- `platforms` accepts platform keys case-insensitively. `x` and `twitter` are
  aliases; the API's key is `twitter`.
- Wrong types or unparseable YAML render a readable inline error inside the
  block. Parsing never throws out of the processor.
- Unrecognised keys render a warning line but do not fail the block — a typo
  should not blank the panel.

---

## API

### `GET /api/integrations/pkm/status`

**This endpoint did not exist and was built for this feature.** Before it, the
only API-key-authenticated surface was `@Controller('integrations/pkm')` with
`GET connection`, `GET platforms`, `POST media` and `POST posts`.
`GET platforms` returns `isConnected` as a bare boolean — one of the four
fields this block needs.

The other three (connection state, last successful publish, failed job count)
existed in the database but were reachable only through
`GET /api/user/api-credentials/status`, which is `JwtAuthGuard` — browser
session only, unusable from the plugin.

Authenticated with `X-API-Key`, on the existing `PkmIntegrationController`, so
it adds no new auth surface.

```jsonc
{
  "generatedAt": "2026-08-18T09:00:00Z",
  "platforms": [
    {
      "key": "twitter",
      "provider": "twitter",
      "name": "X",
      "state": "connected",
      "tokenExpiresAt": "2026-09-01T00:00:00Z",  // nullable
      "lastPublishedAt": "2026-08-17T14:22:10Z", // nullable
      "failedJobCount": 2
    }
  ]
}
```

`state` is one of `connected`, `expiring_soon`, `expired`, `error`,
`disconnected`, resolved in that precedence order:

| State | Derivation |
| --- | --- |
| `disconnected` | Not in `getPlatformsForUser`'s connected set |
| `expired` | Every connection is `needs_reconnect`, **or** every usable connection's `tokenExpiresAt` has already passed |
| `error` | A usable connection exists but the freshest one has `lastApiCallStatus === 'error'` — connected, but the last real call failed |
| `expiring_soon` | Usable and `tokenExpiresAt` falls inside the `nango.expiringSoonDays` window (default 7) |
| `connected` | Otherwise |

The lapsed-token half of `expired` is worth spelling out: nothing rewrites a
connection's `status` until something tries to publish and fails, so a row can
read `connected` long after its token died. Without that check a dead account
reports as healthy, which is the exact surprise this panel exists to prevent.
One live connection is enough to keep publishing, so the state only degrades
when *every* usable connection has lapsed.

The plugin adds a sixth state of its own, `unknown`, which the server never
sends. An unrecognised state degrades to it rather than being filed under one
of the five, so a server that grows a new state renders honestly in an older
plugin instead of misreporting.

Ghost and Beehiiv authenticate by API key rather than OAuth, so they carry no
`tokenExpiresAt` and resolve only to `connected` or `disconnected`.

The two aggregates are one grouped query each over the `schedule` table:
`MAX(publishedDate) WHERE status = 'published'` and
`COUNT(*) WHERE status = 'failed'`, both grouped by platform.

---

## Caching and refresh

The cache is persisted in `data.json` under `settings.dashboardCache`, keyed by
request. It shares the one `saveData` object with the rest of the settings —
both mutate the same in-memory `plugin.settings`, so neither clobbers the
other. Entries older than 7 days are pruned on load.

**There is no polling loop.** Revalidation has exactly three triggers:

1. First render, if the cached entry is stale.
2. The block re-entering the viewport, if the cached entry is stale.
3. The manual refresh control.

A backgrounded app and an offscreen block therefore issue no requests, without
needing to detect either condition specially. A 30-second display-only timer
ticks the relative "last synced" line; it is started and stopped by the same
visibility observer and makes no network calls.

**The 5-minute floor governs automatic revalidation only.** The manual refresh
button bypasses it — a refresh control that ignores the user for five minutes
reads as broken. It carries a 10-second cooldown with a disabled state instead.

Concurrent requests for the same key are coalesced onto one in-flight promise.
A single `CachedClient` instance is owned by the plugin and shared by every
block, so N blocks on a note produce one request, not N.

---

## Constraints

- Clean up every listener, observer and timer in `onunload` and on block
  teardown. Blocks register as a `MarkdownRenderChild` via `ctx.addChild()` so
  Obsidian drives teardown.
- Style exclusively with Obsidian CSS variables. No hardcoded colours — the
  block must respect the user's theme.
- Mobile must work, read-only is fine. **`manifest.json` still declares
  `isDesktopOnly: true`**, so the plugin does not load on mobile at all yet.
  The block is written mobile-safe (no Node or Electron APIs, no hover-only
  affordances, narrow-width layout), but flipping the manifest needs a real
  mobile smoke test of the existing publish path and the Flatpickr date picker
  first. That is its own branch.
- Unit tests cover the cache layer and the config parser. The cache takes an
  injectable persistence adapter and the config parser an injectable YAML
  parser, so both test in plain Node without Obsidian.

---

## File layout

```
src/api.ts                          fetchIntegrationStatus() lives here, beside
                                    fetchConnectedPlatforms — one HTTP layer,
                                    per that file's own "rather than two
                                    drifting copies"
src/dashboard/cache.ts              persistent stale-while-revalidate store
src/dashboard/client.ts             CachedResource: coalescing, 5-min floor
src/dashboard/block-config.ts       YAML -> validated config | inline error
src/dashboard/block-host.ts         shared scaffold later blocks reuse
src/dashboard/relative-time.ts      "last synced 2 minutes ago"
src/dashboard/connections-block.ts  the zc-connections renderer
```

Unit tests: `tests/cache.test.ts`, `tests/client.test.ts`,
`tests/block-config.test.ts`, `tests/relative-time.test.ts`, plus the
`fetchIntegrationStatus` cases in `tests/api.test.ts`.

## Adding the next block

The layer is built so a second block is mostly a render function:

1. Add its fetcher to `src/api.ts`, returning a result union like the two
   already there.
2. Create a `CachedResource` for it in `setUpDashboard`, with its own cache
   key. It gets coalescing, the staleness floor and persistence for free.
3. Write a config parser for its body if it takes options, following
   `block-config.ts` — fail on bad values, warn on unknown keys.
4. Register the processor, construct a `DashboardBlockHost` with a `render`
   callback, and hand it to `ctx.addChild()`. Visibility gating, the
   relative-time tick and teardown all come with the host.

`renderBlockError` takes the block name as a parameter for exactly this
reason — nothing in the shared layer is specific to `zc-connections`.
