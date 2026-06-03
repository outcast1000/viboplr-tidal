# TIDAL Plugin Test Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a zero-dependency Node test harness that loads the real `index.js` with a fake `api` bridge, drives the plugin through its registered handlers, and asserts on the effects it produces — plus an opt-in live tier against the real TIDAL mirrors.

**Architecture:** A `test/harness.js` module loads `index.js` inside a `node:vm` context (so the plugin's bare globals — `setInterval`, `atob`, `Math`, … — resolve to a controlled sandbox, mirroring the host's frozen-global environment more faithfully than `new Function` can), injects a fake `api` bridge that captures registered handlers and records outbound effects, and exposes driver helpers. Mocked `node:test` suites feed canned fixtures through `network.fetch` and assert on captured effects. A separate `test/live/` suite swaps in real `fetch` and skips when no mirror is reachable.

**Tech Stack:** Node 22 (`node:test`, `node:assert/strict`, `node:fs`, `node:path`), no npm dependencies. Global `fetch` and `atob` are available in Node 22.

---

## Reference facts (from `index.js`, verified against the source)

These are the exact shapes the harness must satisfy and the tests assert on. Do not guess — these are read from the current `index.js`.

**Module shape:** the file ends with `return { activate: activate, deactivate: deactivate };` and is run as the body of `new Function("api","window","globalThis","self","document", code)`. `activate(api)` is called once; `deactivate()` clears a module-level `setInterval` stored in `_healthCheckInterval`.

**`api` methods actually called by `index.js`:**
- `api.network.fetch(url, opts)` → returns `{ status, json(), text() }` (a Response-like). Called with `{ insecure: true }`. Also `api.network.openUrl(url)`.
- `api.storage.get(key)` → Promise; `api.storage.set(key, value)`.
- `api.playback.playTrack(t)`, `api.playback.playTracks(arr, startIndex, opts?)`, `api.playback.insertTracks(arr, index)`.
- `api.playback.onStreamResolve(name, cb)`, `api.playback.onResolveStreamByUri(name, cb)`.
- `api.downloads.enqueue(obj)`, `api.downloads.onGetQualities(name, cb)`, `api.downloads.onResolveByUri(name, cb)`, `api.downloads.onResolveByMetadata(name, cb)`, `api.downloads.onInteractiveSearch(name, cb)`, `api.downloads.onInteractiveResolve(name, cb)`.
- `api.imageProviders.onFetch(entity, cb)`.
- `api.contextMenu.onAction(name, cb)`.
- `api.playlists.getTracks(playlistId)` → Promise.
- `api.ui.setViewData(viewId, payload)`, `api.ui.setBadge(viewId, badgeOrNull)`, `api.ui.onAction(name, cb)`, `api.ui.requestAction(name, data)`, `api.ui.showNotification(msg)`, `api.ui.navigateToView(viewId)`.
- `api.log(level, message, section)`.

**Handler names registered** (via `api.ui.onAction`): `search`, `switch-tab`, `play-track`, `play-selected`, `queue-selected`, `download-selected`, `play-playlist`, `download-album-card`, `play-album`, `view-album`, `view-artist`, `go-back`, `view-artist-details`, `view-album-details`, `download-track`, `download-album`, `retry`, `set-quality`, `open-status-page`, `check-health`.

**Resolvers:** `playback.onStreamResolve("tidal-fallback", cb)`, `playback.onResolveStreamByUri("tidal", cb)`, `downloads.onResolveByUri("tidal-download", cb)`, `downloads.onResolveByMetadata("tidal-download", cb)`, `downloads.onGetQualities("tidal-download", cb)`, `downloads.onInteractiveSearch("tidal-download", cb)`, `downloads.onInteractiveResolve("tidal-download", cb)`, `imageProviders.onFetch("artist"|"album", cb)`, `contextMenu.onAction(name, cb)`.

**`search` action behavior:** sets `state.searching=true`, calls `render()` (→ `api.ui.setViewData("tidal", payload)`), then `tidalSearch(query, 30)` which fires THREE `api.network.fetch` calls to paths starting `/search/?s=`, `/search/?a=`, `/search/?al=`. On success re-renders with results; on reject calls `renderError` (a `setViewData("tidal", {type:"error",...})`).

**`tidalSearch` parsing** (the fetched JSON shapes):
- tracks: `json.data.items` → array of raw tracks, each mapped by `parseTrack`.
- artists: `json.data.artists.items` → mapped by `parseArtist`.
- albums: `json.data.albums.items` → mapped by `parseAlbum`.
- `parseTrack(t)` returns `{ tidal_id, title, artist_name, artist_id, album_title, album_id, cover_id, duration_secs, track_number }`. `tidal_id` is `String(t.id)`; `artist_name` from `t.artist.name` or `t.artists[0].name`; `album_title`/`album_id`/`cover_id` from `t.album.{title,id,cover}`; `duration_secs` from `t.duration`; `track_number` from `t.trackNumber`.

**Stream resolve (`onResolveStreamByUri("tidal")`):** returns `Promise<null>` if `state.streamingDown`; else `tidalGetStreamUrl(trackId, quality)` → calls `tidalFetch("/track/?id="+id+"&quality="+q)`, reads `data.manifest` (base64) + `data.manifestMimeType` (must equal `"application/vnd.tidal.bts"`), decodes via `decodeBase64`, `JSON.parse`, returns `parsed.urls[0]`. Returns `null` if manifest missing/non-BTS/empty urls.

**`tidalFetch` gating:** throws `"TIDAL streaming servers are currently unavailable"` if a `/track`/`/stream` path is requested while `state.streamingDown`; throws `"TIDAL API servers are currently unavailable"` if a non-stream path while `state.apiDown`. Initial state: `apiDown:true, streamingDown:true` until `fetchInstances()` runs.

