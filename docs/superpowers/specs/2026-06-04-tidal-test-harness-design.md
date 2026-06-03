# TIDAL plugin test harness — design

**Date:** 2026-06-04
**Status:** Approved (pending user spec review)
**Topic:** A Node test harness for the `tidal-browse` Viboplr plugin

## Background

`tidal-browse` is a single-file Viboplr plugin (`index.js`). The host runs it as
the body of `new Function("api", "window", "globalThis", "self", "document",
code)` and expects the file to `return { activate, deactivate }`. There is **no
build step, no transpile, and no browser/Tauri dev harness** for plugins — the
only way to run the code today is to install it into the host app and reload.

The repo currently has **zero automated tests**. It previously carried an
in-production "Mock Mode" (hardcoded fake tracks + SoundHelix stream URLs, gated
by a settings toggle) that shipped to end users. That has been removed; this
harness is its clean replacement — fake the host bridge *from outside* rather
than faking data *inside* the production file.

All of the plugin's interesting logic (`parseTrack`, `prioritizeInstances`,
`extFromMimeType`, `downloadExt`, the BTS stream-manifest decode, `tidalSearch`,
the instance health/fallback machinery) lives as **inner functions inside
`activate(api)`**. Nothing is exported. The harness therefore tests behavior
**through the registered handlers** and asserts on the effects the plugin pushes
back through the fake `api`.

## Goals

- Run the **real** `index.js` outside the host app, with a faithful fake `api`
  bridge and sandbox globals.
- Deterministic, fast, dependency-free mocked tests that gate releases via CI.
- An opt-in **live** tier that exercises the real TIDAL mirror network, to catch
  upstream drift the mocks cannot (dead mirrors, changed JSON shapes).
