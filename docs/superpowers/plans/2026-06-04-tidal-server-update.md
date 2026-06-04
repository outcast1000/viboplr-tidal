# TIDAL Server-List Updater Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A maintainer-run script that regenerates the hardcoded `FALLBACK_INSTANCES` and `UPTIME_URLS` blocks in `index.js` by merging three upstream sources, then prints a git diff for review.

**Architecture:** A single zero-dependency CommonJS module, `scripts/update-instances.js`, split into pure logic (parse / merge / render / splice — unit-tested with string fixtures, no network) and thin networked source adapters. A `require.main === module` guard runs the CLI; `module.exports` exposes the pure functions for the test harness.

**Tech Stack:** Node 18+ (built-in `fetch`, `AbortController`), `node:test`, `node:fs`, `node:child_process`. No new dependencies.

---

## Design note: why CommonJS, not `.mjs`

The spec named the file `scripts/update-instances.mjs`. We implement it as **CommonJS `scripts/update-instances.js`** instead, because the existing test harness (`test/harness.js`, `test/helpers.js`) is CommonJS and loads modules with `require()`. A `.test.js` file (CommonJS under this repo's package.json, which has no `"type": "module"`) cannot `require()` an ESM `.mjs` file. CommonJS keeps the pure logic directly requireable. Node's built-in `fetch` is a global and works identically in CommonJS. All other spec decisions are unchanged.

## File structure

| File | Responsibility |
| --- | --- |
| `scripts/update-instances.js` | Create. Pure logic (parse/merge/render/splice) + networked adapters + CLI entry. Exports pure functions. |
| `test/update-instances.test.js` | Create. Unit tests for the pure logic against string fixtures. |
| `package.json` | Modify. Add `"update-instances"` npm script. |
| `DEVELOPING.md` | Modify. Add a section on running the updater. |
| `index.js` | Not edited by this plan — it is the *target* the script rewrites at runtime. |

Implementation order: build the pure functions bottom-up (each TDD), then layer the networked adapters and CLI (not unit-tested — thin I/O), then wire the npm script and docs.

---

### Task 1: Scaffold the module and `normalizeUrl`

**Files:**
- Create: `scripts/update-instances.js`
- Test: `test/update-instances.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/update-instances.test.js`:

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const u = require("../scripts/update-instances.js");

test("normalizeUrl strips trailing slashes and lowercases the host", () => {
  assert.equal(u.normalizeUrl("https://HiFi.Geeked.WTF/"), "https://hifi.geeked.wtf");
  assert.equal(u.normalizeUrl("https://api.monochrome.tf///"), "https://api.monochrome.tf");
  assert.equal(u.normalizeUrl("https://maus.qqdl.site"), "https://maus.qqdl.site");
});

test("normalizeUrl returns null for empty/invalid input", () => {
  assert.equal(u.normalizeUrl(""), null);
  assert.equal(u.normalizeUrl(null), null);
  assert.equal(u.normalizeUrl(123), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/update-instances.test.js`
Expected: FAIL — `Cannot find module '../scripts/update-instances.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/update-instances.js`:

```js
"use strict";

// Maintainer-run updater for the hardcoded TIDAL server data in index.js.
// Merges three upstream sources (Monochrome web bundle = canonical, the uptime
// status API, and the GitHub INSTANCES.md table), then rewrites the
// FALLBACK_INSTANCES and UPTIME_URLS blocks and prints a git diff for review.
// Pure logic is exported for unit tests; the CLI runs only when invoked directly.

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const INDEX_PATH = path.join(ROOT, "index.js");

// -- Pure logic --

// Normalize a URL for dedupe: trim, strip trailing slashes, lowercase host.
// Instance URLs are bare origins; any path is preserved but slash-trimmed.
function normalizeUrl(input) {
  if (!input || typeof input !== "string") return null;
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    const origin = parsed.protocol + "//" + parsed.host; // host is lowercased by URL
    const p = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
    return origin + p;
  } catch (e) {
    return trimmed;
  }
}

module.exports = {
  normalizeUrl: normalizeUrl,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/update-instances.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/update-instances.js test/update-instances.test.js
git commit -m "feat: scaffold instance updater with normalizeUrl"
```

---

### Task 2: `normalizeEntry`

**Files:**
- Modify: `scripts/update-instances.js`
- Test: `test/update-instances.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/update-instances.test.js`:

```js
test("normalizeEntry handles string and object inputs", () => {
  assert.deepEqual(u.normalizeEntry("https://maus.qqdl.site/"), { url: "https://maus.qqdl.site", version: null });
  assert.deepEqual(u.normalizeEntry({ url: "https://hifi.geeked.wtf", version: "2.7" }), { url: "https://hifi.geeked.wtf", version: "2.7" });
  assert.deepEqual(u.normalizeEntry({ url: "https://x.test", version: "" }), { url: "https://x.test", version: null });
  assert.equal(u.normalizeEntry(null), null);
  assert.equal(u.normalizeEntry({ version: "9" }), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/update-instances.test.js`
Expected: FAIL — `u.normalizeEntry is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `scripts/update-instances.js`, add the function before the `module.exports` block:

```js
// Coerce a string-or-{url,version} entry into { url, version } with a
// normalized URL. version "" / missing becomes null.
function normalizeEntry(item) {
  if (!item) return null;
  const rawUrl = typeof item === "string" ? item : item.url;
  const url = normalizeUrl(rawUrl);
  if (!url) return null;
  const version = (item && typeof item === "object" && item.version) ? item.version : null;
  return { url: url, version: version };
}
```

Add to `module.exports`:

```js
  normalizeEntry: normalizeEntry,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/update-instances.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/update-instances.js test/update-instances.test.js
git commit -m "feat: add normalizeEntry"
```

---

### Task 3: `sliceBalanced` and `extractEntries`

**Files:**
- Modify: `scripts/update-instances.js`
- Test: `test/update-instances.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/update-instances.test.js`:

```js
test("sliceBalanced returns the balanced delimiter span", () => {
  const s = "x={a:[1,[2]],b:3};y";
  const start = s.indexOf("{");
  assert.equal(u.sliceBalanced(s, start, "{", "}"), "{a:[1,[2]],b:3}");
  const arrStart = s.indexOf("[");
  assert.equal(u.sliceBalanced(s, arrStart, "[", "]"), "[1,[2]]");
});

test("extractEntries pulls url/version pairs from a minified array", () => {
  const seg = '[{url:"https://a.test",version:"2.7"},{url:"https://b.test"}]';
  assert.deepEqual(u.extractEntries(seg), [
    { url: "https://a.test", version: "2.7" },
    { url: "https://b.test", version: null },
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/update-instances.test.js`
Expected: FAIL — `u.sliceBalanced is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `scripts/update-instances.js` (before `module.exports`):

```js
// Return the substring from openIdx (which must point at `open`) through the
// matching `close`, accounting for nesting. null if unbalanced.
function sliceBalanced(str, openIdx, open, close) {
  if (openIdx < 0 || str[openIdx] !== open) return null;
  let depth = 0;
  for (let i = openIdx; i < str.length; i++) {
    const c = str[i];
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return str.slice(openIdx, i + 1);
    }
  }
  return null;
}

// Extract every {url:"...",version:"..."} entry from a minified array segment.
// version is optional in the minified source; missing -> null.
function extractEntries(segment) {
  const out = [];
  const re = /url:"([^"]+)"(?:,version:"([^"]*)")?/g;
  let m;
  while ((m = re.exec(segment))) {
    out.push({ url: m[1], version: m[2] ? m[2] : null });
  }
  return out;
}
```

Add to `module.exports`:

```js
  sliceBalanced: sliceBalanced,
  extractEntries: extractEntries,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/update-instances.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/update-instances.js test/update-instances.test.js
git commit -m "feat: add sliceBalanced and extractEntries"
```

---

### Task 4: `parseBundleInstances` (picks the populated default list)

**Files:**
- Modify: `scripts/update-instances.js`
- Test: `test/update-instances.test.js`

**Context:** The live bundle contains `defaultInstances` twice — an empty config stub `defaultInstances:{api:[],streaming:[]}` and the populated assignment `this.defaultInstances={api:[{...}],streaming:[{...}]}`. The parser must scan all occurrences and keep the one with the most entries. `INSTANCES_URLS:[...]` is parsed the same defensive way.

- [ ] **Step 1: Write the failing test**

Append to `test/update-instances.test.js`:

```js
test("parseBundleInstances picks the populated defaultInstances and reads uptime URLs", () => {
  // Mimics the real bundle: an empty config stub appears BEFORE the populated one.
  const js =
    'a={_KEY:"v9",INSTANCES_URLS:["https://tidal-uptime.geeked.wtf"],defaultInstances:{api:[],streaming:[]}};' +
    'this.defaultInstances={api:[{url:"https://hifi.geeked.wtf",version:"2.7"},{url:"https://api.monochrome.tf",version:"2.5"}],' +
    'streaming:[{url:"https://hifi.geeked.wtf",version:"2.7"}]};';
  const r = u.parseBundleInstances(js);
  assert.deepEqual(r.api, [
    { url: "https://hifi.geeked.wtf", version: "2.7" },
    { url: "https://api.monochrome.tf", version: "2.5" },
  ]);
  assert.deepEqual(r.streaming, [{ url: "https://hifi.geeked.wtf", version: "2.7" }]);
  assert.deepEqual(r.uptimeUrls, ["https://tidal-uptime.geeked.wtf"]);
});

test("parseBundleInstances returns empty arrays when nothing matches", () => {
  const r = u.parseBundleInstances("nothing relevant here");
  assert.deepEqual(r, { api: [], streaming: [], uptimeUrls: [] });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/update-instances.test.js`
Expected: FAIL — `u.parseBundleInstances is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `scripts/update-instances.js`:

```js
// Parse the Monochrome web bundle. Scans every `defaultInstances` occurrence
// (the bundle ships an empty config stub plus the populated assignment) and
// keeps the candidate with the most entries. Reads the longest INSTANCES_URLS
// array found.
function parseBundleInstances(js) {
  let best = { api: [], streaming: [] };
  const diRe = /defaultInstances\s*[:=]\s*\{/g;
  let m;
  while ((m = diRe.exec(js))) {
    const braceIdx = js.indexOf("{", m.index);
    const obj = sliceBalanced(js, braceIdx, "{", "}");
    if (!obj) continue;
    const cand = { api: [], streaming: [] };
    const apiKey = obj.indexOf("api:[");
    if (apiKey !== -1) {
      const seg = sliceBalanced(obj, obj.indexOf("[", apiKey), "[", "]");
      if (seg) cand.api = extractEntries(seg);
    }
    const strKey = obj.indexOf("streaming:[");
    if (strKey !== -1) {
      const seg = sliceBalanced(obj, obj.indexOf("[", strKey), "[", "]");
      if (seg) cand.streaming = extractEntries(seg);
    }
    if (cand.api.length + cand.streaming.length > best.api.length + best.streaming.length) {
      best = cand;
    }
  }

  let uptimeUrls = [];
  const upRe = /INSTANCES_URLS\s*[:=]\s*\[/g;
  while ((m = upRe.exec(js))) {
    const seg = sliceBalanced(js, js.indexOf("[", m.index), "[", "]");
    if (!seg) continue;
    const urls = [];
    const strRe = /"([^"]+)"/g;
    let s;
    while ((s = strRe.exec(seg))) urls.push(s[1]);
    if (urls.length > uptimeUrls.length) uptimeUrls = urls;
  }

  return { api: best.api, streaming: best.streaming, uptimeUrls: uptimeUrls };
}
```

Add to `module.exports`:

```js
  parseBundleInstances: parseBundleInstances,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/update-instances.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/update-instances.js test/update-instances.test.js
git commit -m "feat: parse Monochrome bundle instance list"
```

---

### Task 5: `parseUptimeJson` and `parseInstancesMd`

**Files:**
- Modify: `scripts/update-instances.js`
- Test: `test/update-instances.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/update-instances.test.js`:

```js
test("parseUptimeJson passes through api/streaming arrays", () => {
  const r = u.parseUptimeJson({ api: [{ url: "https://a.test", version: "9" }], streaming: ["https://b.test"] });
  assert.deepEqual(r, {
    api: [{ url: "https://a.test", version: "9" }],
    streaming: ["https://b.test"],
    uptimeUrls: [],
  });
  assert.deepEqual(u.parseUptimeJson(null), { api: [], streaming: [], uptimeUrls: [] });
});

test("parseInstancesMd extracts backticked URLs into the api bucket", () => {
  const md = [
    "| **Monochrome** | `https://monochrome-api.samidy.com` | Official |",
    "|                | `https://api.monochrome.tf`         | Official |",
    "| UI link [monochrome.tf](https://monochrome.tf) is not backticked |",
  ].join("\n");
  const r = u.parseInstancesMd(md);
  assert.deepEqual(r.api, [
    { url: "https://monochrome-api.samidy.com", version: null },
    { url: "https://api.monochrome.tf", version: null },
  ]);
  assert.deepEqual(r.streaming, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/update-instances.test.js`
Expected: FAIL — `u.parseUptimeJson is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `scripts/update-instances.js`:

```js
// The uptime status API returns { api, streaming } (entries may be strings or
// objects). Pass them through untouched — normalizeEntry handles both later.
function parseUptimeJson(json) {
  json = json || {};
  return {
    api: Array.isArray(json.api) ? json.api : [],
    streaming: Array.isArray(json.streaming) ? json.streaming : [],
    uptimeUrls: [],
  };
}

// In INSTANCES.md the API instances are wrapped in backticks; UI mirrors use
// markdown links. Grab backticked http(s) URLs -> all go to the api bucket.
function parseInstancesMd(md) {
  const urls = [];
  const re = /`(https?:\/\/[^`]+)`/g;
  let m;
  while ((m = re.exec(md))) urls.push(m[1]);
  return {
    api: urls.map(function (url) { return { url: url, version: null }; }),
    streaming: [],
    uptimeUrls: [],
  };
}
```

Add to `module.exports`:

```js
  parseUptimeJson: parseUptimeJson,
  parseInstancesMd: parseInstancesMd,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/update-instances.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/update-instances.js test/update-instances.test.js
git commit -m "feat: parse uptime API and INSTANCES.md sources"
```

---

### Task 6: `prioritize` (deterministic ordering)

**Files:**
- Modify: `scripts/update-instances.js`
- Test: `test/update-instances.test.js`

**Context:** Mirrors the *bucketing* of the plugin's `prioritizeInstances` (`index.js:123-134`) — hifi.geeked.wtf first, `.qqdl.site` last, everything else in the middle — but **does not shuffle** (insertion order preserved) so unchanged upstream produces a byte-stable diff.

- [ ] **Step 1: Write the failing test**

Append to `test/update-instances.test.js`:

```js
test("prioritize orders hifi first, qqdl last, middle in insertion order", () => {
  const input = [
    { url: "https://maus.qqdl.site", version: "2.6" },
    { url: "https://api.monochrome.tf", version: "2.5" },
    { url: "https://hifi.geeked.wtf", version: "2.7" },
    { url: "https://eu-central.monochrome.tf", version: "2.7" },
    { url: "https://wolf.qqdl.site", version: "2.2" },
  ];
  assert.deepEqual(u.prioritize(input).map((x) => x.url), [
    "https://hifi.geeked.wtf",
    "https://api.monochrome.tf",
    "https://eu-central.monochrome.tf",
    "https://maus.qqdl.site",
    "https://wolf.qqdl.site",
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/update-instances.test.js`
Expected: FAIL — `u.prioritize is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `scripts/update-instances.js`:

```js
// Deterministic ordering: hifi.geeked.wtf first, .qqdl.site last, the rest in
// the middle. Insertion order is preserved within each group (no shuffle) so
// the generated blocks are byte-stable across runs. The runtime still shuffles.
function prioritize(items) {
  const preferred = [];
  const middle = [];
  const qqdl = [];
  for (let i = 0; i < items.length; i++) {
    const url = items[i].url || "";
    if (url.indexOf("hifi.geeked.wtf") !== -1) preferred.push(items[i]);
    else if (url.indexOf(".qqdl.site") !== -1) qqdl.push(items[i]);
    else middle.push(items[i]);
  }
  return preferred.concat(middle).concat(qqdl);
}
```

Add to `module.exports`:

```js
  prioritize: prioritize,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/update-instances.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/update-instances.js test/update-instances.test.js
git commit -m "feat: add deterministic prioritize ordering"
```

---

### Task 7: `mergeSources`

**Files:**
- Modify: `scripts/update-instances.js`
- Test: `test/update-instances.test.js`

**Context:** `sources[0]` is the canonical bundle. Entries are deduped by normalized URL per bucket. The first source to define an entry sets its version; later sources only fill a missing (null) version — so the bundle's version wins. Each bucket is `prioritize`d. `uptimeUrls` is the deduped union of all sources' uptime URLs (normalized).

- [ ] **Step 1: Write the failing test**

Append to `test/update-instances.test.js`:

```js
test("mergeSources dedupes, prefers bundle version, buckets md-only as api, unions uptime URLs", () => {
  const bundle = {
    api: [{ url: "https://hifi.geeked.wtf", version: "2.7" }],
    streaming: [{ url: "https://hifi.geeked.wtf", version: "2.7" }],
    uptimeUrls: ["https://tidal-uptime.geeked.wtf"],
  };
  const uptime = {
    // duplicate of bundle (trailing slash) with a different version -> bundle wins;
    // plus a new streaming-only instance with no version.
    api: [{ url: "https://hifi.geeked.wtf/", version: "9.9" }],
    streaming: [{ url: "https://maus.qqdl.site", version: "2.6" }],
    uptimeUrls: [],
  };
  const md = {
    // api-only URL not present elsewhere, no version.
    api: [{ url: "https://api.monochrome.tf", version: null }],
    streaming: [],
    uptimeUrls: [],
  };
  const merged = u.mergeSources([bundle, uptime, md]);

  assert.deepEqual(merged.api, [
    { url: "https://hifi.geeked.wtf", version: "2.7" }, // bundle version preserved
    { url: "https://api.monochrome.tf", version: null }, // md-only -> api bucket
  ]);
  assert.deepEqual(merged.streaming, [
    { url: "https://hifi.geeked.wtf", version: "2.7" },
    { url: "https://maus.qqdl.site", version: "2.6" },
  ]);
  assert.deepEqual(merged.uptimeUrls, ["https://tidal-uptime.geeked.wtf"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/update-instances.test.js`
Expected: FAIL — `u.mergeSources is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `scripts/update-instances.js`:

```js
// Add normalized entries into a Map keyed by URL. First writer wins for the
// entry; later writers only fill a missing version. Preserves insertion order.
function addEntries(map, list) {
  (list || []).forEach(function (item) {
    const e = normalizeEntry(item);
    if (!e) return;
    if (!map.has(e.url)) map.set(e.url, e);
    else {
      const existing = map.get(e.url);
      if (!existing.version && e.version) existing.version = e.version;
    }
  });
}

// Merge sources in priority order (sources[0] = canonical bundle). Dedupe per
// bucket, reconcile versions (bundle wins), union uptime URLs, then prioritize.
function mergeSources(sources) {
  const apiMap = new Map();
  const strMap = new Map();
  const uptime = [];
  const uptimeSeen = new Set();
  (sources || []).forEach(function (src) {
    src = src || {};
    addEntries(apiMap, src.api);
    addEntries(strMap, src.streaming);
    (src.uptimeUrls || []).forEach(function (url) {
      const nu = normalizeUrl(url);
      if (nu && !uptimeSeen.has(nu)) {
        uptimeSeen.add(nu);
        uptime.push(nu);
      }
    });
  });
  return {
    api: prioritize(Array.from(apiMap.values())),
    streaming: prioritize(Array.from(strMap.values())),
    uptimeUrls: uptime,
  };
}
```

Add to `module.exports`:

```js
  mergeSources: mergeSources,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/update-instances.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/update-instances.js test/update-instances.test.js
git commit -m "feat: merge and reconcile instance sources"
```

---

### Task 8: `renderFallbackBlock` and `renderUptimeBlock` (byte-exact formatting)

**Files:**
- Modify: `scripts/update-instances.js`
- Test: `test/update-instances.test.js`

**Context:** Output must match `index.js`'s existing style byte-for-byte: 2-space base indent, `{ url: "...", version: "..." }` at 6-space indent, double quotes. A `null` version renders unquoted as `version: null`. No trailing blank lines inside the blocks.

- [ ] **Step 1: Write the failing test**

Append to `test/update-instances.test.js`:

```js
test("renderFallbackBlock matches index.js formatting byte-for-byte", () => {
  const merged = {
    api: [
      { url: "https://hifi.geeked.wtf", version: "2.7" },
      { url: "https://x.test", version: null },
    ],
    streaming: [{ url: "https://hifi.geeked.wtf", version: "2.7" }],
  };
  const expected = [
    "  var FALLBACK_INSTANCES = {",
    "    api: [",
    '      { url: "https://hifi.geeked.wtf", version: "2.7" },',
    '      { url: "https://x.test", version: null },',
    "    ],",
    "    streaming: [",
    '      { url: "https://hifi.geeked.wtf", version: "2.7" },',
    "    ],",
    "  };",
  ].join("\n");
  assert.equal(u.renderFallbackBlock(merged), expected);
});

test("renderUptimeBlock matches index.js formatting byte-for-byte", () => {
  const expected = [
    "  var UPTIME_URLS = [",
    '    "https://tidal-uptime.geeked.wtf",',
    '    "https://other.test",',
    "  ];",
  ].join("\n");
  assert.equal(u.renderUptimeBlock(["https://tidal-uptime.geeked.wtf", "https://other.test"]), expected);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/update-instances.test.js`
Expected: FAIL — `u.renderFallbackBlock is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `scripts/update-instances.js`:

```js
// Render one instance entry at index.js's 6-space indent. null version stays
// unquoted (`version: null`); string versions are double-quoted.
function renderEntry(e) {
  const v = e.version == null ? "null" : '"' + e.version + '"';
  return '      { url: "' + e.url + '", version: ' + v + " },";
}

// Render the full `var FALLBACK_INSTANCES = { ... };` block.
function renderFallbackBlock(merged) {
  const lines = [];
  lines.push("  var FALLBACK_INSTANCES = {");
  lines.push("    api: [");
  (merged.api || []).forEach(function (e) { lines.push(renderEntry(e)); });
  lines.push("    ],");
  lines.push("    streaming: [");
  (merged.streaming || []).forEach(function (e) { lines.push(renderEntry(e)); });
  lines.push("    ],");
  lines.push("  };");
  return lines.join("\n");
}

// Render the full `var UPTIME_URLS = [ ... ];` block.
function renderUptimeBlock(urls) {
  const lines = ["  var UPTIME_URLS = ["];
  (urls || []).forEach(function (url) { lines.push('    "' + url + '",'); });
  lines.push("  ];");
  return lines.join("\n");
}
```

Add to `module.exports`:

```js
  renderFallbackBlock: renderFallbackBlock,
  renderUptimeBlock: renderUptimeBlock,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/update-instances.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/update-instances.js test/update-instances.test.js
git commit -m "feat: render FALLBACK_INSTANCES and UPTIME_URLS blocks"
```

---

### Task 9: `spliceBlocks` (abort-safe in-place replacement)

**Files:**
- Modify: `scripts/update-instances.js`
- Test: `test/update-instances.test.js`

**Context:** Locate both blocks by anchored regex and replace them. If either anchor is missing, throw without producing partial output. Use function replacers so `$` in replacement text is never interpreted (URLs have none, but this is defensive).

- [ ] **Step 1: Write the failing test**

Append to `test/update-instances.test.js`:

```js
test("spliceBlocks replaces both blocks in place", () => {
  const source = [
    "(function () {",
    '  var UPTIME_URLS = [',
    '    "https://old-uptime.test",',
    "  ];",
    "  var CACHE_TTL_MS = 900000;",
    "  var FALLBACK_INSTANCES = {",
    "    api: [",
    '      { url: "https://old.test", version: "1.0" },',
    "    ],",
    "    streaming: [",
    "    ],",
    "  };",
    "  return {};",
    "})",
  ].join("\n");
  const fb = u.renderFallbackBlock({ api: [{ url: "https://new.test", version: "2.0" }], streaming: [] });
  const up = u.renderUptimeBlock(["https://new-uptime.test"]);
  const out = u.spliceBlocks(source, fb, up);
  assert.ok(out.includes('"https://new-uptime.test",'), "uptime replaced");
  assert.ok(out.includes('{ url: "https://new.test", version: "2.0" },'), "fallback replaced");
  assert.ok(!out.includes("old.test"), "old fallback gone");
  assert.ok(!out.includes("old-uptime.test"), "old uptime gone");
  assert.ok(out.includes("var CACHE_TTL_MS = 900000;"), "untouched code preserved");
});

test("spliceBlocks throws when an anchor is missing", () => {
  assert.throws(() => u.spliceBlocks("no blocks here", "x", "y"), /UPTIME_URLS/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/update-instances.test.js`
Expected: FAIL — `u.spliceBlocks is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `scripts/update-instances.js`:

```js
// Replace the FALLBACK_INSTANCES and UPTIME_URLS blocks in index.js source.
// Throws if either anchor is missing (no partial writes). Non-greedy match
// stops at the first 2-space-indented closing delimiter line.
function spliceBlocks(source, fallbackBlock, uptimeBlock) {
  const uptimeRe = /  var UPTIME_URLS = \[[\s\S]*?\n  \];/;
  const fallbackRe = /  var FALLBACK_INSTANCES = \{[\s\S]*?\n  \};/;
  if (!uptimeRe.test(source)) throw new Error("Could not locate UPTIME_URLS block in index.js");
  if (!fallbackRe.test(source)) throw new Error("Could not locate FALLBACK_INSTANCES block in index.js");
  return source
    .replace(uptimeRe, function () { return uptimeBlock; })
    .replace(fallbackRe, function () { return fallbackBlock; });
}
```

Add to `module.exports`:

```js
  spliceBlocks: spliceBlocks,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/update-instances.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/update-instances.js test/update-instances.test.js
git commit -m "feat: splice generated blocks into index.js source"
```

---

### Task 10: Networked adapters + CLI entry

**Files:**
- Modify: `scripts/update-instances.js`

**Context:** These are thin I/O wrappers, not unit-tested (they hit the network). Each source has a timeout; the canonical bundle aborts the run on failure, while the uptime API and INSTANCES.md degrade to empty with a warning. After splicing, if the output is unchanged the script reports so; otherwise it writes the file and prints `git diff`. It never commits.

- [ ] **Step 1: Add the adapters, main(), and CLI guard**

In `scripts/update-instances.js`, add the following **above** the `module.exports` block:

```js
// -- Networked source adapters (thin I/O; not unit-tested) --

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, 15000);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "viboplr-tidal-updater" },
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status + " for " + url);
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

// Canonical source: find the current asset bundle, then parse it.
async function fetchBundle() {
  const home = await fetchText("https://monochrome.tf/");
  const m = home.match(/assets\/index-[A-Za-z0-9_-]+\.js/);
  if (!m) throw new Error("could not find assets/index-*.js in monochrome.tf homepage");
  const js = await fetchText("https://monochrome.tf/" + m[0]);
  return parseBundleInstances(js);
}

async function fetchUptime() {
  const txt = await fetchText("https://tidal-uptime.geeked.wtf");
  return parseUptimeJson(JSON.parse(txt));
}

async function fetchInstancesMd() {
  const md = await fetchText("https://raw.githubusercontent.com/monochrome-music/monochrome/main/INSTANCES.md");
  return parseInstancesMd(md);
}

// -- CLI --

async function main() {
  // Canonical source: abort the whole run if it fails or yields nothing.
  let bundle;
  try {
    bundle = await fetchBundle();
  } catch (e) {
    throw new Error("Canonical Monochrome bundle source failed: " + e.message);
  }
  if (bundle.api.length + bundle.streaming.length === 0) {
    throw new Error("Bundle parsed but yielded zero instances — aborting to avoid wiping the list");
  }

  // Secondary sources: best-effort, degrade to empty on failure.
  let uptime = { api: [], streaming: [], uptimeUrls: [] };
  try {
    uptime = await fetchUptime();
  } catch (e) {
    console.warn("warn: uptime API source failed (continuing):", e.message);
  }
  let md = { api: [], streaming: [], uptimeUrls: [] };
  try {
    md = await fetchInstancesMd();
  } catch (e) {
    console.warn("warn: INSTANCES.md source failed (continuing):", e.message);
  }

  const merged = mergeSources([bundle, uptime, md]);
  console.log(
    "Merged " + merged.api.length + " api, " + merged.streaming.length +
    " streaming, " + merged.uptimeUrls.length + " uptime URL(s)."
  );

  const source = fs.readFileSync(INDEX_PATH, "utf8");
  const out = spliceBlocks(source, renderFallbackBlock(merged), renderUptimeBlock(merged.uptimeUrls));
  if (out === source) {
    console.log("No changes — index.js is already up to date.");
    return;
  }
  fs.writeFileSync(INDEX_PATH, out);
  console.log("\nindex.js updated. Review the diff below, then commit + bump per the release flow:\n");
  console.log(execSync("git diff -- index.js", { cwd: ROOT }).toString());
}

if (require.main === module) {
  main().catch(function (e) {
    console.error("update-instances failed:", e.message);
    process.exit(1);
  });
}
```

- [ ] **Step 2: Verify the full unit suite still passes**

Run: `node --test test/update-instances.test.js`
Expected: PASS — all tests from Tasks 1-9 still green (adding CLI code does not change the exported pure functions).

- [ ] **Step 3: Smoke-test the CLI against the live network**

Run: `node scripts/update-instances.js`
Expected: prints a "Merged N api, M streaming, K uptime URL(s)." line, then either "No changes" or a git diff of `index.js`. If it prints a diff, inspect it: instance URLs should look sane (https origins, qqdl last). Then **revert any change** so this smoke test doesn't get committed: `git checkout -- index.js`.

- [ ] **Step 4: Commit**

```bash
git add scripts/update-instances.js
git commit -m "feat: add networked source adapters and CLI for instance updater"
```

---

### Task 11: Wire the npm script

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the script**

In `package.json`, add an `update-instances` entry to `"scripts"` so it reads:

```json
  "scripts": {
    "test": "node --test test/*.test.js",
    "test:live": "TIDAL_LIVE=1 node --test test/live/*.test.js",
    "update-instances": "node scripts/update-instances.js"
  }
```

- [ ] **Step 2: Verify it runs**

Run: `npm run update-instances`
Expected: same output as Task 10 Step 3 (merged-count line, then "No changes" or a diff). Revert if a diff was written: `git checkout -- index.js`.

- [ ] **Step 3: Verify the unit suite is picked up by `npm test`**

Run: `npm test`
Expected: the existing suites PLUS `test/update-instances.test.js` all pass (the `test/*.test.js` glob includes the new file).

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore: add update-instances npm script"
```

---

### Task 12: Document in DEVELOPING.md

**Files:**
- Modify: `DEVELOPING.md`

- [ ] **Step 1: Add a section**

`DEVELOPING.md` currently has a `## 8. Releasing` section (see its heading at the end of the file). Insert a new section **immediately before** `## 8. Releasing`, renumbering is not required (it can be `## 7c.`-style or simply a titled section — match the file's existing numbered style by adding it as a new numbered step and bumping "Releasing" if the author prefers; the minimum requirement is the content below appears before Releasing):

```markdown
## 7c. Updating the TIDAL server list

TIDAL streaming instances go offline and get replaced over time. The plugin
fetches a live list at runtime, but it also ships a hardcoded fallback
(`FALLBACK_INSTANCES`) and the status-tracker endpoints (`UPTIME_URLS`) in
`index.js`. When those go stale, refresh them from upstream:

```bash
npm run update-instances
```

This merges three sources — the Monochrome web bundle (canonical), the
`tidal-uptime.geeked.wtf` status API, and the project's `INSTANCES.md` — dedupes
them, and rewrites the two blocks in `index.js`. It then prints a `git diff` and
**does not commit**. Review the diff, then commit and bump the version per the
release flow below.

If the canonical bundle is unreachable the script aborts without touching
`index.js`; the other two sources are best-effort and only contribute extra URLs.
```

- [ ] **Step 2: Verify the file reads correctly**

Run: `grep -n "update-instances" DEVELOPING.md`
Expected: shows the new section references the command.

- [ ] **Step 3: Commit**

```bash
git add DEVELOPING.md
git commit -m "docs: document the update-instances script"
```

---

## Self-review

**Spec coverage:**
- Dev-side updater script (zero-dep Node, npm script) → Tasks 1-11. ✓
- Three sources merged (bundle + uptime + INSTANCES.md) → Tasks 4, 5, 7, 10. ✓
- Bundle as canonical source of truth, abort if it fails → Task 10 `main()`. ✓
- Dedupe + reconcile (version preference, bucket assignment, uptime union) → Task 7. ✓
- Deterministic prioritized ordering for stable diffs → Task 6. ✓
- Auto-edit index.js + print diff, no commit → Tasks 9, 10. ✓
- Byte-identical formatting → Task 8. ✓
- Abort-safe (no partial writes) → Task 9. ✓
- Pure-logic unit tests, no network → Tasks 1-9. ✓
- DEVELOPING.md note → Task 12. ✓
- No CI wiring → intentionally absent. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code. The only soft instruction is in Task 12 Step 1 (section numbering preference), which states the minimum requirement explicitly and provides the full content. ✓

**Type consistency:** Normalized entry shape `{ url, version }` is used consistently across `normalizeEntry`, `extractEntries`, `parseBundleInstances`, `mergeSources`, `renderEntry`. Source-adapter shape `{ api, streaming, uptimeUrls }` is consistent across all three parsers and `mergeSources`. Function names match between definitions, `module.exports`, and test references (`normalizeUrl`, `normalizeEntry`, `sliceBalanced`, `extractEntries`, `parseBundleInstances`, `parseUptimeJson`, `parseInstancesMd`, `prioritize`, `mergeSources`, `renderFallbackBlock`, `renderUptimeBlock`, `spliceBlocks`). ✓