**Health/instances:** `fetchInstances()` calls `fetchInstanceCandidates()` (which fetches each `UPTIME_URLS[i]`, expecting `{ api:[...], streaming:[...] }` JSON with `status===200`; on all-fail uses `FALLBACK_INSTANCES`), then `probeInstances()` (fetches a probe path per instance — `/search/?s=test&limit=1` for api, `/track/?id=35132878&quality=LOW` for streaming; streaming additionally requires `hasStreamPayload`). Sets `instanceCache`, `state.lastHealthCheck`, calls `updateHealthState(apiUp, streamingUp)` which sets `apiDown`/`streamingDown` and calls `render()`. Degraded state → `api.ui.setBadge("tidal", {type:"dot",variant:"error"})`; healthy → `setBadge("tidal", null)`.

**Download resolvers:**
- `onResolveByUri(uri, format)`: returns `null` unless `uri` starts `tidal://` and streaming up; `quality = format==="flac" ? "LOSSLESS" : "HIGH"`; resolves stream, returns `{ url, headers:null, metadata:null, ext: downloadExt(format, stream.mimeType) }`.
- `onResolveByMetadata(title, artistName, albumName, durationSecs, format)`: searches `[title,artistName].join(" ")` limit 1, resolves first track's stream, returns `{ url, headers:null, ext, metadata:{...} }`.
- `downloadExt(format, mimeType)`: `extFromMimeType(mimeType) || (format==="flac" ? "flac" : "m4a")`. `extFromMimeType`: contains `flac`→`"flac"`; `mp4`/`m4a`/`aac`→`"m4a"`; `mpeg`/`mp3`→`"mp3"`; else `null`. So `downloadExt("flac","audio/mp4")` === `"m4a"` (container wins).

**`decodeBase64` fallback:** top-level function; uses `atob` when present, else pure-JS decode. The fallback path is testable by deleting `atob` from the injected globals.

**Verified fixtures (base64 of exact JSON):**
- `{"mimeType":"audio/mp4","urls":["https://cdn.example/track.flac"]}` → `eyJtaW1lVHlwZSI6ImF1ZGlvL21wNCIsInVybHMiOlsiaHR0cHM6Ly9jZG4uZXhhbXBsZS90cmFjay5mbGFjIl19`
- `{"mimeType":"audio/flac","urls":["https://cdn.example/track2.flac"]}` → `eyJtaW1lVHlwZSI6ImF1ZGlvL2ZsYWMiLCJ1cmxzIjpbImh0dHBzOi8vY2RuLmV4YW1wbGUvdHJhY2syLmZsYWMiXX0=`

**Packaging:** `scripts/package.sh:18` runs `zip -q tidal.zip manifest.json index.js` — only those two files ship. `test/`, `package.json`, and docs are NOT bundled. No change needed.

---

## File Structure

- Create: `package.json` — scripts only, no deps.
- Create: `test/harness.js` — `loadPlugin()`, fake `api`, handler capture, effect recording, driver helpers, `plain()`.
- Create: `test/helpers.js` — shared test fixtures/stubs: `fixture()`, `upStubs()`, `searchStubs()`. (Extracted after the per-task implementation to remove byte-identical duplication across the suites; the individual task steps below show these helpers inline — in the shipped code they live in `test/helpers.js` and are imported.)
- Create: `test/fixtures/search-tracks.json`, `search-artists.json`, `search-albums.json`, `stream-manifest.json`.
- Create: `test/lifecycle.test.js`, `test/search.test.js`, `test/stream-resolve.test.js`, `test/download.test.js`, `test/instances.test.js`.
- Create: `test/live/smoke.live.test.js` — opt-in live tier.
- Create: `.github/workflows/test.yml` — runs `npm test` on push/PR.

---

## Task 1: Project scaffolding (`package.json`)

**Files:**
- Create: `package.json`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "viboplr-tidal",
  "version": "0.0.0",
  "private": true,
  "description": "Test harness for the tidal-browse Viboplr plugin",
  "scripts": {
    "test": "node --test test/*.test.js",
    "test:live": "TIDAL_LIVE=1 node --test test/live/*.test.js"
  }
}
```

- [ ] **Step 2: Verify the test runner starts (no tests yet)**

Run: `npm test`
Expected: exits successfully reporting `tests 0` (no test files yet), or a "no test files found" message — either way exit code 0. If `npm` complains about a missing field, fix `package.json`.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "test: add package.json with test + test:live scripts"
```

---

## Task 2: Harness core — load plugin + fake `api` + handler capture

**Files:**
- Create: `test/harness.js`
- Test: `test/lifecycle.test.js`

- [ ] **Step 1: Write the failing test** (`test/lifecycle.test.js`)

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPlugin } = require("./harness.js");

test("loadPlugin returns activate/deactivate and registers core resolvers", async (t) => {
  const h = loadPlugin();
  t.after(() => h.deactivate());

  assert.equal(typeof h.activate, "function");
  assert.equal(typeof h.deactivate, "function");
  // The plugin registers these resolver names during activate():
  assert.ok(h.has.streamResolveByUri, "onResolveStreamByUri('tidal') registered");
  assert.ok(h.has.streamResolveFallback, "onStreamResolve('tidal-fallback') registered");
  assert.ok(h.has.resolveByUri, "downloads.onResolveByUri registered");
  assert.ok(h.has.resolveByMetadata, "downloads.onResolveByMetadata registered");
  // It renders the main "tidal" view during activate(). Note render() always
  // calls renderSettings() last, so the LAST view is "tidal-settings"; assert
  // presence of a "tidal" view rather than that it is last.
  assert.ok(h.views.length >= 1, "at least one setViewData call");
  assert.ok(h.views.some((v) => v.viewId === "tidal"), "rendered the tidal view");
});

