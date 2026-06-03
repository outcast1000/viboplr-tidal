const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPlugin } = require("./harness.js");
const { fixture, searchStubs } = require("./helpers.js");

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
