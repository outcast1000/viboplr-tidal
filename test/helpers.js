const fs = require("node:fs");
const path = require("node:path");

// Load a canned TIDAL API response from test/fixtures/.
function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"));
}

// Stub map that brings instances "up": the uptime API returns one api + one
// streaming instance, and the api/streaming probes succeed. Pass `extra`
// mappings (e.g. a specific /track/?id=... manifest) to merge in. The probe
// paths (`s=test&limit=1`, `id=35132878`) mirror index.js's probeInstances().
function upStubs(extra) {
  return Object.assign({
    "tidal-uptime": { body: { api: [{ url: "https://api.test", version: "9" }], streaming: [{ url: "https://api.test", version: "9" }] }, status: 200 },
    "id=35132878": { body: { data: { manifest: "x", url: "https://x" } }, status: 200 },
    "s=test&limit=1": { body: { data: { items: [] } }, status: 200 },
  }, extra || {});
}

// upStubs() plus the three real search endpoints answered with fixtures
// (order matches index.js tidalSearch: s= tracks, a= artists, al= albums).
function searchStubs() {
  return upStubs({
    "/search/?s=": { body: fixture("search-tracks.json"), status: 200 },
    "/search/?a=": { body: fixture("search-artists.json"), status: 200 },
    "/search/?al=": { body: fixture("search-albums.json"), status: 200 },
  });
}

module.exports = { fixture: fixture, upStubs: upStubs, searchStubs: searchStubs };