- No production code changes to `index.js` for testability (behavior-only
  testing, validated through the host's handler surface).

## Non-goals (YAGNI)

- No UI-pixel assertions. We assert the **shape** of `setViewData` payloads
  (data correctness), not rendered output.
- No coverage of every `onAction` handler. Cover the load-bearing flows and the
  pure transforms behind them — not trivial pass-throughs like
  `open-status-page`.
- No browser dev harness, no interactive REPL, no test framework dependency.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Harness type | Node test harness (load `index.js`, fake `api`, assert behavior) |
| Test runner | `node:test` + `node:assert/strict` — **zero npm dependencies** |
| Test surface | Behavior-only via registered handlers; `index.js` untouched |
| CI | Yes — `test.yml` runs `npm test` on push/PR (mocked only) |
| Live tests | Yes — separate opt-in tier |
| Live all-down outcome | **Skip, not fail** (inconclusive ≠ regression) |
| Live trigger | Env var `TIDAL_LIVE=1` via `npm run test:live`; never in CI |

## Architecture

Five pieces, no runtime dependencies. Node 22 (repo's installed version) provides
global `fetch` and `atob` natively.

```
test/
├── harness.js              # loadPlugin() — core fake bridge + handler capture
├── fixtures/               # canned TIDAL API responses (JSON)
│   ├── search-tracks.json
│   ├── search-artists.json
│   ├── search-albums.json
│   ├── track-info.json
│   ├── album.json
│   └── stream-manifest.json  # holds a base64 BTS manifest string
├── lifecycle.test.js
├── search.test.js
├── stream-resolve.test.js
├── download.test.js
├── instances.test.js
└── live/
    └── smoke.live.test.js  # opt-in: TIDAL_LIVE=1
package.json                # scripts only, no deps
.github/workflows/test.yml  # runs `npm test` (mocked) on push + PR
```

### `test/harness.js` — the core

Exports `loadPlugin(opts)`:

1. Reads `index.js` from disk and wraps it exactly as the host does:
   `new Function("api", "window", "globalThis", "self", "document", body)`, then
   invokes it to obtain `{ activate, deactivate }`.
2. Builds a **fake `api` bridge** covering the surface this plugin uses:
   - `network.fetch(url, opts)` — **pluggable**. Defaults to a programmable stub
     that throws on an unmapped URL (a forgotten stub fails loudly, never
     silently passes). Tests register URL→response mappings returning
     `{ ok, status, json(), text() }`. Live tests pass a real-`fetch`-backed impl.
   - `network.openUrl` — recorded no-op.
   - `storage` — in-memory `Map` with `get`/`set` (async).
   - `playback` — `playTrack`/`playTracks`/`insertTracks`/`onStreamResolve`/
     `onResolveStreamByUri` — calls recorded; resolver callbacks captured.
   - `downloads` — `enqueue` + `onGetQualities`/`onResolveByUri`/
     `onResolveByMetadata`/`onInteractiveSearch`/`onInteractiveResolve` — calls
     recorded; resolver callbacks captured.
   - `imageProviders.onFetch` — callbacks captured.
   - `contextMenu.onAction` — callbacks captured.
   - `playlists.getTracks` — programmable stub.
   - `ui` — `setViewData`/`setBadge`/`showNotification`/`navigateToView`/
     `requestAction` recorded; `onAction(name, cb)` captures handlers.
   - `log` — recorded no-op.
3. **Captures every registered handler** into a registry keyed by name, exposing
   test-driver helpers:
   - `h.action(name, data)` → invokes the `ui.onAction` handler.
   - `h.contextAction(name, target)` → invokes the `contextMenu.onAction` handler.
   - `h.streamResolveByUri(trackId, quality)` / `h.streamResolveFallback(...)`.
   - `h.resolveByUri(uri, format)` / `h.resolveByMetadata(...)` / `h.getQualities()`.
   - `h.imageFetch(entity, ...args)`.
4. **Records outbound effects** as inspectable arrays:
   `h.fetches`, `h.views` (setViewData payloads), `h.badges`, `h.playbacks`,
   `h.downloads`, `h.notifications`, `h.logs`.
5. Provides **sandbox-faithful globals**: `console`, `Math`, `JSON`, `Date`,
   `Promise`, `Object`, `Array`, `String`, `Number`, `RegExp`, `Error`, timers,
   `encode/decodeURIComponent`, `parseInt/parseFloat/isNaN/isFinite`, **plus
   `atob`** (see Flagged finding). `window`/`globalThis`/`self`/`document` are
   passed as a frozen stub object, matching the host's frozen sandbox.

Each test calls `loadPlugin()` for a fresh instance (new `state`, new interval)
and runs `deactivate()` in a `t.after` hook so the health-check `setInterval`
never leaks between tests.

### Mocked test suites (`npm test`)

- **`lifecycle.test.js`** — the module returns an object with `activate`/
  `deactivate` functions; `activate(api)` registers the expected resolvers and
  view; `deactivate()` clears the health-check interval (verified via a fake
  timer or by asserting `clearInterval` was reached and no further `fetchInstances`
  fire).
- **`search.test.js`** — stub the three `/search/` URLs with fixture JSON, drive
  `h.action("search", {query})`, await, assert the latest `setViewData` for
  `"tidal"` contains the parsed tracks/artists/albums. Cover the partial-failure
  case (one of three search fetches rejects → that section is empty, others
  still render).
- **`stream-resolve.test.js`** — stub `/track/?id=...` to return a fixture BTS
  manifest; `h.streamResolveByUri(id, "LOSSLESS")` resolves to the decoded URL.
  Returns `null` when streaming is down (`state.streamingDown`) and when the
  manifest is missing/non-BTS.
- **`download.test.js`** — `downloadExt`/`extFromMimeType` behavior exercised via
  `h.resolveByMetadata`/`h.resolveByUri`: the FLAC-in-MP4 case (manifest mimeType
  `audio/mp4` while format is `flac` → ext follows the container), default
  fallbacks, and the `downloads.enqueue` payload shape.
- **`instances.test.js`** — uptime-API success returns the merged instance list;
  all uptime URLs failing falls back to `FALLBACK_INSTANCES`;
  `uniqueInstances` dedupes and `prioritizeInstances` orders as expected; the
  degraded-state badge is set via `ui.setBadge`.

### Live test tier (`npm run test:live`)

- Gated by `process.env.TIDAL_LIVE`. When unset, the suite `t.skip`s entirely so
  `npm test` and CI never touch the network.
- Reuses `loadPlugin()` but injects a `network.fetch` backed by Node's global
  `fetch`. Cert-bypass (`insecure: true`) is best-effort/approximated; if a
  mirror requires it and Node can't, that instance simply isn't reachable.
- **Skip-on-all-down:** the suite first probes for any reachable API instance via
  the plugin's own health path. If none, every live test `t.skip`s with
  `"no TIDAL mirrors reachable — inconclusive"`. A live *failure* therefore means
  a mirror answered but a shape/parse assumption broke — a real finding.
- **Resilient assertions** (tolerant of which mirror answers, strict on shape):
  - at least one API instance is reachable after `fetchInstances`;
  - a known-stable search returns ≥1 track that parses without throwing and has a
    non-empty `tidal_id` + `title`;
  - a known track ID resolves to a non-empty stream URL.

### `package.json`

```json
{
  "name": "viboplr-tidal",
  "private": true,
  "scripts": {
    "test": "node --test test/",
    "test:live": "TIDAL_LIVE=1 node --test test/live/"
  }
}
```

No dependencies. `.gitignore` already excludes only `tidal.zip`/`update.json`, so
`test/` and `package.json` are tracked normally. `package.json` is **not** added
to `tidal.zip` (the release packager only includes `manifest.json` + `index.js`
+ declared assets — to be confirmed against `scripts/package.sh` during
implementation).

### CI — `.github/workflows/test.yml`

- Triggers: `push` and `pull_request`.
- Steps: checkout → `actions/setup-node` (Node 22) → `npm test`.
- Runs **mocked tests only**. The live suite is never invoked in CI.
- Independent of the existing `release.yml`. Optionally, `release.yml` may later
  be made to depend on a green test run; not required for this spec.

## Error handling philosophy

- Unmapped `network.fetch` URL → the stub **throws**, surfacing forgotten stubs.
- Handlers that intentionally swallow errors (e.g. `tidalSearch`'s per-request
  `.catch`) are tested for their **graceful output** (empty arrays / error view),
  not for propagating.
- `node:assert/strict` everywhere. One `loadPlugin()` per test; `deactivate()` in
  `t.after` for isolation.

## Flagged finding (RESOLVED defensively)

The BTS stream-manifest decode originally called `atob(manifest)` directly.
`atob` is **not** in the sandbox global list documented in `DEVELOPING.md` and
`CLAUDE.md` — so either the host provides it undocumented, or stream resolution
was silently broken in the real sandbox (every stream attempt would hit the
`catch` and return `null`).

Rather than depend on the unknown, the plugin now decodes through a
`decodeBase64()` helper that uses `atob` as a fast path when present and falls
back to a self-contained pure-JS base64 decoder otherwise. This removes the
dependency on a browser global regardless of which case is true. The fallback
was verified byte-for-byte against `atob` across all padding cases, empty input,
and `+`/`/` characters.

The harness still provides `atob` so the fast path is exercised; a live test (or
a sandbox-without-atob unit test) can additionally cover the fallback path. The
host-sandbox question is now a documentation issue, not a correctness risk.

## Open questions

- Confirm `scripts/package.sh` does not bundle `package.json`/`test/` into
  `tidal.zip` (expected: it doesn't; verify during implementation).
- Confirm the exact set of `api` methods/signatures against the host's
  `PLUGIN-API-REFERENCE.md` if available; otherwise infer from `index.js` usage
  (the harness only needs to satisfy what `index.js` actually calls).
