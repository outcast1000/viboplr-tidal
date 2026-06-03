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
// + probing many mirrors) to settle against the real network.
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