test("deactivate clears the health-check interval", async () => {
  const h = loadPlugin();
  assert.equal(h.timers.activeIntervals(), 1, "one setInterval active after activate");
  h.deactivate();
  assert.equal(h.timers.activeIntervals(), 0, "interval cleared after deactivate");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/lifecycle.test.js`
Expected: FAIL — `Cannot find module './harness.js'`.

- [ ] **Step 3: Write `test/harness.js`**

```js
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const PLUGIN_PATH = path.join(__dirname, "..", "index.js");

// Default network.fetch: throws on any unmapped URL so a forgotten stub fails
// loudly. Tests override via opts.fetch or h.stubFetch().
function makeThrowingFetch(label) {
  return async function (url) {
    throw new Error(label + ": unstubbed network.fetch for " + url);
  };
}

// Re-root a value into the test realm. The plugin runs in a vm context with
// its OWN intrinsics, so arrays/objects it returns are not `instanceof` the
// test realm's Array/Object — `assert.deepEqual` (strict) compares prototypes
// and fails on that mismatch even when the data is identical. A JSON round-trip
// rebuilds the value using the test realm's intrinsics. Use this when deep-
// comparing plugin-returned structured data (arrays/objects); not needed for
// primitive (`assert.equal`) comparisons.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// A minimal Response-like for the fake bridge.
function makeResponse(body, status) {
  const isString = typeof body === "string";
  return {
    status: status == null ? 200 : status,
    async json() { return isString ? JSON.parse(body) : body; },
    async text() { return isString ? body : JSON.stringify(body); },
  };
}

function loadPlugin(opts) {
  opts = opts || {};

  // --- Fake timer tracking (so we can assert deactivate cleans up) ---
  // These fakes are injected into the vm sandbox; Node's real timers are never
  // patched. The plugin's _healthCheckInterval therefore uses these.
  let nextTimerId = 1;
  const liveIntervals = new Set();
  function fakeSetInterval() { const id = nextTimerId++; liveIntervals.add(id); return id; }
  function fakeClearInterval(id) { liveIntervals.delete(id); }

  // --- Effect recorders ---
  const fetches = [];   // { url, opts }
  const views = [];     // { viewId, payload }
  const badges = [];     // { viewId, badge }
  const playbacks = []; // { method, args }
  const downloads = []; // enqueue payloads
  const notifications = [];
  const requests = [];  // ui.requestAction { name, data }
  const logs = [];      // { level, message, section }

  // --- Handler registries ---
  const uiActions = {};
  const contextActions = {};
  const imageFetchers = {};
  const resolvers = {}; // streamResolveByUri, streamResolveFallback, resolveByUri, resolveByMetadata, getQualities, interactiveSearch, interactiveResolve

  // --- Programmable network.fetch ---
  let fetchImpl = opts.fetch || makeThrowingFetch("harness");

  const api = {
    network: {
      async fetch(url, fetchOpts) {
        fetches.push({ url: url, opts: fetchOpts });
        return fetchImpl(url, fetchOpts);
      },
      openUrl() {},
    },
    storage: (function () {
      const store = new Map(Object.entries(opts.storage || {}));
      return {
        async get(key) { return store.has(key) ? store.get(key) : null; },
        async set(key, value) { store.set(key, value); },
      };
    })(),
    playback: {
      playTrack(t) { playbacks.push({ method: "playTrack", args: [t] }); },
      playTracks(arr, i, o) { playbacks.push({ method: "playTracks", args: [arr, i, o] }); },
      insertTracks(arr, i) { playbacks.push({ method: "insertTracks", args: [arr, i] }); },
      onStreamResolve(name, cb) { resolvers.streamResolveFallback = cb; },
      onResolveStreamByUri(name, cb) { resolvers.streamResolveByUri = cb; },
    },
    downloads: {
      enqueue(obj) { downloads.push(obj); return Promise.resolve(); },
      onGetQualities(name, cb) { resolvers.getQualities = cb; },
      onResolveByUri(name, cb) { resolvers.resolveByUri = cb; },
      onResolveByMetadata(name, cb) { resolvers.resolveByMetadata = cb; },
      onInteractiveSearch(name, cb) { resolvers.interactiveSearch = cb; },
      onInteractiveResolve(name, cb) { resolvers.interactiveResolve = cb; },
    },
    imageProviders: {
      onFetch(entity, cb) { imageFetchers[entity] = cb; },
    },
    contextMenu: {
      onAction(name, cb) { contextActions[name] = cb; },
    },
    playlists: {
      getTracks(id) { return Promise.resolve((opts.playlists && opts.playlists[id]) || []); },
    },
    ui: {
      setViewData(viewId, payload) { views.push({ viewId: viewId, payload: payload }); },
      setBadge(viewId, badge) { badges.push({ viewId: viewId, badge: badge }); },
      onAction(name, cb) { uiActions[name] = cb; },
      requestAction(name, data) { requests.push({ name: name, data: data }); },
      showNotification(msg) { notifications.push(msg); },
      navigateToView(viewId) { requests.push({ name: "navigateToView", data: viewId }); },
    },
    log(level, message, section) { logs.push({ level: level, message: message, section: section }); },
  };

  // --- Sandbox globals (mirror the host's frozen set) + atob, plus the timer fakes ---
  //
  // CRITICAL: we load via node:vm, NOT `new Function`. With `new Function`, a
  // *bare* reference inside index.js (e.g. `setInterval(...)`, `atob(...)`,
  // `Math`) resolves to Node's REAL global, ignoring the `window`/`globalThis`
  // params — so timer tracking and the noAtob test would silently no-op. A vm
  // context makes bare globals resolve to exactly this sandbox object, which is
  // also more faithful to the host's frozen-global environment.
  const sandbox = {
    console: console, Math: Math, JSON: JSON, Date: Date, Promise: Promise,
    Object: Object, Array: Array, String: String, Number: Number, RegExp: RegExp,
    Error: Error, encodeURIComponent: encodeURIComponent, decodeURIComponent: decodeURIComponent,
    parseInt: parseInt, parseFloat: parseFloat, isNaN: isNaN, isFinite: isFinite,
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    setInterval: fakeSetInterval, clearInterval: fakeClearInterval,
    atob: opts.noAtob ? undefined : (typeof atob === "function" ? atob : undefined),
  };
  // The host passes window/globalThis/self/document as a frozen object; index.js
  // doesn't touch the DOM, so a frozen empty object suffices for those params.
  const frozen = Object.freeze({});

  // --- Load and run index.js as the host does (sandboxed globals) ---
  const code = fs.readFileSync(PLUGIN_PATH, "utf8");
  const context = vm.createContext(sandbox);
  const wrapped = "(function (api, window, globalThis, self, document) {\n" + code + "\n})";
  const factory = vm.runInContext(wrapped, context, { filename: "index.js" });
  const mod = factory(api, frozen, frozen, frozen, frozen);
  mod.activate(api);

  // --- Driver helpers ---
  return {
    activate: mod.activate,
    deactivate: mod.deactivate || function () {},
    api: api,
    // recorders
    fetches: fetches, views: views, badges: badges, playbacks: playbacks,
    downloads: downloads, notifications: notifications, requests: requests, logs: logs,
    // registry presence flags
    has: {
      get streamResolveByUri() { return !!resolvers.streamResolveByUri; },
      get streamResolveFallback() { return !!resolvers.streamResolveFallback; },
      get resolveByUri() { return !!resolvers.resolveByUri; },
      get resolveByMetadata() { return !!resolvers.resolveByMetadata; },
    },
    // drivers
    action(name, data) {
      if (!uiActions[name]) throw new Error("no ui action handler: " + name);
      return uiActions[name](data);
    },
    contextAction(name, target) {
      if (!contextActions[name]) throw new Error("no context action handler: " + name);
      return contextActions[name](target);
    },
    streamResolveByUri(id, quality) { return resolvers.streamResolveByUri(id, quality); },
    streamResolveFallback(title, artist, album) { return resolvers.streamResolveFallback(title, artist, album); },
    resolveByUri(uri, format) { return resolvers.resolveByUri(uri, format); },
    resolveByMetadata(title, artist, album, dur, format) { return resolvers.resolveByMetadata(title, artist, album, dur, format); },
    getQualities() { return resolvers.getQualities(); },
    imageFetch(entity) { var rest = Array.prototype.slice.call(arguments, 1); return imageFetchers[entity].apply(null, rest); },
    // network stub control
    stubFetch(map) {
      fetchImpl = async function (url) {
        // Match the most specific (longest) key first so an overlapping
        // shorter pattern can't shadow a more specific one.
        const keys = Object.keys(map).sort(function (a, b) { return b.length - a.length; });
        for (let i = 0; i < keys.length; i++) {
          if (url.indexOf(keys[i]) !== -1) {
            const entry = map[keys[i]];
            return makeResponse(entry.body, entry.status);
          }
        }
        throw new Error("harness.stubFetch: no mapping matched " + url);
      };
    },
    setFetch(fn) { fetchImpl = fn; },
    timers: { activeIntervals() { return liveIntervals.size; } },
    // Flush pending promise chains. Needed because some handlers (e.g.
    // check-health, search) are fire-and-forget: they kick off an async chain
    // but do NOT return the promise, so awaiting the handler is not enough.
    async settle(ms) { await new Promise((r) => setTimeout(r, ms == null ? 20 : ms)); },
    _restore() { /* timers are local fakes; nothing global was patched */ },
  };
}

module.exports = { loadPlugin: loadPlugin, makeResponse: makeResponse, plain: plain };
```

> Note: the harness injects `setInterval`/`clearInterval` into the plugin's frozen sandbox, so the plugin's `_healthCheckInterval` uses the fakes. It does NOT patch Node's globals. `liveIntervals` reflects the plugin's interval lifecycle.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/lifecycle.test.js`
Expected: PASS (2 tests). If `streamResolveByUri` is undefined, confirm `index.js` still registers `api.playback.onResolveStreamByUri("tidal", ...)`.

- [ ] **Step 5: Commit**

```bash
git add test/harness.js test/lifecycle.test.js
git commit -m "test: add harness core (loadPlugin, fake api, lifecycle tests)"
```

---

## Task 3: Fixtures for search + stream

**Files:**
- Create: `test/fixtures/search-tracks.json`
- Create: `test/fixtures/search-artists.json`
- Create: `test/fixtures/search-albums.json`
- Create: `test/fixtures/stream-manifest.json`

- [ ] **Step 1: Write `test/fixtures/search-tracks.json`**

Matches the `json.data.items` shape `parseTrack` reads.

```json
{
  "data": {
    "items": [
      {
        "id": 1001,
        "title": "Test Song",
        "duration": 210,
        "trackNumber": 3,
        "artist": { "id": 50, "name": "Test Artist" },
        "album": { "id": 900, "title": "Test Album", "cover": "aaaa-bbbb-cccc" }
      }
    ]
  }
}
```

- [ ] **Step 2: Write `test/fixtures/search-artists.json`**

Matches `json.data.artists.items` shape `parseArtist` reads.

```json
{ "data": { "artists": { "items": [ { "id": 50, "name": "Test Artist", "picture": "pic-1234" } ] } } }
```

- [ ] **Step 3: Write `test/fixtures/search-albums.json`**

Matches `json.data.albums.items` shape `parseAlbum` reads.

```json
{ "data": { "albums": { "items": [ { "id": 900, "title": "Test Album", "cover": "aaaa-bbbb-cccc", "releaseDate": "2019-05-10", "artists": [ { "id": 50, "name": "Test Artist" } ] } ] } } }
```

- [ ] **Step 4: Write `test/fixtures/stream-manifest.json`**

Matches the `/track/?id=...` response `tidalGetStream` reads. `manifest` is the verified base64 of `{"mimeType":"audio/mp4","urls":["https://cdn.example/track.flac"]}`.

```json
{
  "data": {
    "manifestMimeType": "application/vnd.tidal.bts",
    "manifest": "eyJtaW1lVHlwZSI6ImF1ZGlvL21wNCIsInVybHMiOlsiaHR0cHM6Ly9jZG4uZXhhbXBsZS90cmFjay5mbGFjIl19"
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add test/fixtures/
git commit -m "test: add TIDAL API fixtures (search + BTS stream manifest)"
```

---

## Task 4: Search flow tests

**Files:**
- Create: `test/search.test.js`

The `search` action triggers three `/search/` fetches. We bring the plugin's API "up" by stubbing the uptime + probe calls first, then run search. Simpler: directly clear the down-state by running a successful `check-health` with stubbed instances. To keep this test focused on parsing, we stub ALL fetches: uptime URLs return a small instance list, probe + search return fixtures.

- [ ] **Step 1: Write the failing test** (`test/search.test.js`)

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadPlugin } = require("./harness.js");

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"));
}

