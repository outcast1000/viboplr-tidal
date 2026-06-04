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

// Return the substring from openIdx (which must point at `open`) through the
// matching `close`, accounting for nesting. null if unbalanced.
function sliceBalanced(str, openIdx, open, close) {
  if (openIdx < 0 || openIdx >= str.length || str[openIdx] !== open) return null;
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
// markdown links. Grab ONLY backticked http(s) URLs (markdown links are
// intentionally ignored) -> all go to the api bucket.
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

module.exports = {
  normalizeUrl: normalizeUrl,
  normalizeEntry: normalizeEntry,
  sliceBalanced: sliceBalanced,
  extractEntries: extractEntries,
  parseBundleInstances: parseBundleInstances,
  parseUptimeJson: parseUptimeJson,
  parseInstancesMd: parseInstancesMd,
  prioritize: prioritize,
  mergeSources: mergeSources,
  renderFallbackBlock: renderFallbackBlock,
  renderUptimeBlock: renderUptimeBlock,
  spliceBlocks: spliceBlocks,
};
