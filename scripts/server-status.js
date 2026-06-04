"use strict";

// Maintainer diagnostic: probe every TIDAL server the plugin could use — sync
// (uptime URLs), search (api instances), and streaming (streaming instances) —
// and print a grouped table classifying each as UP / TIMEOUT / CONN-FAILED /
// PROXY-SPLASH / UPSTREAM-ERROR / HTTP <code>. Pure logic is exported for unit
// tests; the CLI runs only when invoked directly. Always exits 0 (it is a
// report, not a gate).

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

module.exports = {
  API_PROBE_PATH: API_PROBE_PATH,
  STREAM_PROBE_TRACK_ID: STREAM_PROBE_TRACK_ID,
  streamProbePath: streamProbePath,
  hasStreamPayload: hasStreamPayload,
  classify: classify,
  describeDetail: describeDetail,
  formatRow: formatRow,
  formatTable: formatTable,
};
