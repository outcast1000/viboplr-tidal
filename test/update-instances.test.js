const { test } = require("node:test");
const assert = require("node:assert/strict");
const u = require("../scripts/update-instances.js");

test("normalizeUrl strips trailing slashes and lowercases the host", () => {
  assert.equal(u.normalizeUrl("https://HiFi.Geeked.WTF/"), "https://hifi.geeked.wtf");
  assert.equal(u.normalizeUrl("https://api.monochrome.tf///"), "https://api.monochrome.tf");
  assert.equal(u.normalizeUrl("https://maus.qqdl.site"), "https://maus.qqdl.site");
});

test("normalizeUrl returns null for empty/invalid input", () => {
  assert.equal(u.normalizeUrl(""), null);
  assert.equal(u.normalizeUrl(null), null);
  assert.equal(u.normalizeUrl(123), null);
});

test("normalizeEntry handles string and object inputs", () => {
  assert.deepEqual(u.normalizeEntry("https://maus.qqdl.site/"), { url: "https://maus.qqdl.site", version: null });
  assert.deepEqual(u.normalizeEntry({ url: "https://hifi.geeked.wtf", version: "2.7" }), { url: "https://hifi.geeked.wtf", version: "2.7" });
  assert.deepEqual(u.normalizeEntry({ url: "https://x.test", version: "" }), { url: "https://x.test", version: null });
  assert.equal(u.normalizeEntry(null), null);
  assert.equal(u.normalizeEntry({ version: "9" }), null);
});

test("sliceBalanced returns the balanced delimiter span", () => {
  const s = "x={a:[1,[2]],b:3};y";
  const start = s.indexOf("{");
  assert.equal(u.sliceBalanced(s, start, "{", "}"), "{a:[1,[2]],b:3}");
  const arrStart = s.indexOf("[");
  assert.equal(u.sliceBalanced(s, arrStart, "[", "]"), "[1,[2]]");
});

test("sliceBalanced returns null for out-of-bounds openIdx", () => {
  assert.equal(u.sliceBalanced("test", 10, "[", "]"), null);
  assert.equal(u.sliceBalanced("test", 4, "[", "]"), null); // exactly at length
});

test("extractEntries pulls url/version pairs from a minified array", () => {
  const seg = '[{url:"https://a.test",version:"2.7"},{url:"https://b.test"}]';
  assert.deepEqual(u.extractEntries(seg), [
    { url: "https://a.test", version: "2.7" },
    { url: "https://b.test", version: null },
  ]);
});

test("parseBundleInstances picks the populated defaultInstances and reads uptime URLs", () => {
  // Mimics the real bundle: an empty config stub appears BEFORE the populated one.
  const js =
    'a={_KEY:"v9",INSTANCES_URLS:["https://tidal-uptime.geeked.wtf"],defaultInstances:{api:[],streaming:[]}};' +
    'this.defaultInstances={api:[{url:"https://hifi.geeked.wtf",version:"2.7"},{url:"https://api.monochrome.tf",version:"2.5"}],' +
    'streaming:[{url:"https://hifi.geeked.wtf",version:"2.7"}]};';
  const r = u.parseBundleInstances(js);
  assert.deepEqual(r.api, [
    { url: "https://hifi.geeked.wtf", version: "2.7" },
    { url: "https://api.monochrome.tf", version: "2.5" },
  ]);
  assert.deepEqual(r.streaming, [{ url: "https://hifi.geeked.wtf", version: "2.7" }]);
  assert.deepEqual(r.uptimeUrls, ["https://tidal-uptime.geeked.wtf"]);
});

test("parseBundleInstances returns empty arrays when nothing matches", () => {
  const r = u.parseBundleInstances("nothing relevant here");
  assert.deepEqual(r, { api: [], streaming: [], uptimeUrls: [] });
});

test("parseUptimeJson passes through api/streaming arrays", () => {
  const r = u.parseUptimeJson({ api: [{ url: "https://a.test", version: "9" }], streaming: ["https://b.test"] });
  assert.deepEqual(r, {
    api: [{ url: "https://a.test", version: "9" }],
    streaming: ["https://b.test"],
    uptimeUrls: [],
  });
  assert.deepEqual(u.parseUptimeJson(null), { api: [], streaming: [], uptimeUrls: [] });
});

test("parseInstancesMd extracts backticked URLs into the api bucket", () => {
  const md = [
    "| **Monochrome** | `https://monochrome-api.samidy.com` | Official |",
    "|                | `https://api.monochrome.tf`         | Official |",
    "| UI link [monochrome.tf](https://monochrome.tf) is not backticked |",
  ].join("\n");
  const r = u.parseInstancesMd(md);
  assert.deepEqual(r.api, [
    { url: "https://monochrome-api.samidy.com", version: null },
    { url: "https://api.monochrome.tf", version: null },
  ]);
  assert.deepEqual(r.streaming, []);
});

