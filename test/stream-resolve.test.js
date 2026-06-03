const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPlugin } = require("./harness.js");
const { fixture, upStubs } = require("./helpers.js");

test("onResolveStreamByUri decodes BTS manifest to a URL", async (t) => {
  const h = loadPlugin();
  t.after(() => h.deactivate());
  h.stubFetch(upStubs({ "/track/?id=1001": { body: fixture("stream-manifest.json"), status: 200 } }));
  h.action("check-health");
  await h.settle();

  const url = await h.streamResolveByUri("1001", "LOSSLESS");
  assert.equal(url, "https://cdn.example/track.flac");
});

test("onResolveStreamByUri returns null when streaming is down", async (t) => {
  const h = loadPlugin();
  t.after(() => h.deactivate());
  // No check-health → state.streamingDown stays true (initial).
  const url = await h.streamResolveByUri("1001", "LOSSLESS");
  assert.equal(url, null);
});

test("decodeBase64 fallback works without atob", async (t) => {
  // Reload the plugin with atob removed from the sandbox to exercise the
  // pure-JS base64 fallback path.
  const h = loadPlugin({ noAtob: true });
  t.after(() => h.deactivate());
  h.stubFetch(upStubs({ "/track/?id=1001": { body: fixture("stream-manifest.json"), status: 200 } }));
  h.action("check-health");
  await h.settle();

  const url = await h.streamResolveByUri("1001", "LOSSLESS");
  assert.equal(url, "https://cdn.example/track.flac");
});
