# Developing & Debugging a Viboplr Plugin

A practical guide to writing, running, reloading, and debugging a Viboplr
plugin. For the full method-by-method API surface, see the host app's
`PLUGIN-API-REFERENCE.md`; this document is about the **workflow**.

> This repo (`tidal-browse`) is a real, non-trivial example — a self-contained
> HTTP plugin (no native backend support). The smallest possible example is the
> app's bundled `audiodb` plugin (a 13-line `index.js`).

---

## 1. What a plugin is

A plugin is a folder with two required files:

```
my-plugin/
├── manifest.json   # metadata + what the plugin contributes
└── index.js        # the code
```

`index.js` is executed by the app as the body of a function and **must return an
object with an `activate` function** (and optionally `deactivate`):

```js
function activate(api) {
  // register handlers, set up UI, subscribe to events …
}
function deactivate() {
  // optional: clean up (see "Cleaning up" below)
}
return { activate: activate, deactivate: deactivate };
```

The app calls `activate(api)` once when the plugin loads. `api` is the only way
to talk to the app.

### How the code runs (and what's available)

The app runs your code via `new Function("api", "window", "globalThis", "self",
"document", code)`. There is **no build step and no transpilation** — the file
is executed as-is in the app's WebView.

- **Modern JavaScript works.** Arrow functions, `const`/`let`, template
  literals, `async`/`await`, classes — all fine. (The bundled plugins happen to
  use older `var`/`function` style by convention, but you are not required to.)
- The execution scope is a **frozen sandbox**, not the real page. Available
  globals: `console`, `Math`, `JSON`, `Date`, `Promise`, `Object`, `Array`,
  `String`, `Number`, `RegExp`, `Error`, `setTimeout`/`clearTimeout`,
  `setInterval`/`clearInterval`, `encodeURIComponent`/`decodeURIComponent`,
  `parseInt`/`parseFloat`/`isNaN`/`isFinite`.
- **Not available:** `fetch` (use `api.network.fetch` — it proxies through Rust
  and bypasses CORS), `require`/`import`, the real DOM (`document`/`window` are
  the frozen sandbox, not the page), and file system access (use
  `api.storage.files`).

---