// Read the tabs node's counts from a rendered search-view payload. Each tab's
// `count` is the number of parsed results in that category (omitted/undefined
// when zero). This is the meaningful signal that a category parsed, since
// renderSearchView only renders the *active* tab's items inline.
function tabCounts(payload) {
  const tabs = payload.children.find((c) => c.type === "tabs");
  const out = {};
  tabs.tabs.forEach((tb) => { out[tb.id] = tb.count; });
  return out;
}

// Stub map that brings instances "up" and answers searches with fixtures.
function searchStubs() {
  return {
    // uptime APIs: return one api + one streaming instance
    "tidal-uptime": { body: { api: [{ url: "https://api.test", version: "9.9" }], streaming: [{ url: "https://api.test", version: "9.9" }] }, status: 200 },
    // api probe (/search/?s=test&limit=1) and streaming probe (/track/?id=35132878)
    "id=35132878": { body: { data: { manifest: "x", url: "https://x" } }, status: 200 },
    "s=test&limit=1": { body: { data: { items: [] } }, status: 200 },
    // real searches (order: s=, a=, al=)
    "/search/?s=": { body: fixture("search-tracks.json"), status: 200 },
    "/search/?a=": { body: fixture("search-artists.json"), status: 200 },
    "/search/?al=": { body: fixture("search-albums.json"), status: 200 },
  };
}

