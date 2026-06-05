# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — Vite dev server. Does **not** run the prebuild script, so it reads whatever `public/config.json` is on disk.
- `npm run build` — runs `scripts/build-config.mjs` (prebuild) then `vite build`. Output goes to `dist/`.
- `npm run preview` — serve the production build.
- `npm run typecheck` — `tsc -p tsconfig.json` (noEmit). There is no test suite and no linter configured.

## Build-time config generation

`scripts/build-config.mjs` is the prebuild step. It only fires during `npm run build` (not `dev`). Behavior:

- Reads env vars `SITE_NAME`, `SITE_LOGO`, `SITE_FOOTER`, and `SITE_1`, `SITE_2`, … (stops at the first gap).
- Each `SITE_n` is a CSV of `key="value"` pairs supporting `name`, `backend_url`, `token` (with `\"` / `\\` escaping).
- **Overwrites** `public/config.json` with the resulting `{ site_name, site_logo, footer, site_tokens[] }`.
- If no `SITE_n` is set, the script logs and exits — the on-disk `public/config.json` is preserved.

`public/config.json` is in `.gitignore` for local edits but a default copy exists in the tree; treat it as user-editable runtime config, not source-of-truth code.

## Architecture

Pure static SPA (React 18 + Vite + Tailwind + Radix primitives + Recharts/ECharts). Everything runs in the browser; the only backend is one-or-more **NodeGet master servers** reached via WebSocket JSON-RPC 2.0.

### Data flow

```
public/config.json ──► useConfig ──► SiteConfig.site_tokens[]
                                              │
                                              ▼
                                        BackendPool
                                  (one RpcClient per backend)
                                              │
                                              ▼
                                          useNodes
        ┌─────────────────────┬──────────────┴──────────────┐
        ▼ bootstrap (once     ▼ repeats every 2 s            ▼ on demand
          per backend)          (dynamic summary)              (NodeDetail)
  • list_all_agent_uuid     • agent_dynamic_summary_       • task_query
  • kv_get_multi_value         multi_last_query              (ping / tcp_ping
    (metadata_* keys)                                         via useNodeLatency,
  • agent_static_data_                                        10 s refresh)
    multi_last_query
```

Key invariants in `useNodes` (`src/hooks/useNodes.ts`):

- `agents` (static + meta), `live` (latest dynamic), and `history` (last 60 samples) are three separate `Map<uuid, …>` states; the derived `nodes` map is recomputed in `useMemo` and is what the rest of the app consumes.
- A node is `online` iff its last dynamic timestamp is within `OFFLINE_AFTER_MS` (30 s) — see `src/utils/status.ts`.
- Failed backends are retried every 30 s; per-backend errors are surfaced through the `errors` array, not thrown.
- When a UUID disappears from a backend's listing, its entries are pruned from all three maps — but only if `source` still matches that backend.

### RPC client (`src/api/client.ts`)

- Single persistent WS per backend with auto-reconnect (2 s delay), 8 s connect timeout, 10 s default call timeout.
- Messages queued in `outbox` until the socket opens; an `opened` promise gates `call()`.
- Every `params` object is shallow-merged with `{ token }` before being sent; never pass `token` from the caller.
- All RPC method wrappers live in `src/api/methods.ts` — add new methods there rather than calling `client.call` from components.

### UI layout

- `src/App.tsx` is the top-level shell: holds view/sort/filter/selection state, persists `view` and `sort` to `localStorage`, and syncs the selected node UUID to `window.location.hash` (both directions).
- Three views, all driven from the same sorted/filtered `list`:
  - `cards` → `NodeCard`
  - `table` → `NodeTable`
  - `map` → `WorldMap` (lazy-loaded; pulls in `echarts` + `public/world.geo.json`, so keep it out of the synchronous bundle)
- `NodeDetail` is a full-screen overlay opened by hash navigation; it owns its own latency fetching via `useNodeLatency`.
- Tailwind theme uses CSS variables (`hsl(var(--…))`) defined in `src/styles/global.css`; dark mode is `class`-based and pre-applied by an inline script in `index.html` to avoid FOUC. Default theme is dark.

### Derived display values

`src/utils/derive.ts` is the central place for everything UI-facing that isn't raw RPC output: `deriveUsage`, `displayName`, `cpuLabel`, `osLabel`, `distroLogo` (matches against the SVGs in `public/linux-logo-icon/`), and `virtLabel` (KV override → static API → kernel/cpu heuristic). Prefer extending these helpers over inlining the same logic in components.

## Deployment

- Static output in `dist/`. `vite.config.ts` sets `base: './'` so the build is path-agnostic — drop it anywhere.
- `wrangler.jsonc` configures Cloudflare Pages / Workers Assets with SPA fallback (`not_found_handling: single-page-application`).
- `public/custom.css` and `public/custom.js` are loaded by `index.html` and are intended as user-extension hooks; leave them alone unless a change is specifically requested.

## Conventions

- TypeScript is configured with `strict: false`; prefer explicit types at module boundaries (see `src/types.ts`) but don't fight the loose config.
- Comments and inline strings throughout the UI are Chinese (zh-CN). Keep user-facing copy in Chinese; keep identifiers and code-internal log messages in English.
- The version string is injected at build time via `__APP_VERSION__` (defined in `vite.config.ts` from `package.json`). Bump `package.json` to release.