test("prioritize orders hifi first, qqdl last, middle in insertion order", () => {
  const input = [
    { url: "https://maus.qqdl.site", version: "2.6" },
    { url: "https://api.monochrome.tf", version: "2.5" },
    { url: "https://hifi.geeked.wtf", version: "2.7" },
    { url: "https://eu-central.monochrome.tf", version: "2.7" },
    { url: "https://wolf.qqdl.site", version: "2.2" },
  ];
  assert.deepEqual(u.prioritize(input).map((x) => x.url), [
    "https://hifi.geeked.wtf",
    "https://api.monochrome.tf",
    "https://eu-central.monochrome.tf",
    "https://maus.qqdl.site",
    "https://wolf.qqdl.site",
  ]);
});

test("mergeSources dedupes, prefers bundle version, buckets md-only as api, unions uptime URLs", () => {
  const bundle = {
    api: [{ url: "https://hifi.geeked.wtf", version: "2.7" }],
    streaming: [{ url: "https://hifi.geeked.wtf", version: "2.7" }],
    uptimeUrls: ["https://tidal-uptime.geeked.wtf"],
  };
  const uptime = {
    api: [{ url: "https://hifi.geeked.wtf/", version: "9.9" }],
    streaming: [{ url: "https://maus.qqdl.site", version: "2.6" }],
    uptimeUrls: [],
  };
  const md = {
    api: [{ url: "https://api.monochrome.tf", version: null }],
    streaming: [],
    uptimeUrls: [],
  };
  const merged = u.mergeSources([bundle, uptime, md]);

  assert.deepEqual(merged.api, [
    { url: "https://hifi.geeked.wtf", version: "2.7" },
    { url: "https://api.monochrome.tf", version: null },
  ]);
  assert.deepEqual(merged.streaming, [
    { url: "https://hifi.geeked.wtf", version: "2.7" },
    { url: "https://maus.qqdl.site", version: "2.6" },
  ]);
  assert.deepEqual(merged.uptimeUrls, ["https://tidal-uptime.geeked.wtf"]);
});

test("renderFallbackBlock matches index.js formatting byte-for-byte", () => {
  const merged = {
    api: [
      { url: "https://hifi.geeked.wtf", version: "2.7" },
      { url: "https://x.test", version: null },
    ],
    streaming: [{ url: "https://hifi.geeked.wtf", version: "2.7" }],
  };
  const expected = [
    "  var FALLBACK_INSTANCES = {",
    "    api: [",
    '      { url: "https://hifi.geeked.wtf", version: "2.7" },',
    '      { url: "https://x.test", version: null },',
    "    ],",
    "    streaming: [",
    '      { url: "https://hifi.geeked.wtf", version: "2.7" },',
    "    ],",
    "  };",
  ].join("\n");
  assert.equal(u.renderFallbackBlock(merged), expected);
});

test("renderUptimeBlock matches index.js formatting byte-for-byte", () => {
  const expected = [
    "  var UPTIME_URLS = [",
    '    "https://tidal-uptime.geeked.wtf",',
    '    "https://other.test",',
    "  ];",
  ].join("\n");
  assert.equal(u.renderUptimeBlock(["https://tidal-uptime.geeked.wtf", "https://other.test"]), expected);
});

test("spliceBlocks replaces both blocks in place", () => {
  const source = [
    "(function () {",
    '  var UPTIME_URLS = [',
    '    "https://old-uptime.test",',
    "  ];",
    "  var CACHE_TTL_MS = 900000;",
    "  var FALLBACK_INSTANCES = {",
    "    api: [",
    '      { url: "https://old.test", version: "1.0" },',
    "    ],",
    "    streaming: [",
    "    ],",
    "  };",
    "  return {};",
    "})",
  ].join("\n");
  const fb = u.renderFallbackBlock({ api: [{ url: "https://new.test", version: "2.0" }], streaming: [] });
  const up = u.renderUptimeBlock(["https://new-uptime.test"]);
  const out = u.spliceBlocks(source, fb, up);
  assert.ok(out.includes('"https://new-uptime.test",'), "uptime replaced");
  assert.ok(out.includes('{ url: "https://new.test", version: "2.0" },'), "fallback replaced");
  assert.ok(!out.includes("old.test"), "old fallback gone");
  assert.ok(!out.includes("old-uptime.test"), "old uptime gone");
  assert.ok(out.includes("var CACHE_TTL_MS = 900000;"), "untouched code preserved");
});

test("spliceBlocks throws when an anchor is missing", () => {
  assert.throws(() => u.spliceBlocks("no blocks here", "x", "y"), /UPTIME_URLS/);
});