test("search renders parsed tracks/artists/albums", async (t) => {
  const h = loadPlugin();
  t.after(() => h.deactivate());
  h.stubFetch(searchStubs());

  // Bring instances up first (the initial activate ran fetchInstances against
  // the throwing fetch and may have set down-state; re-run via check-health).
  // check-health is fire-and-forget, so settle() to let fetchInstances finish.
  h.action("check-health");
  await h.settle();

  h.action("search", { query: "test" });
  await h.settle(); // allow the search promise chain to settle

  const lastTidalView = [...h.views].reverse().find((v) => v.viewId === "tidal");
  assert.ok(lastTidalView, "rendered a tidal view");
  // The active (tracks) tab renders its items inline, so the track title shows.
  const json = JSON.stringify(lastTidalView.payload);
  assert.match(json, /Test Song/);
  // All three categories parsed — proven by their tab counts (the inactive
  // album/artist tabs don't render items, but their counts reflect the parse).
  assert.deepEqual(tabCounts(lastTidalView.payload), { tracks: 1, albums: 1, artists: 1 });
});

test("search degrades gracefully when one search request fails", async (t) => {
  const h = loadPlugin();
  t.after(() => h.deactivate());
  const stubs = searchStubs();
  // Make the artist search (a=) reject by removing its mapping and routing
  // unknown /search/?a= to a 500.
  h.setFetch(async (url) => {
    if (url.indexOf("/search/?a=") !== -1) return { status: 500, async json() { throw new Error("boom"); }, async text() { return ""; } };
    const keys = Object.keys(stubs);
    for (const k of keys) {
      if (url.indexOf(k) !== -1) {
        const e = stubs[k];
        return { status: e.status || 200, async json() { return e.body; }, async text() { return JSON.stringify(e.body); } };
      }
    }
    throw new Error("unmapped " + url);
  });

  h.action("check-health");
  await h.settle();
  h.action("search", { query: "test" });
  await h.settle();

  const lastTidalView = [...h.views].reverse().find((v) => v.viewId === "tidal");
  const json = JSON.stringify(lastTidalView.payload);
  // Tracks still render even though artist search failed.
  assert.match(json, /Test Song/);
  // Graceful degradation: tracks and albums still parsed, but the failed
  // artist search yields no artist results (count omitted), rather than the
  // whole search throwing or rendering nothing.
  const counts = tabCounts(lastTidalView.payload);
  assert.equal(counts.tracks, 1, "tracks survived the artist-search failure");
  assert.equal(counts.albums, 1, "albums survived the artist-search failure");
  assert.ok(!counts.artists, "failed artist search yields no artist results");
});
```

> Note on assertions: the inactive album/artist tabs don't render their items
> inline (only the active tracks tab does), and "Test Artist"/"Test Album"
> appear in every track row's subtitle regardless — so substring matching can't
> prove a category parsed. The tab `count` is the reliable signal, hence the
> `tabCounts()` helper.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/search.test.js`
Expected: FAIL initially only if harness lacks `stubFetch`/`setFetch`/`action` — which Task 2 provides. If Task 2 is done, this should pass; if it fails on view-shape assumptions, inspect with `console.log(JSON.stringify(lastTidalView.payload, null, 2))` and adjust the `assert.match` targets to the real rendered strings (track title/artist appear in `track-row-list` items per `index.js` `renderSearchView`).

