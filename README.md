# Hermes Desktop Achievements

Achievements, right inside the Hermes desktop app.

A full achievements page (score header, tier filters, progress bars, rescan),
a sidebar nav row, a live statusbar score chip, and a ⌘K command — all backed
by the `hermes-achievements` dashboard plugin that ships with Hermes Agent.

## What you get

- **Score header** — unlocked/total, discovered/secret counts, scan freshness,
  one-click **Rescan**
- **Filter tabs** — all / unlocked / discovered / secret with live counts
- **Achievement cards** — tier badge, progress %, "what counts" criteria,
  evidence session, next-tier threshold
- **Statusbar chip** — `36/60` in the bottom-right at all times; click to open
- **Command palette** — ⌘K → "Achievements: Open"

## Install

1. **Backend (required):** the Hermes Agent install already ships
   `plugins/hermes-achievements/` (it mounts `/api/plugins/hermes-achievements/`
   on `hermes serve`). Make sure it's enabled in `~/.hermes/config.yaml`:

   ```yaml
   plugins:
     enabled:
       - hermes-achievements
   ```

   Verify it mounted:

   ```bash
   grep "Mounted plugin API routes: /api/plugins/hermes-achievements" ~/.hermes/logs/agent.log
   ```

2. **Desktop plugin:** copy the folder into your desktop plugins directory:

   ```bash
   mkdir -p ~/.hermes/desktop-plugins/hermes-achievements
   cp plugin.js ~/.hermes/desktop-plugins/hermes-achievements/
   ```

3. The app watches that directory — the plugin loads within a few seconds.
   If it doesn't appear: ⌘K → **Reload desktop plugins**.

## Requirements

- Hermes Agent desktop app (v0.19+ recommended)
- The `hermes-achievements` plugin enabled (bundled with Hermes Agent; see
  `plugins/hermes-achievements/` in the repo or the dashboard's built-in
  plugins doc)

## How it works

- **Zero new backend.** The plugin talks to the existing
  `hermes-achievements` dashboard plugin API over `ctx.rest` →
  `/api/plugins/hermes-achievements/achievements` — the same scan engine the
  web dashboard uses.
- **Live data.** The page and statusbar chip refetch every 120s (matching the
  backend snapshot TTL). The Rescan button hits `POST /rescan` and
  invalidates the shared React Query cache.
- **Theme-native.** Cards use the app's design system (`Badge`, `Button`,
  `Codicon`, theme CSS variables) — no hardcoded colors, follows light/dark.

## Files

```text
plugin.js   The whole plugin — plain ESM, loaded uncompiled (jsx() calls, no JSX syntax)
```

## Development

The desktop plugin SDK docs live in the Hermes Agent repo:
`website/docs/developer-guide/desktop-plugin-sdk.md`.

Quick iteration loop: edit `plugin.js`, save — the app hot-reloads in place.

## License

MIT
