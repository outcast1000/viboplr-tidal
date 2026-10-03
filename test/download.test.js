const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPlugin, plain } = require("./harness.js");
const { fixture, upStubs } = require("./helpers.js");

test("onGetQualities returns aac then flac", async (t) => {
  const h = loadPlugin();
  t.after(() => h.deactivate());
  const qualities = h.getQualities();
  // plain() re-roots the plugin's vm-realm array into the test realm so
  // deepEqual's prototype check passes (see harness.js plain()).
  assert.deepEqual(plain(qualities).map((q) => q.value), ["aac", "flac"]);
});

test("resolveByUri returns m4a ext when manifest container is mp4 even for flac format", async (t) => {
  const h = loadPlugin();
  t.after(() => h.deactivate());
  // stream-manifest.json declares mimeType audio/mp4
  h.stubFetch(upStubs({ "/track/?id=1001": { body: fixture("stream-manifest.json"), status: 200 } }));
  h.action("check-health");
  await h.settle();

  const result = await h.resolveByUri("tidal://1001", "flac");
  assert.ok(result, "resolved");
  assert.equal(result.url, "https://cdn.example/track.flac");
  // downloadExt: container (mp4 -> m4a) wins over requested flac format.
  assert.equal(result.ext, "m4a");
});

test("resolveByUri returns null for non-tidal uri", async (t) => {
  const h = loadPlugin();
  t.after(() => h.deactivate());
  h.stubFetch(upStubs());
  h.action("check-health");
  await h.settle();
  const result = await h.resolveByUri("spotify://abc", "flac");
  assert.equal(result, null);
});

test("resolveByMetadata searches then resolves first track's stream", async (t) => {
  const h = loadPlugin();
  t.after(() => h.deactivate());
  h.stubFetch(upStubs({
    "/search/?s=": { body: fixture("search-tracks.json"), status: 200 },
    "/search/?a=": { body: { data: { artists: { items: [] } } }, status: 200 },
    "/search/?al=": { body: { data: { albums: { items: [] } } }, status: 200 },
    "/track/?id=1001": { body: fixture("stream-manifest.json"), status: 200 },
  }));
  h.action("check-health");
  await h.settle();

  const result = await h.resolveByMetadata("Test Song", "Test Artist", "Test Album", 210, "aac");
  assert.ok(result, "resolved");
  assert.equal(result.url, "https://cdn.example/track.flac");
  assert.equal(result.metadata.title, "Test Song");
  assert.equal(result.metadata.artist, "Test Artist");
});

test("download-playlist-from-tidal matches each track and opens the download modal once", async (t) => {
  const h = loadPlugin();
  t.after(() => h.deactivate());
  h.stubFetch(upStubs({
    "/search/?s=": { body: fixture("search-tracks.json"), status: 200 },
  }));
  h.action("check-health");
  await h.settle();

  h.contextAction("download-playlist-from-tidal", {
    kind: "playlist",
    playlistName: "Mix",
    tracks: [{ title: "Test Song", artistName: "Test Artist" }],
  });
  await h.settle();

  const req = h.requests.find((r) => r.name === "download-tracks");
  assert.ok(req, "requested the host download modal");
  assert.equal(req.data.providerId, "tidal-browse:tidal-download");
  assert.equal(req.data.tracks.length, 1);
  assert.match(req.data.tracks[0].uri, /^tidal:\/\/\d+$/);
  assert.equal(h.downloads.length, 0, "never touches the removed background queue");
});