- [ ] **Step 3: Adjust assertions to observed render shape if needed**

If `assert.match(json, /Test Song/)` fails, the render path may have hit the "API down" banner instead of results. Ensure `check-health` succeeded by asserting first:

```js
// after check-health, before search:
assert.equal(h.badges[h.badges.length - 1].badge, null, "healthy → badge cleared");
```

Add that line if diagnosis is needed; keep it if useful.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/search.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add test/search.test.js
git commit -m "test: cover search flow rendering + graceful partial failure"
```

---

## Task 5: Stream-resolve tests (incl. decodeBase64 fallback)

**Files:**
- Create: `test/stream-resolve.test.js`

- [ ] **Step 1: Write the failing test** (`test/stream-resolve.test.js`)

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadPlugin } = require("./harness.js");

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"));
}

function upStubs(extra) {
  return Object.assign({
    "tidal-uptime": { body: { api: [{ url: "https://api.test", version: "9" }], streaming: [{ url: "https://api.test", version: "9" }] }, status: 200 },
    "id=35132878": { body: { data: { manifest: "x", url: "https://x" } }, status: 200 },
    "s=test&limit=1": { body: { data: { items: [] } }, status: 200 },
  }, extra || {});
}

test("onResolveStreamByUri decodes BTS manifest to a URL", async (t) => {
  const h = loadPlugin();
  t.after(() => h.deactivate());
  h.stubFetch(upStubs({ "/track/?id=1001": { body: fixture("stream-manifest.json"), status: 200 } }));
  h.action("check-health");
  await h.settle();

  const url = await h.streamResolveByUri("1001", "LOSSLESS");
  assert.equal(url, "https://cdn.example/track.flac");
});

test("onResolveStreamByUri returns null when streaming is down", async (t) => {
  const h = loadPlugin();
  t.after(() => h.deactivate());
  // No check-health → state.streamingDown stays true (initial).
  const url = await h.streamResolveByUri("1001", "LOSSLESS");
  assert.equal(url, null);
});

test("decodeBase64 fallback works without atob", async (t) => {
  // Reload the plugin with atob removed from the sandbox to exercise the
  // pure-JS base64 fallback path.
  const h = loadPlugin({ noAtob: true });
  t.after(() => h.deactivate());
  h.stubFetch(upStubs({ "/track/?id=1001": { body: fixture("stream-manifest.json"), status: 200 } }));
  h.action("check-health");
  await h.settle();

  const url = await h.streamResolveByUri("1001", "LOSSLESS");
  assert.equal(url, "https://cdn.example/track.flac");
});
```

- [ ] **Step 2: Run to verify behavior**

Run: `node --test test/stream-resolve.test.js`
Expected: PASS (3 tests). The third proves `decodeBase64` does not depend on `atob`. If the third fails with a decode error, the fallback in `index.js` `decodeBase64` is wrong — fix `index.js`, not the test.

- [ ] **Step 3: Commit**

```bash
git add test/stream-resolve.test.js
git commit -m "test: cover stream resolve + atob-free base64 fallback"
```

---

## Task 6: Download resolver / extension tests

**Files:**
- Create: `test/download.test.js`

- [ ] **Step 1: Write the failing test** (`test/download.test.js`)

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadPlugin, plain } = require("./harness.js");

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"));
}

// Stub map that brings instances "up" (uptime + api/streaming probes), with
// optional `extra` mappings (e.g. a specific /track/?id=... manifest).
function upStubs(extra) {
  return Object.assign({
    "tidal-uptime": { body: { api: [{ url: "https://api.test", version: "9" }], streaming: [{ url: "https://api.test", version: "9" }] }, status: 200 },
    "id=35132878": { body: { data: { manifest: "x", url: "https://x" } }, status: 200 },
    "s=test&limit=1": { body: { data: { items: [] } }, status: 200 },
  }, extra || {});
}

test("onGetQualities returns aac then flac", async (t) => {
  const h = loadPlugin();
  t.after(() => h.deactivate());
  const qualities = h.getQualities();
  // plain() re-roots the plugin's vm-realm array into the test realm so
  // deepEqual's prototype check passes (see harness.js plain()).
  assert.deepEqual(plain(qualities).map((q) => q.value), ["aac", "flac"]);
});

test("resolveByUri returns m4a ext when manifest container is mp4 even for flac format", async (t) => {
  const h = loadPlugin();
  t.after(() => h.deactivate());
  // stream-manifest.json declares mimeType audio/mp4
  h.stubFetch(upStubs({ "/track/?id=1001": { body: fixture("stream-manifest.json"), status: 200 } }));
  h.action("check-health");
  await h.settle();

  const result = await h.resolveByUri("tidal://1001", "flac");
  assert.ok(result, "resolved");
  assert.equal(result.url, "https://cdn.example/track.flac");
  // downloadExt: container (mp4 -> m4a) wins over requested flac format.
  assert.equal(result.ext, "m4a");
});

