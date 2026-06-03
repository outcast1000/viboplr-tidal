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
