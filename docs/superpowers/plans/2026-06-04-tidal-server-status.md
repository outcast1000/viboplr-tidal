# TIDAL Server-Status Diagnostic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A maintainer diagnostic `scripts/server-status.js` (`npm run server-status`) that probes the TIDAL sync/search/streaming servers and prints a grouped console table with rich failure classification.

**Architecture:** A single zero-dependency CommonJS module split into pure logic (`classify`, `formatRow`, `formatTable`, plus the mirrored `hasStreamPayload` and probe constants — unit-tested with fixtures, no network) and thin networked probing (`fetchText`, `probeServer`, list-building via `update-instances.js`'s pure exports). A `require.main === module` guard runs the CLI.

**Tech Stack:** Node 18+ (global `fetch`, `AbortController`, `performance.now()`), `node:test`, reuses `scripts/update-instances.js` pure exports. No new dependencies.

---

## Design notes

- **CommonJS `.js`** (not `.mjs`), same reasoning as `update-instances.js`: the test harness is CommonJS and `require()`s the module under test. Node's global `fetch` works in CommonJS.
- **Reuse:** `update-instances.js` exports the PURE functions (`parseBundleInstances`, `parseUptimeJson`, `mergeSources`, `normalizeUrl`, ...) but NOT its networked `fetchBundle`/`fetchUptime`. This script imports the pure functions and defines its own `fetchText` + adapters.
- **Mirrored-from-index.js constants** (not importable — they live in `index.js`'s `new Function` body): `API_PROBE_PATH` (index.js:58), `STREAM_PROBE_TRACK_ID` (index.js:59), the streaming path (index.js:150), `hasStreamPayload` (index.js:142-146), and `UPTIME_URLS` (index.js:54-58). Each gets a comment pointing at the mirrored lines.

## File structure

| File | Responsibility |
| --- | --- |
| `scripts/server-status.js` | Create. Pure classify/format logic + mirrored constants + networked probing + list-builder + CLI. Exports pure functions. |
| `test/server-status.test.js` | Create. Unit tests for `classify`, `hasStreamPayload`, `formatRow`/`formatTable` against fixtures. |
| `package.json` | Modify. Add `"server-status"` npm script. |
| `DEVELOPING.md` | Modify. Add a subsection near §7c. |

Build order: pure logic first (TDD), then thin networked layer + CLI (not unit-tested), then npm script + docs.

---

### Task 1: Scaffold module + mirrored constants + `hasStreamPayload`

**Files:**
- Create: `scripts/server-status.js`
- Test: `test/server-status.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/server-status.test.js`:

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const s = require("../scripts/server-status.js");

test("hasStreamPayload mirrors the plugin's stream-shape check", () => {
  assert.equal(s.hasStreamPayload({ data: { manifest: "abc" } }), true);
  assert.equal(s.hasStreamPayload({ url: "https://x" }), true);
  assert.equal(s.hasStreamPayload({ streamUrl: "https://x" }), true);
  assert.equal(s.hasStreamPayload({ originalTrackUrl: "https://x" }), true);
  assert.equal(s.hasStreamPayload({ OriginalTrackUrl: "https://x" }), true);
  assert.equal(s.hasStreamPayload({ data: { detail: "Upstream API error" } }), false);
  assert.equal(s.hasStreamPayload(null), false);
  assert.equal(s.hasStreamPayload({}), false);
});

test("exposes the probe constants mirrored from index.js", () => {
  assert.equal(s.API_PROBE_PATH, "/search/?s=test&limit=1");
  assert.equal(s.STREAM_PROBE_TRACK_ID, "35132878");
  assert.equal(s.streamProbePath(), "/track/?id=35132878&quality=LOW");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/server-status.test.js`
Expected: FAIL — `Cannot find module '../scripts/server-status.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/server-status.js`:

```js
"use strict";

// Maintainer diagnostic: probe every TIDAL server the plugin could use — sync
// (uptime URLs), search (api instances), and streaming (streaming instances) —
// and print a grouped table classifying each as UP / TIMEOUT / CONN-FAILED /
// PROXY-SPLASH / UPSTREAM-ERROR / HTTP <code>. Pure logic is exported for unit
// tests; the CLI runs only when invoked directly. Always exits 0 (it is a
// report, not a gate).

const path = require("node:path");
const updater = require("./update-instances.js");

// -- Constants mirrored from index.js (that file's internals are not
// importable; it runs as a new Function body). Keep these in sync with the
// referenced lines. --
const API_PROBE_PATH = "/search/?s=test&limit=1";   // index.js:58
const STREAM_PROBE_TRACK_ID = "35132878";            // index.js:59
function streamProbePath() {                         // index.js:150
  return "/track/?id=" + STREAM_PROBE_TRACK_ID + "&quality=LOW";
}

// Mirrors index.js:142-146 — truthy when a track response carries a playable
// stream. data = json.data || json.
function hasStreamPayload(json) {
  const data = json && (json.data || json);
  if (!data) return false;
  return !!(data.manifest || data.url || data.streamUrl || data.originalTrackUrl || data.OriginalTrackUrl);
}

module.exports = {
  API_PROBE_PATH: API_PROBE_PATH,
  STREAM_PROBE_TRACK_ID: STREAM_PROBE_TRACK_ID,
  streamProbePath: streamProbePath,
  hasStreamPayload: hasStreamPayload,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/server-status.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/server-status.js test/server-status.test.js
git commit -m "feat: scaffold server-status with mirrored probe constants"
```

---

### Task 2: `classify` — the verdict function

**Files:**
- Modify: `scripts/server-status.js`
- Test: `test/server-status.test.js`

**Context:** `classify(category, result)` where `category` is `"sync"`, `"search"`, or `"streaming"`, and `result` is `{ status, bodyText, threw, timedOut }`. Returns a verdict string. Precedence (first match wins): threw→`CONN-FAILED`; timedOut→`TIMEOUT`; splash body→`PROXY-SPLASH`; `"Upstream API error"` in body→`UPSTREAM-ERROR`; 2xx → (sync/search: JSON parses→`UP` else `PROXY-SPLASH`; streaming: hasStreamPayload→`UP` else `UPSTREAM-ERROR`); else `HTTP <code>`.

- [ ] **Step 1: Write the failing test**

Append to `test/server-status.test.js`:

```js
const SPLASH = '<!doctype html><html><head><title>Proxy-VPN Splash Page</title></head></html>';
const SEARCH_OK = JSON.stringify({ data: { items: [{ id: 1 }] } });
const STREAM_OK = JSON.stringify({ data: { manifest: "abc" } });
const UPSTREAM = JSON.stringify({ detail: "Upstream API error" });

test("classify: connection and timeout take precedence", () => {
  assert.equal(s.classify("search", { threw: true }), "CONN-FAILED");
  assert.equal(s.classify("search", { timedOut: true }), "TIMEOUT");
});

test("classify: proxy splash detected before status is trusted", () => {
  assert.equal(s.classify("search", { status: 200, bodyText: SPLASH }), "PROXY-SPLASH");
  // splash carried on a non-2xx must still be PROXY-SPLASH, not HTTP 403
  assert.equal(s.classify("streaming", { status: 403, bodyText: SPLASH }), "PROXY-SPLASH");
});

test("classify: upstream error body", () => {
  assert.equal(s.classify("streaming", { status: 403, bodyText: UPSTREAM }), "UPSTREAM-ERROR");
  assert.equal(s.classify("search", { status: 500, bodyText: UPSTREAM }), "UPSTREAM-ERROR");
});

test("classify: 2xx success rules per category", () => {
  assert.equal(s.classify("search", { status: 200, bodyText: SEARCH_OK }), "UP");
  assert.equal(s.classify("sync", { status: 200, bodyText: SEARCH_OK }), "UP");
  assert.equal(s.classify("streaming", { status: 200, bodyText: STREAM_OK }), "UP");
  // streaming 2xx without a payload -> upstream error
  assert.equal(s.classify("streaming", { status: 200, bodyText: SEARCH_OK }), "UPSTREAM-ERROR");
  // sync/search 2xx whose body is not JSON -> treated as interception/garbage
  assert.equal(s.classify("search", { status: 200, bodyText: "not json at all" }), "PROXY-SPLASH");
});

test("classify: other non-2xx falls through to HTTP <code>", () => {
  assert.equal(s.classify("search", { status: 502, bodyText: "bad gateway" }), "HTTP 502");
  assert.equal(s.classify("streaming", { status: 404, bodyText: "nope" }), "HTTP 404");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/server-status.test.js`
Expected: FAIL — `s.classify is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `scripts/server-status.js` before `module.exports`:

```js
// Does this body look like a captive-portal / proxy splash page rather than an
// API response? (Corporate proxies return HTML with HTTP 200.)
function looksLikeSplash(bodyText) {
  if (!bodyText) return false;
  return /<!doctype html/i.test(bodyText) || /Proxy-VPN/i.test(bodyText) || /splash/i.test(bodyText);
}

function isJson(bodyText) {
  if (!bodyText) return false;
  try { JSON.parse(bodyText); return true; } catch (e) { return false; }
}

// Classify one probe result into a verdict string. See plan/spec for precedence.
function classify(category, result) {
  result = result || {};
  if (result.threw) return "CONN-FAILED";
  if (result.timedOut) return "TIMEOUT";
  const body = result.bodyText || "";
  if (looksLikeSplash(body)) return "PROXY-SPLASH";
  if (body.indexOf("Upstream API error") !== -1) return "UPSTREAM-ERROR";
  const status = result.status;
  if (status >= 200 && status < 300) {
    if (category === "streaming") {
      let json = null;
      try { json = JSON.parse(body); } catch (e) { json = null; }
      return hasStreamPayload(json) ? "UP" : "UPSTREAM-ERROR";
    }
    return isJson(body) ? "UP" : "PROXY-SPLASH";
  }
  return "HTTP " + (status == null ? "?" : status);
}
```

Add to `module.exports`:

```js
  classify: classify,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/server-status.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/server-status.js test/server-status.test.js
git commit -m "feat: add server-status classify verdict function"
```

---

### Task 3: `formatRow` and `formatTable`

**Files:**
- Modify: `scripts/server-status.js`
- Test: `test/server-status.test.js`

**Context:** A "row" is `{ verdict, status, latencyMs, url, detail }`. `formatRow` renders one indented line with padded columns. `formatTable(heading, summaryKey, rows)` renders the heading line, its rows, and a summary line `<summaryKey>: <upCount>/<total> up`.

**Note on test style:** rather than assert hand-counted space literals (error-prone), the tests verify the *observable* contract — the tokens present, the 2-space indent, detail formatting, column alignment between rows, and the summary text. This pins the format meaningfully without depending on exact padding widths.

- [ ] **Step 1: Write the failing test**

Append to `test/server-status.test.js`:

```js
test("formatRow shows verdict, status, latency, url with a 2-space indent", () => {
  const line = s.formatRow({ verdict: "UP", status: 200, latencyMs: 142, url: "https://api.test" });
  assert.ok(line.startsWith("  UP"), "indented verdict first");
  const tokens = line.trim().split(/\s+/);
  assert.deepEqual(tokens, ["UP", "200", "142ms", "https://api.test"]);
});

test("formatRow renders null status/latency as dashes and appends detail in parens", () => {
  const line = s.formatRow({ verdict: "CONN-FAILED", status: null, latencyMs: null, url: "https://x.test", detail: "fetch failed" });
  const tokens = line.split("  (")[0].trim().split(/\s+/);
  assert.deepEqual(tokens, ["CONN-FAILED", "-", "-", "https://x.test"]);
  assert.ok(line.endsWith("(fetch failed)"), "detail in trailing parens");
});

test("formatRow aligns the url column across rows of different verdict widths", () => {
  const a = s.formatRow({ verdict: "UP", status: 200, latencyMs: 10, url: "https://a.test" });
  const b = s.formatRow({ verdict: "HTTP 502", status: 502, latencyMs: 5, url: "https://b.test" });
  assert.equal(a.indexOf("https://a.test"), b.indexOf("https://b.test"), "url column aligned");
});

test("formatTable renders heading, one line per row, and an up/total summary", () => {
  const rows = [
    { verdict: "UP", status: 200, latencyMs: 10, url: "https://a.test" },
    { verdict: "HTTP 502", status: 502, latencyMs: 5, url: "https://b.test" },
  ];
  const out = s.formatTable("SEARCH (api instances)", "SEARCH", rows);
  const lines = out.split("\n");
  assert.equal(lines[0], "SEARCH (api instances)");
  assert.equal(lines.length, 4, "heading + 2 rows + summary");
  assert.ok(lines[1].includes("https://a.test"));
  assert.ok(lines[2].includes("https://b.test"));
  assert.equal(lines[3], "  SEARCH: 1/2 up");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/server-status.test.js`
Expected: FAIL — `s.formatRow is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `scripts/server-status.js` before `module.exports`:

```js
function padEnd(str, n) { str = String(str); return str.length >= n ? str : str + " ".repeat(n - str.length); }
function padStart(str, n) { str = String(str); return str.length >= n ? str : " ".repeat(n - str.length) + str; }

// Render one result row as an indented, column-aligned line.
function formatRow(row) {
  const verdict = padEnd(row.verdict, 13);
  const status = padStart(row.status == null ? "-" : row.status, 5);
  const latency = padStart(row.latencyMs == null ? "-" : row.latencyMs + "ms", 7);
  let line = "  " + verdict + " " + status + " " + latency + "  " + row.url;
  if (row.detail) line += "  (" + row.detail + ")";
  return line;
}

// Render a category: heading line, one line per row, then a summary count.
function formatTable(heading, summaryKey, rows) {
  const lines = [heading];
  let up = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].verdict === "UP") up++;
    lines.push(formatRow(rows[i]));
  }
  lines.push("  " + summaryKey + ": " + up + "/" + rows.length + " up");
  return lines.join("\n");
}
```

Add to `module.exports`:

```js
  formatRow: formatRow,
  formatTable: formatTable,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/server-status.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/server-status.js test/server-status.test.js
git commit -m "feat: add server-status table formatting"
```

---

### Task 4: Networked probing + list builder + CLI

**Files:**
- Modify: `scripts/server-status.js`

**Context:** Thin I/O, not unit-tested. `fetchText` returns `{ status, bodyText, threw, timedOut, latencyMs }`. `probeCategory` maps a list of URLs through `fetchText` + `classify` in parallel. The list builder reuses `update-instances.js` pure exports: fetch the bundle + uptime JSON via local `fetchText`, parse with `parseBundleInstances`/`parseUptimeJson`, merge with `mergeSources` against `FALLBACK_INSTANCES` parsed from the live bundle (the merge already includes the bundle's own fallback). If the live fetch fails, fall back to the hardcoded lists mirrored from index.js and warn.

- [ ] **Step 1: Add the networked layer, mirrored fallback lists, and CLI**

Add to `scripts/server-status.js` before `module.exports`:

```js
// -- Mirrored fallback lists from index.js (used only if the live upstream
// fetch fails). Keep in sync with index.js:54-58 (UPTIME_URLS) and the
// FALLBACK_INSTANCES block. --
const UPTIME_URLS = [
  "https://tidal-uptime.geeked.wtf",
];

// -- Networked probing (thin I/O; not unit-tested) --

async function fetchText(url, pathSuffix) {
  const full = url + (pathSuffix || "");
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, 12000);
  const start = performance.now();
  try {
    const resp = await fetch(full, { signal: ctrl.signal, headers: { "User-Agent": "viboplr-tidal-status" } });
    const bodyText = await resp.text();
    return { status: resp.status, bodyText: bodyText, latencyMs: Math.round(performance.now() - start) };
  } catch (e) {
    const timedOut = e && e.name === "AbortError";
    return { threw: !timedOut, timedOut: timedOut, latencyMs: Math.round(performance.now() - start), detail: (e && e.message || "").slice(0, 40) };
  } finally {
    clearTimeout(timer);
  }
}

// Probe every URL in a category in parallel, returning formatted rows.
async function probeCategory(category, urls, pathSuffix) {
  return Promise.all(urls.map(async function (url) {
    const r = await fetchText(url, pathSuffix);
    const verdict = classify(category, r);
    let detail = r.detail || "";
    if (!detail && (verdict === "UPSTREAM-ERROR" || verdict.indexOf("HTTP") === 0)) {
      detail = (r.bodyText || "").replace(/\s+/g, " ").slice(0, 60);
    }
    return { verdict: verdict, status: r.status == null ? null : r.status, latencyMs: r.timedOut ? null : r.latencyMs, url: url, detail: detail };
  }));
}

// Build the server lists the plugin would see: live bundle + uptime, merged
// with the bundle's own fallback. Falls back to the hardcoded mirror on failure.
async function buildServerLists() {
  let uptimeUrls = UPTIME_URLS.slice();
  let apiUrls = [];
  let streamingUrls = [];
  try {
    const home = await fetchText("https://monochrome.tf/", "");
    const m = (home.bodyText || "").match(/assets\/index-[A-Za-z0-9_-]+\.js/);
    if (!m) throw new Error("no asset bundle link found");
    const bundleResp = await fetchText("https://monochrome.tf/" + m[0], "");
    const bundle = updater.parseBundleInstances(bundleResp.bodyText || "");
    let uptime = { api: [], streaming: [], uptimeUrls: [] };
    try {
      const upResp = await fetchText("https://tidal-uptime.geeked.wtf", "");
      uptime = updater.parseUptimeJson(JSON.parse(upResp.bodyText || "{}"));
    } catch (e) { /* best-effort */ }
    const merged = updater.mergeSources([bundle, uptime]);
    apiUrls = merged.api.map(function (e) { return e.url; });
    streamingUrls = merged.streaming.map(function (e) { return e.url; });
    if (bundle.uptimeUrls && bundle.uptimeUrls.length) uptimeUrls = bundle.uptimeUrls;
    if (apiUrls.length === 0) throw new Error("bundle yielded no instances");
  } catch (e) {
    console.warn("warn: live upstream fetch failed (" + e.message + ") — using hardcoded fallback list only");
    // Fall back to whatever update-instances baked into index.js via its own
    // parse of the live bundle is unavailable here, so use the minimal mirror.
    apiUrls = ["https://hifi.geeked.wtf", "https://api.monochrome.tf", "https://monochrome-api.samidy.com"];
    streamingUrls = ["https://hifi.geeked.wtf"];
  }
  return { uptimeUrls: uptimeUrls, apiUrls: apiUrls, streamingUrls: streamingUrls };
}

// -- CLI --

async function main() {
  const lists = await buildServerLists();

  const syncRows = await probeCategory("sync", lists.uptimeUrls, "");
  console.log(formatTable("SYNC (uptime URLs)", "SYNC", syncRows));
  console.log("");

  const searchRows = await probeCategory("search", lists.apiUrls, API_PROBE_PATH);
  console.log(formatTable("SEARCH (api instances)", "SEARCH", searchRows));
  console.log("");

  const streamRows = await probeCategory("streaming", lists.streamingUrls, streamProbePath());
  console.log(formatTable("STREAMING (streaming instances)", "STREAMING", streamRows));
}

if (require.main === module) {
  main().catch(function (e) {
    console.error("server-status failed:", e.message);
    process.exit(1);
  });
}
```

- [ ] **Step 2: Verify the unit suite still passes**

Run: `node --test test/server-status.test.js`
Expected: PASS — all tests from Tasks 1-3 still green (the networked additions don't change the exported pure functions).

- [ ] **Step 3: Smoke-test the CLI against the live network**

Run: `node scripts/server-status.js`
Expected: three sections (SYNC, SEARCH, STREAMING), each with rows and a summary line. Behind a corporate proxy you may see `PROXY-SPLASH` verdicts — that is the classifier working. CAPTURE the full stdout and include it in your report. The script writes no files and needs no revert.

- [ ] **Step 4: Commit**

```bash
git add scripts/server-status.js
git commit -m "feat: add networked probing and CLI for server-status"
```

---

### Task 5: Wire the npm script

**Files:**
- Modify: `package.json`

**Context:** `package.json` currently has `test`, `test:live`, `update-instances`.

- [ ] **Step 1: Add the script**

Edit `package.json` so `"scripts"` reads:

```json
  "scripts": {
    "test": "node --test test/*.test.js",
    "test:live": "TIDAL_LIVE=1 node --test test/live/*.test.js",
    "update-instances": "node scripts/update-instances.js",
    "server-status": "node scripts/server-status.js"
  }
```

- [ ] **Step 2: Verify JSON + run**

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('valid json')"`
Expected: prints `valid json`.

Run: `npm run server-status`
Expected: same three-section output as Task 4 Step 3.

- [ ] **Step 3: Verify the full suite picks up the new test file**

Run: `npm test`
Expected: existing suites PLUS `test/server-status.test.js` all pass.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore: add server-status npm script"
```

---

### Task 6: Document in DEVELOPING.md

**Files:**
- Modify: `DEVELOPING.md`

**Context:** `DEVELOPING.md` has `## 7c. Updating the TIDAL server list` followed by `## 8. Releasing`. Insert a new `## 7d.` section between them.

- [ ] **Step 1: Add the section**

Insert this block immediately before `## 8. Releasing` (after the `---` that ends §7c):

```markdown
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
```

- [ ] **Step 2: Verify**

Run: `grep -n "server-status\|## 7d\|## 8" DEVELOPING.md`
Expected: shows the new `## 7d.` section before `## 8. Releasing`, referencing the command.

- [ ] **Step 3: Commit**

```bash
git add DEVELOPING.md
git commit -m "docs: document the server-status script"
```

---

## Self-review

**Spec coverage:**
- Zero-dep Node script `scripts/server-status.js`, `npm run server-status` → Tasks 1-5. ✓
- Three categories sync/search/streaming with correct probes → Tasks 1 (constants), 4 (probeCategory wiring). ✓
- Live-upstream + fallback merged list via update-instances pure exports → Task 4 `buildServerLists`. ✓
- Rich classification (UP/TIMEOUT/CONN-FAILED/PROXY-SPLASH/UPSTREAM-ERROR/HTTP) with documented precedence → Task 2 `classify`. ✓
- Splash-before-status precedence, streaming-no-payload → UPSTREAM-ERROR, sync/search non-JSON 2xx → PROXY-SPLASH → Task 2 tests. ✓
- Parallel within category, sequential across, AbortController timeout, performance.now latency → Task 4. ✓
- Best-effort list building with warning, never abort → Task 4 `buildServerLists` catch. ✓
- Always exit 0 → Task 4 (main resolves; only an unexpected throw exits 1, which is acceptable for a true crash). ✓
- Plain text grouped table, per-category summary → Task 3 `formatTable`. ✓
- Unit tests for classify + hasStreamPayload + formatting, no network → Tasks 1-3. ✓
- DEVELOPING.md note near §7c → Task 6. ✓
- No CI, no --json, no source column → not present. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code. The fallback list in `buildServerLists` uses a deliberately minimal hardcoded set (documented as the last-resort path) rather than re-parsing index.js — a conscious YAGNI choice, not a placeholder.

**Type consistency:**
- Row shape `{ verdict, status, latencyMs, url, detail }` is consistent across `probeCategory` (producer), `formatRow`/`formatTable` (consumers), and the Task 3 tests.
- `fetchText` return `{ status, bodyText, threw, timedOut, latencyMs, detail }` is consistent with what `classify` reads (`status, bodyText, threw, timedOut`) and what `probeCategory` reads (`detail, status, latencyMs, timedOut, bodyText`).
- `classify(category, result)` signature matches all call sites and tests.
- Exported names (`API_PROBE_PATH`, `STREAM_PROBE_TRACK_ID`, `streamProbePath`, `hasStreamPayload`, `classify`, `formatRow`, `formatTable`) match between `module.exports`, tests, and internal callers.

**One precedence detail verified:** in `classify`, the `"Upstream API error"` substring check runs before the 2xx branch, so a 2xx carrying that body is `UPSTREAM-ERROR` (correct — some mirrors return 200 with an upstream-error envelope). The Task 2 tests exercise 403/500 with that body; behavior on a 200 with it is also UPSTREAM-ERROR by the same line.