test("resolveByUri returns null for non-tidal uri", async (t) => {
  const h = loadPlugin();
  t.after(() => h.deactivate());
  h.stubFetch(upStubs());
  h.action("check-health");
  await h.settle();
  const result = await h.resolveByUri("spotify://abc", "flac");
  assert.equal(result, null);
});

test("resolveByMetadata searches then resolves first track's stream", async (t) => {
  const h = loadPlugin();
  t.after(() => h.deactivate());
  h.stubFetch(upStubs({
    "/search/?s=": { body: fixture("search-tracks.json"), status: 200 },
    "/search/?a=": { body: { data: { artists: { items: [] } } }, status: 200 },
    "/search/?al=": { body: { data: { albums: { items: [] } } }, status: 200 },
    "/track/?id=1001": { body: fixture("stream-manifest.json"), status: 200 },
  }));
  h.action("check-health");
  await h.settle();

  const result = await h.resolveByMetadata("Test Song", "Test Artist", "Test Album", 210, "aac");
  assert.ok(result, "resolved");
  assert.equal(result.url, "https://cdn.example/track.flac");
  assert.equal(result.metadata.title, "Test Song");
  assert.equal(result.metadata.artist, "Test Artist");
});
```

- [ ] **Step 2: Run to verify it passes**

Run: `node --test test/download.test.js`
Expected: PASS (4 tests). The mp4-container-wins assertion is the key correctness check for `downloadExt`.

- [ ] **Step 3: Commit**

```bash
git add test/download.test.js
git commit -m "test: cover download resolvers + extension/container logic"
```

---

## Task 7: Instance health / fallback tests

**Files:**
- Create: `test/instances.test.js`

- [ ] **Step 1: Write the failing test** (`test/instances.test.js`)

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPlugin, plain } = require("./harness.js");

test("all uptime URLs failing falls back and probing finds no instances → degraded badge", async (t) => {
  const h = loadPlugin();
  t.after(() => h.deactivate());
  // Everything fails: uptime URLs throw, and probes throw too.
  h.setFetch(async (url) => { throw new Error("network down: " + url); });

  h.action("check-health");
  await h.settle();

  // With no reachable instance, health is degraded → error badge set on "tidal".
  const lastBadge = h.badges[h.badges.length - 1];
  assert.ok(lastBadge, "a badge call happened");
  // plain() re-roots the plugin's vm-realm object into the test realm so
  // deepEqual's prototype check passes (see harness.js plain()).
  assert.deepEqual(plain(lastBadge.badge), { type: "dot", variant: "error" });
});

test("reachable api+streaming instances → badge cleared (healthy)", async (t) => {
  const h = loadPlugin();
  t.after(() => h.deactivate());
  h.stubFetch({
    "tidal-uptime": { body: { api: [{ url: "https://api.test", version: "9" }], streaming: [{ url: "https://api.test", version: "9" }] }, status: 200 },
    // streaming probe must return a stream payload to count as usable
    "id=35132878": { body: { data: { manifest: "abc" } }, status: 200 },
    // api probe
    "s=test&limit=1": { body: { data: { items: [] } }, status: 200 },
  });

  h.action("check-health");
  await h.settle();

  const lastBadge = h.badges[h.badges.length - 1];
  assert.equal(lastBadge.badge, null, "healthy → badge cleared");
});
```

- [ ] **Step 2: Run to verify it passes**

Run: `node --test test/instances.test.js`
Expected: PASS (2 tests). If the healthy test fails because the streaming probe wasn't accepted, confirm the probe body satisfies `hasStreamPayload` (has `manifest`/`url`/`streamUrl`/`originalTrackUrl`).

- [ ] **Step 3: Run the full mocked suite**

Run: `npm test`
Expected: PASS — all suites green (lifecycle, search, stream-resolve, download, instances).

- [ ] **Step 4: Commit**

```bash
git add test/instances.test.js
git commit -m "test: cover instance health + fallback + degraded badge"
```

---

## Task 8: Live smoke tests (opt-in)

**Files:**
- Create: `test/live/smoke.live.test.js`

- [ ] **Step 1: Write the live suite** (`test/live/smoke.live.test.js`)

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPlugin } = require("../harness.js");

const LIVE = !!process.env.TIDAL_LIVE;

// Real-network fetch backed by Node's global fetch. The plugin passes
// { insecure: true }; Node's fetch can't bypass certs, so a mirror that
// requires it simply won't be reachable (treated as inconclusive).
async function realFetch(url) {
  const resp = await fetch(url);
  return {
    status: resp.status,
    async json() { return resp.json(); },
    async text() { return resp.text(); },
  };
}

// Wait long enough for the plugin's fire-and-forget health check (uptime fetch
// + probing many mirrors) to settle against the real network. h.settle()'s
// ~20ms is for synchronous stubs; real round-trips need seconds.
function waitForHealth() {
  return new Promise((r) => setTimeout(r, 8000));
}

