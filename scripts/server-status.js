"use strict";

// Maintainer diagnostic: probe every TIDAL server the plugin could use — sync
// (uptime URLs), search (api instances), and streaming (streaming instances) —
// plus extra diagnostic mirrors. Prints a grouped table classifying each as
// UP / TIMEOUT / CONN-FAILED / PROXY-SPLASH / UPSTREAM-ERROR / HTTP <code>.
// Pure logic is exported for unit tests; the CLI runs only when invoked
// directly. Always exits 0 (it is a report, not a gate).

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

// A captive-portal/proxy page is HTML, so the doctype and Proxy-VPN markers
// catch it without the over-broad /splash/i (which would match a track named
// "Splash" in a JSON search result). 2xx-non-JSON bodies are still caught as
// PROXY-SPLASH by the success-rule fallthrough in classify().
function looksLikeSplash(bodyText) {
  if (!bodyText) return false;
  return /<!doctype html/i.test(bodyText) || /Proxy-VPN/i.test(bodyText);
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

function padEnd(str, n) { str = String(str); return str.length >= n ? str : str + " ".repeat(n - str.length); }
function padStart(str, n) { str = String(str); return str.length >= n ? str : " ".repeat(n - str.length) + str; }

// Build the short "why" snippet shown after a non-UP row's url. Pure.
function describeDetail(verdict, result) {
  result = result || {};
  if (verdict === "UP") return "";
  if (verdict === "TIMEOUT") return "timed out";
  if (verdict === "CONN-FAILED") return result.detail || "connection failed";
  if (verdict === "PROXY-SPLASH") {
    const kind = /<!doctype html/i.test(result.bodyText || "") ? "html page" : "non-JSON body";
    return kind + ", " + (result.bodyText || "").length + "b";
  }
  // UPSTREAM-ERROR and HTTP <code>: a short, whitespace-collapsed body snippet.
  return (result.bodyText || "").replace(/\s+/g, " ").trim().slice(0, 60);
}

const VERDICT_WIDTH = 14; // longest verdict: "UPSTREAM-ERROR"
const STATUS_WIDTH = 5;
const LATENCY_WIDTH = 7;

// Render one result row as an indented, column-aligned line.
function formatRow(row) {
  const verdict = padEnd(row.verdict, VERDICT_WIDTH);
  const status = padStart(row.status == null ? "-" : row.status, STATUS_WIDTH);
  const latency = padStart(row.latencyMs == null ? "-" : row.latencyMs + "ms", LATENCY_WIDTH);
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

// -- Mirrored fallback lists from index.js (used only if the live upstream
// fetch fails). Keep in sync with index.js:54-58 (UPTIME_URLS) and the
// FALLBACK_INSTANCES block. --
const UPTIME_URLS = [
  "https://tidal-uptime.geeked.wtf",
];

// Maintainer-only diagnostic additions. These do not change plugin runtime
// behavior; they make `npm run server-status` probe known mirrors even when an
// upstream source omits them. Env vars can add one-off servers locally:
// TIDAL_STATUS_CUSTOM_URLS applies to both api and streaming, while
// TIDAL_STATUS_CUSTOM_API_URLS / TIDAL_STATUS_CUSTOM_STREAMING_URLS are scoped.
const CUSTOM_INSTANCES = {
  api: [
    { url: "https://hifi.geeked.wtf", version: "2.7" },
    { url: "https://eu-central.monochrome.tf", version: "2.7" },
    { url: "https://us-west.monochrome.tf", version: "2.7" },
    { url: "https://api.monochrome.tf", version: "2.5" },
    { url: "https://monochrome-api.samidy.com", version: "2.3" },
    { url: "https://tidal.kinoplus.online", version: "2.2" },
    { url: "https://maus.qqdl.site", version: "2.6" },
    { url: "https://vogel.qqdl.site", version: "2.6" },
    { url: "https://katze.qqdl.site", version: "2.6" },
    { url: "https://hund.qqdl.site", version: "2.6" },
    { url: "https://wolf.qqdl.site", version: "2.2" },
    { url: "https://hifi-api.kennyy.com.br/", version: "2.1" },
  ],
  streaming: [
    { url: "https://hifi.geeked.wtf", version: "2.7" },
    { url: "https://maus.qqdl.site", version: "2.6" },
    { url: "https://vogel.qqdl.site", version: "2.6" },
    { url: "https://katze.qqdl.site", version: "2.6" },
    { url: "https://hund.qqdl.site", version: "2.6" },
    { url: "https://wolf.qqdl.site", version: "2.6" },
  ],
  uptimeUrls: [],
};

function splitServerList(value) {
  if (!value || typeof value !== "string") return [];
  return value.split(/[\s,]+/).filter(Boolean);
}

function envCustomInstances(env) {
  env = env || {};
  const both = splitServerList(env.TIDAL_STATUS_CUSTOM_URLS);
  return {
    api: both.concat(splitServerList(env.TIDAL_STATUS_CUSTOM_API_URLS)),
    streaming: both.concat(splitServerList(env.TIDAL_STATUS_CUSTOM_STREAMING_URLS)),
    uptimeUrls: [],
  };
}

function mergeServerSources(bundle, uptimeSources, customSource) {
  const sources = [bundle || { api: [], streaming: [], uptimeUrls: [] }]
    .concat(uptimeSources || [])
    .concat([CUSTOM_INSTANCES, customSource || { api: [], streaming: [], uptimeUrls: [] }]);
  const merged = updater.mergeSources(sources);
  return {
    uptimeUrls: merged.uptimeUrls.length ? merged.uptimeUrls : UPTIME_URLS.slice(),
    apiUrls: merged.api.map(function (e) { return e.url; }),
    streamingUrls: merged.streaming.map(function (e) { return e.url; }),
  };
}

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
    return { verdict: verdict, status: r.status == null ? null : r.status, latencyMs: r.timedOut ? null : r.latencyMs, url: url, detail: describeDetail(verdict, r) };
  }));
}