## 2. The minimal manifest

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "author": "You",
  "description": "What it does",
  "contributes": {}
}
```

- **`id`** must match the plugin's folder name and be unique. It's how the app
  keys everything (storage, overrides, logs).
- **`name`** and **`version`** are required — a manifest missing either loads
  with status **error**.
- **`version`** must be semver `X.Y.Z`.
- Optional: `minAppVersion` (blocks load with status **incompatible** if the app
  is older), `debugOnly` (hidden unless the app's debug mode is on),
  `autoEnable` (set false so the plugin isn't auto-enabled on first launch),
  `icon`, `homepage`, `updateUrl` (for auto-update — see `README.md`).
- `contributes.*` declares what the plugin adds. TIDAL contributes
  `imageProviders`, `sidebarItems`, `contextMenuItems`, `downloadProviders`,
  `streamResolvers`, and a `settingsPanel`.

A `manifest.json` that isn't valid JSON is **skipped silently** (logged on the
Rust side) — if your plugin doesn't appear at all, suspect the manifest first.

---

## 3. Install your working copy into the app

Plugins load from two places:

- **Built-in (bundled):** ships inside the app. In a dev checkout these come
  from `src-tauri/plugins/`.
- **User dir:** `{app_data}/profiles/{profile}/plugins/{id}/`. On macOS that is:
  ```
  ~/Library/Application Support/com.alex.viboplr/profiles/{profile}/plugins/{id}/
  ```
  (Windows: `%APPDATA%\com.alex.viboplr\profiles\{profile}\plugins\{id}\`;
  Linux: `~/.local/share/com.alex.viboplr/profiles/{profile}/plugins/{id}/`.)

**A user-dir plugin overrides a bundled one with the same `id`.** That's how an
installed TIDAL copy updates over the built-in baseline — and how you test a
working copy.

The fastest dev setup is to **symlink your repo into the user plugin dir**:

```bash
# macOS, default profile, plugin id "tidal-browse"
PROFILE=default
DEST="$HOME/Library/Application Support/com.alex.viboplr/profiles/$PROFILE/plugins/tidal-browse"
ln -s "$(pwd)" "$DEST"     # or: cp -R . "$DEST" if you prefer a copy
```

> If the host app has **Developer mode** (Settings → Debug → Developer, debug
> mode on), you can instead point its "Dev plugin folder" at this repo — it
> overrides the built-in and gives you a **Reload** button. Either way works.

---

## 4. The edit → reload loop

The app reads `index.js` fresh from disk every time the plugin loads, so you do
**not** need to rebuild or restart the app to see code changes — you just need to
trigger a reload:

1. **Toggle off → on in Extensions.** Disable your plugin, then enable it. This
   runs your `deactivate()`, re-reads `index.js`, and runs `activate()` again.
2. **Developer mode Reload button** (if the host app has it) — reloads plugins
   without toggling.
3. **`debugOnly` toggle trick.** If your manifest has `"debugOnly": true`,
   flipping the app's debug-mode setting reloads all plugins. Remember to remove
   `debugOnly` before release.

---

## 5. Debugging

### DevTools console — your main tool

Open the WebView DevTools with **F12** (or **Ctrl/Cmd+Shift+I**). Everything your
plugin logs via `console.log` / `console.warn` / `console.error` appears here,
and you can inspect network calls (including `api.network.fetch` traffic), set
breakpoints in your `index.js`, etc.

- **Activation errors** are logged here as `[plugin:<id>] activation error: …`.
  If your plugin shows an **error** badge in Extensions, the actual message is in
  the console (the UI only shows the badge, not the text).

### Persistent logs — `api.log`

```js
api.log("info",  "tidal search: " + query, "tidal-browse");
api.log("error", "tidal fetch failed: " + e, "tidal-browse");
```

`api.log(level, message, section?)` writes to the app's **file logs** under
`{app_data}/.../logs/` (pass your plugin id as `section`). There is **no in-app
log viewer**; open the logs folder from the app's settings. Use `api.log` for
things you want to survive past the DevTools session; `console.*` for fast
interactive debugging.

### "My plugin isn't showing / not working" checklist

| Symptom | Likely cause | Where to look |
|---|---|---|
| Not listed at all | invalid `manifest.json`, or `debugOnly: true` with debug mode off | Rust logs / manifest; toggle debug mode |
| **error** badge | `activate()` threw, or `name`/`version` missing | DevTools console for the message |
| **incompatible** badge | `minAppVersion` newer than the app | manifest `minAppVersion` vs app version |
| **disabled** badge | not enabled | enable it in Extensions |
| Loads but does nothing | empty/incorrect `contributes`, handler not registered | confirm `activate` registers handlers; console |
| Network calls fail | wrong endpoint, or needs `insecure: true` for cert bypass | DevTools Network tab; check `api.network.fetch` opts |
| Stale behavior after editing | didn't reload | toggle off/on (section 4) |

---

## 6. Cleaning up (`deactivate`)

Every reload runs `deactivate()` (if present) before re-activating. Most `api`
registration calls **return an unsubscribe function** — keep them and call them
in `deactivate`, or your handlers accumulate across reloads (duplicate calls,
leaks):

```js
function activate(api) {
  const unsubs = [];
  unsubs.push(api.playback.onStreamResolve("tidal-fallback", function (t, a, al, d) { /* … */ }));
  unsubs.push(api.downloads.onResolveByMetadata("tidal-download", function (/* … */) { /* … */ }));
  this._unsubs = unsubs;
}
function deactivate() {
  (this._unsubs || []).forEach(function (u) { try { u(); } catch (e) {} });
}
```

The app also auto-drops a plugin's view data on deactivate, but anything you
subscribed to (resolvers, events, schedulers) is yours to release.

---

## 7. A complete tiny plugin

`manifest.json`:
```json
{
  "id": "hello-image",
  "name": "Hello Image",
  "version": "1.0.0",
  "author": "You",
  "description": "Provides artist images from TheAudioDB",
  "contributes": { "imageProviders": [{ "entity": "artist" }] }
}
```

`index.js`:
```js
function activate(api) {
  api.imageProviders.onFetch("artist", async function (name) {
    const resp = await api.network.fetch(
      "https://theaudiodb.com/api/v1/json/2/search.php?s=" + encodeURIComponent(name)
    );
    const data = await resp.json();
    const artist = data && data.artists && data.artists[0];
    if (!artist || !artist.strArtistThumb) return { status: "not_found" };
    return { status: "ok", url: artist.strArtistThumb };
  });
  api.log("info", "hello-image activated", "hello-image");
}
return { activate: activate };
```

Drop those two files in `{app_data}/.../plugins/hello-image/`, enable it in
Extensions, open an artist with no image, and watch the DevTools console.

---

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

---

## 7c. Updating the TIDAL server list

TIDAL streaming instances go offline and get replaced over time. The plugin
fetches a live list at runtime, but it also ships a hardcoded fallback
(`FALLBACK_INSTANCES`) and the status-tracker endpoints (`UPTIME_URLS`) in
`index.js`. **Run this before every release** (and any other time you suspect
the servers have gone stale) to refresh them from upstream:

```bash
npm run update-instances
```

This merges three sources — the Monochrome web bundle (canonical), the
`tidal-uptime.geeked.wtf` status API, and the project's `INSTANCES.md` — dedupes
them, and rewrites the two blocks in `index.js`. It then prints a `git diff` and
**does not commit**. Review the diff and commit it (or note "No changes — index.js
is already up to date" if nothing changed), then bump the version per the release
flow below.

If the canonical bundle is unreachable the script aborts without touching
`index.js`; the other two sources are best-effort and only contribute extra URLs.

---

## 7d. Checking server status

When the in-app banner says streaming (or search) is unavailable and you want to
know *why*, probe every server the plugin could use:

```bash
npm run server-status
```

It prints three sections — **SYNC** (uptime URLs), **SEARCH** (api instances),
and **STREAMING** (streaming instances) — with one line per server classifying
it as `UP`, `HTTP <code>` (e.g. 502/403), `TIMEOUT`, `CONN-FAILED`,
`PROXY-SPLASH` (a captive-portal/HTML page intercepting the request — common on
corporate networks), or `UPSTREAM-ERROR` (the mirror answered but its own
upstream TIDAL backend failed, e.g. `{"detail":"Upstream API error"}`). The
`UPSTREAM-ERROR` verdict is the tell that the servers are fine but TIDAL's
backend is down — not something a server-list refresh can fix.

The server list is fetched live from upstream (merged with the built-in
fallback), so it reflects what the plugin actually sees. The script is read-only
and always exits 0.

---

## 8. Releasing

See `README.md` → *Develop & Release*. In short: bump the version
(`scripts/bump.sh`), update `CHANGELOG.md`, push a tag — CI builds and publishes
the release, and installed copies auto-update via `updateUrl`.
