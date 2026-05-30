# CLAUDE.md — viboplr-tidal

This file orients Claude Code working in this repository.

## What this repo is

This is a **plugin for the Viboplr desktop app** — NOT a standalone application.
Viboplr is a Tauri 2 desktop music app (Rust backend + React/TypeScript frontend);
its source lives in the separate host repo **`outcast1000/viboplr`** (likely not
checked out on this machine). This repo contains only the TIDAL plugin and ships
it as a versioned release that the host app downloads and auto-updates.

- **Plugin id:** `tidal-browse` (set in `manifest.json`). The plugin is installed
  from the Viboplr plugin gallery (it is not bundled in the app).
- **What it does:** search, stream, and download from TIDAL. It talks to TIDAL
  over HTTP through the host's `api.network.fetch` (which proxies through Rust to
  bypass CORS). It needs **no** native/Rust backend support — all logic is in JS.

## The plugin runtime (host-imposed — do not assume a normal Node/browser env)

The host runs `index.js` as the body of `new Function("api", "window", "globalThis",
"self", "document", code)` inside the app's WebView. Consequences:

- The file **must end with** `return { activate, deactivate };` (deactivate optional).
  The host calls `activate(api)` on load.
- `api` (the host bridge) is the ONLY way to talk to the app. Full API reference
  lives in the host repo's `PLUGIN-API-REFERENCE.md`; this plugin uses:
  `api.network.fetch` (proxied through Rust — there is **no global `fetch`**;
  supports an `insecure: true` option for cert bypass), `api.storage`,
  `api.playback` (play / insertTrack / onStreamResolve), `api.downloads`
  (enqueue / onResolveByUri / onResolveByMetadata / interactive search),
  `api.imageProviders`, `api.contextMenu`, `api.playlists`, `api.ui.setViewData`,
  `api.log(level, msg, section)`.
- The sandbox is a **frozen** set of globals: `console`, `Math`, `JSON`, `Date`,
  `Promise`, `Object`, `Array`, `String`, `Number`, `RegExp`, `Error`, timers,
  `encode/decodeURIComponent`, `parseInt/parseFloat/isNaN/isFinite`. **No** `require`/
  `import`, no real DOM, no filesystem. Modern JS syntax is fine (no transpile step),
  but this file uses `var`/`function` style by convention — match it.

## Critical gotchas (proven by the spotify plugin's history)

- **Manifest id vs folder name:** when the host loads a plugin from a "dev folder",
  it keys the plugin by the **manifest `id`** (`tidal-browse`), not the directory
  name (`viboplr-tidal`). Keep `manifest.json`'s `"id": "tidal-browse"` unchanged.
- **Release zip layout:** `tidal.zip` MUST have `manifest.json` at its ROOT (the
  host's installer does not strip a wrapper folder). `scripts/package.sh` guarantees
  this — never hand-zip a folder.
- **No browser/Tauri dev harness exists** for plugins. The realistic dev loop is to
  install/symlink this folder into the host app and reload. See `DEVELOPING.md`.

## How to release

See `README.md` → *Develop & Release*. In short:
1. Edit `index.js` / `manifest.json`; **bump the version** (`scripts/bump.sh patch|minor|major`).
2. Update `CHANGELOG.md` (top `## vX.Y.Z` section).
3. Push a tag `vX.Y.Z` (or run the *Release* GitHub Action manually) — CI builds
   `tidal.zip` + `update.json` and publishes the release. The host checks the
   permanent `releases/latest/download/update.json` every 24h.

## Docs in this repo

- `README.md` — install + release flow
- `DEVELOPING.md` — plugin develop/debug workflow (sandbox, reload loop, DevTools, `api.log`)
