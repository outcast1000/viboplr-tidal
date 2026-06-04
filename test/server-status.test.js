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
  assert.equal(s.classify("streaming", { status: 200, bodyText: SEARCH_OK }), "UPSTREAM-ERROR");
  assert.equal(s.classify("search", { status: 200, bodyText: "not json at all" }), "PROXY-SPLASH");
});

test("classify: other non-2xx falls through to HTTP <code>", () => {
  assert.equal(s.classify("search", { status: 502, bodyText: "bad gateway" }), "HTTP 502");
  assert.equal(s.classify("streaming", { status: 404, bodyText: "nope" }), "HTTP 404");
});

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

test("formatRow keeps the url column aligned even for the longest verdict", () => {
  const short = s.formatRow({ verdict: "UP", status: 200, latencyMs: 10, url: "https://a.test" });
  const longest = s.formatRow({ verdict: "UPSTREAM-ERROR", status: 403, latencyMs: 9, url: "https://b.test" });
  assert.equal(short.indexOf("https://a.test"), longest.indexOf("https://b.test"), "url column aligned for UPSTREAM-ERROR");
});

test("classify does not flag a JSON body merely containing the word splash", () => {
  const body = JSON.stringify({ data: { items: [{ title: "Big Splash" }] } });
  assert.equal(s.classify("search", { status: 200, bodyText: body }), "UP");
});

test("describeDetail: UP rows have no detail", () => {
  assert.equal(s.describeDetail("UP", { status: 200, bodyText: "{}" }), "");
});

test("describeDetail: proxy-splash reports page kind and byte size", () => {
  const html = '<!doctype html><html><head><title>Proxy-VPN</title></head></html>';
  assert.equal(s.describeDetail("PROXY-SPLASH", { status: 200, bodyText: html }), "html page, " + html.length + "b");
  assert.equal(s.describeDetail("PROXY-SPLASH", { status: 200, bodyText: "garbage" }), "non-JSON body, 7b");
});

test("describeDetail: timeout and conn-failed", () => {
  assert.equal(s.describeDetail("TIMEOUT", { timedOut: true }), "timed out");
  assert.equal(s.describeDetail("CONN-FAILED", { threw: true, detail: "fetch failed" }), "fetch failed");
  assert.equal(s.describeDetail("CONN-FAILED", { threw: true }), "connection failed");
});

test("describeDetail: upstream/http show a whitespace-collapsed body snippet", () => {
  assert.equal(s.describeDetail("UPSTREAM-ERROR", { status: 403, bodyText: '{"detail":"Upstream API error"}' }), '{"detail":"Upstream API error"}');
  assert.equal(s.describeDetail("HTTP 502", { status: 502, bodyText: "bad   gateway\n" }), "bad gateway");
});