test("live: at least one TIDAL mirror is reachable, search parses", { skip: !LIVE && "set TIDAL_LIVE=1 to run" }, async (t) => {
  const h = loadPlugin({ fetch: realFetch });
  t.after(() => h.deactivate());

  h.action("check-health");
  await waitForHealth();
  // Probe reachability by attempting a known-stable search.
  h.action("search", { query: "daft punk" });
  await new Promise((r) => setTimeout(r, 6000)); // allow search round-trips

  const lastTidalView = [...h.views].reverse().find((v) => v.viewId === "tidal");
  const json = JSON.stringify(lastTidalView.payload);

  // If servers are unreachable, the rendered banner says "unavailable" — skip.
  if (/unavailable/i.test(json) && !/track-row-list/.test(json)) {
    t.skip("no TIDAL mirrors reachable — inconclusive");
    return;
  }

  // A mirror answered: assert the shape is sane (at least one track rendered).
  assert.match(json, /track-row-list/, "search produced a track list");
});

test("live: a known track id resolves to a non-empty stream url", { skip: !LIVE && "set TIDAL_LIVE=1 to run" }, async (t) => {
  const h = loadPlugin({ fetch: realFetch });
  t.after(() => h.deactivate());
  h.action("check-health");
  await waitForHealth();

  let url;
  try {
    url = await h.streamResolveByUri("35132878", "LOW");
  } catch (e) {
    t.skip("stream resolve threw (mirror/cert issue) — inconclusive: " + e.message);
    return;
  }
  if (url == null) {
    t.skip("no reachable streaming mirror — inconclusive");
    return;
  }
  assert.equal(typeof url, "string");
  assert.ok(url.length > 0, "non-empty stream url");
});
```

- [ ] **Step 2: Verify the suite SKIPS by default**

Run: `npm test`
Expected: live tests do not run. `npm test` is `node --test test/*.test.js`, and
the glob `test/*.test.js` does NOT descend into `test/live/`, so the live file is
never even loaded during `npm test`. (Belt and suspenders: the `skip: !LIVE`
guard would also prevent any network access even if it were loaded.)

> Why a glob, not `node --test test/`: in Node 22, `node --test test/` is
> interpreted as a *module path* to load (fails with MODULE_NOT_FOUND), not a
> directory to scan. The `test/*.test.js` glob is the reliable invocation and
> conveniently excludes `test/live/`.

- [ ] **Step 3: Optionally run live locally**

Run: `npm run test:live`
Expected: either PASS (a mirror answered and shapes are sane) or SKIP messages ("no TIDAL mirrors reachable — inconclusive"). Never a hard failure due to mirrors being down.

- [ ] **Step 4: Commit**

```bash
git add test/live/smoke.live.test.js
git commit -m "test: add opt-in live smoke suite (skip-on-all-down)"
```

---

## Task 9: CI workflow

**Files:**
- Create: `.github/workflows/test.yml`

- [ ] **Step 1: Write `.github/workflows/test.yml`**

```yaml
name: Test

on:
  push:
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: "22"

      - name: Run mocked tests
        run: npm test
```

> No `npm install` step is needed — there are no dependencies. `npm test` runs `node --test test/*.test.js`. The live suite is never invoked in CI (no `TIDAL_LIVE`, and the glob excludes `test/live/`).

- [ ] **Step 2: Validate the workflow YAML locally**

Run: `node -e "const fs=require('fs');const s=fs.readFileSync('.github/workflows/test.yml','utf8');if(!/npm test/.test(s))throw new Error('missing npm test');console.log('workflow OK')"`
Expected: prints `workflow OK`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/test.yml
git commit -m "ci: run mocked test suite on push and PR"
```

---

## Task 10: Final verification + docs touch

**Files:**
- Modify: `DEVELOPING.md` (add a short "Testing" section)

- [ ] **Step 1: Run the complete mocked suite one more time**

Run: `npm test`
Expected: all suites PASS, exit code 0. Capture the summary (tests/pass/fail counts) — fail count must be 0.

- [ ] **Step 2: Add a Testing section to `DEVELOPING.md`**

Insert before the "## 8. Releasing" section:

```markdown
## 7b. Testing

This repo has a zero-dependency Node test harness (`test/`) that loads the real
`index.js` with a fake `api` bridge and drives the plugin through its registered
handlers.

- `npm test` — fast, deterministic mocked tests. This is what CI runs.
- `npm run test:live` — opt-in tests against the real TIDAL mirror network.
  They **skip** (not fail) when no mirror is reachable, so an upstream outage
  never looks like a regression. Run these by hand when you suspect the mirrors
  changed shape or died.

The harness (`test/harness.js`) loads `index.js` in a `node:vm` context with the
same frozen sandbox globals the host provides — plus `atob` — so tests exercise
the real code path, not a reimplementation.
```

- [ ] **Step 3: Commit**

```bash
git add DEVELOPING.md
git commit -m "docs: document the test harness in DEVELOPING.md"
```

- [ ] **Step 4: Final full-suite confirmation**

Run: `npm test && echo "ALL GREEN"`
Expected: prints `ALL GREEN`.

---

## Notes for the implementer

- **Do not modify `index.js` to make tests pass**, except if Task 5 reveals the `decodeBase64` fallback is genuinely wrong — that's a real bug fix, allowed and expected.
- The view payloads from `renderSearchView` are nested layouts. Tests assert via `JSON.stringify(payload)` + `assert.match` against known strings (track title, `track-row-list`) rather than walking the tree — this is intentionally robust to layout tweaks. If you prefer structural assertions, walk `payload.children` for a node with `type === "track-row-list"`.
- `check-health` is the clean way to bring the plugin's instance state "up" in a test: it clears `instanceCache` and re-runs `fetchInstances()` against the current stub. Always stub the uptime URLs (`tidal-uptime`), the api probe (`s=test&limit=1`), and the streaming probe (`id=35132878`) when you need health to be "up".
- Each test MUST `t.after(() => h.deactivate())` to clear the plugin's health-check interval, or the interval leaks across tests.
```