// Build the server lists the plugin would see: live bundle + every uptime URL,
// merged with custom diagnostic servers. Falls back to the custom list on
// failure.
async function buildServerLists() {
  const envCustom = envCustomInstances(process.env);
  try {
    const home = await fetchText("https://monochrome.tf/", "");
    const m = (home.bodyText || "").match(/assets\/index-[A-Za-z0-9_-]+\.js/);
    if (!m) throw new Error("no asset bundle link found");
    const bundleResp = await fetchText("https://monochrome.tf/" + m[0], "");
    const bundle = updater.parseBundleInstances(bundleResp.bodyText || "");
    const uptimeUrls = bundle.uptimeUrls && bundle.uptimeUrls.length ? bundle.uptimeUrls : UPTIME_URLS;
    const uptimeSources = await Promise.all(uptimeUrls.map(async function (url) {
      try {
        const upResp = await fetchText(url, "");
        return updater.parseUptimeJson(JSON.parse(upResp.bodyText || "{}"));
      } catch (e) {
        console.warn("warn: uptime source failed (" + url + "): " + e.message);
        return { api: [], streaming: [], uptimeUrls: [] };
      }
    }));
    const lists = mergeServerSources(bundle, uptimeSources, envCustom);
    if (lists.apiUrls.length === 0) throw new Error("bundle yielded no instances");
    return lists;
  } catch (e) {
    console.warn("warn: live upstream fetch failed (" + e.message + ") — using custom fallback list only");
    return mergeServerSources(null, [], envCustom);
  }
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

module.exports = {
  API_PROBE_PATH: API_PROBE_PATH,
  STREAM_PROBE_TRACK_ID: STREAM_PROBE_TRACK_ID,
  streamProbePath: streamProbePath,
  hasStreamPayload: hasStreamPayload,
  classify: classify,
  describeDetail: describeDetail,
  formatRow: formatRow,
  formatTable: formatTable,
  splitServerList: splitServerList,
  envCustomInstances: envCustomInstances,
  mergeServerSources: mergeServerSources,
};
