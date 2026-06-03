const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPlugin, plain } = require("./harness.js");

test("all uptime URLs failing falls back and probing finds no instances → degraded badge", async (t) => {
  const h = loadPlugin();
  t.after(() => h.deactivate());
  // Everything fails: uptime URLs throw, and probes throw too.
  h.setFetch(async (url) => { throw new Error("network down: " + url); });

  h.action("check-health");
  await h.settle();

  // With no reachable instance, health is degraded → error badge set on "tidal".
  const lastBadge = h.badges[h.badges.length - 1];
  assert.ok(lastBadge, "a badge call happened");
  // plain() re-roots the plugin's vm-realm object into the test realm so
  // deepEqual's prototype check passes (see harness.js plain()).
  assert.deepEqual(plain(lastBadge.badge), { type: "dot", variant: "error" });
});

test("reachable api+streaming instances → badge cleared (healthy)", async (t) => {
  const h = loadPlugin();
  t.after(() => h.deactivate());
  h.stubFetch({
    "tidal-uptime": { body: { api: [{ url: "https://api.test", version: "9" }], streaming: [{ url: "https://api.test", version: "9" }] }, status: 200 },
    // streaming probe must return a stream payload to count as usable
    "id=35132878": { body: { data: { manifest: "abc" } }, status: 200 },
    // api probe
    "s=test&limit=1": { body: { data: { items: [] } }, status: 200 },
  });

  h.action("check-health");
  await h.settle();

  const lastBadge = h.badges[h.badges.length - 1];
  assert.equal(lastBadge.badge, null, "healthy → badge cleared");
});
