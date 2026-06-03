const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const PLUGIN_PATH = path.join(__dirname, "..", "index.js");

// Default network.fetch: throws on any unmapped URL so a forgotten stub fails
// loudly. Tests override via opts.fetch or h.stubFetch().
function makeThrowingFetch(label) {
  return async function (url) {
    throw new Error(label + ": unstubbed network.fetch for " + url);
  };
}

// Re-root a value into the test realm. The plugin runs in a vm context with
// its OWN intrinsics, so arrays/objects it returns are not `instanceof` the
// test realm's Array/Object — `assert.deepEqual` (strict) compares prototypes
// and fails on that mismatch even when the data is identical. A JSON round-trip
// rebuilds the value using the test realm's intrinsics. Use this when deep-
// comparing plugin-returned structured data (arrays/objects); not needed for
// primitive (`assert.equal`) comparisons.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// A minimal Response-like for the fake bridge.
function makeResponse(body, status) {
  const isString = typeof body === "string";
  return {
    status: status == null ? 200 : status,
    async json() { return isString ? JSON.parse(body) : body; },
    async text() { return isString ? body : JSON.stringify(body); },
  };
}

function loadPlugin(opts) {
  opts = opts || {};

  // --- Fake timer tracking (so we can assert deactivate cleans up) ---
  // These fakes are injected into the vm sandbox; Node's real timers are never
  // patched. The plugin's _healthCheckInterval therefore uses these.
  let nextTimerId = 1;
  const liveIntervals = new Set();
  function fakeSetInterval() { const id = nextTimerId++; liveIntervals.add(id); return id; }
  function fakeClearInterval(id) { liveIntervals.delete(id); }

  // --- Effect recorders ---
  // These capture every outbound effect the plugin pushes through the bridge.
  // Not all are asserted by the current suites — they are the harness's public
  // surface, kept complete so future tests can inspect any effect.
  const fetches = [];   // { url, opts }
  const views = [];     // { viewId, payload }
  const badges = [];     // { viewId, badge }
  const playbacks = []; // { method, args }
  const downloads = []; // enqueue payloads
  const notifications = [];
  const requests = [];  // ui.requestAction { name, data }
  const logs = [];      // { level, message, section }

  // --- Handler registries ---
  const uiActions = {};
  const contextActions = {};
  const imageFetchers = {};
  const resolvers = {}; // streamResolveByUri, streamResolveFallback, resolveByUri, resolveByMetadata, getQualities, interactiveSearch, interactiveResolve

  // --- Programmable network.fetch ---
  let fetchImpl = opts.fetch || makeThrowingFetch("harness");

  const api = {
    network: {
      async fetch(url, fetchOpts) {
        fetches.push({ url: url, opts: fetchOpts });
        return fetchImpl(url, fetchOpts);
      },
      openUrl() {},
    },
    storage: (function () {
      const store = new Map(Object.entries(opts.storage || {}));
      return {
        async get(key) { return store.has(key) ? store.get(key) : null; },
        async set(key, value) { store.set(key, value); },
      };
    })(),
    playback: {
      playTrack(t) { playbacks.push({ method: "playTrack", args: [t] }); },
      playTracks(arr, i, o) { playbacks.push({ method: "playTracks", args: [arr, i, o] }); },
      insertTracks(arr, i) { playbacks.push({ method: "insertTracks", args: [arr, i] }); },
      onStreamResolve(name, cb) { resolvers.streamResolveFallback = cb; },
      onResolveStreamByUri(name, cb) { resolvers.streamResolveByUri = cb; },
    },
    downloads: {
      enqueue(obj) { downloads.push(obj); return Promise.resolve(); },
      onGetQualities(name, cb) { resolvers.getQualities = cb; },
      onResolveByUri(name, cb) { resolvers.resolveByUri = cb; },
      onResolveByMetadata(name, cb) { resolvers.resolveByMetadata = cb; },
      onInteractiveSearch(name, cb) { resolvers.interactiveSearch = cb; },
      onInteractiveResolve(name, cb) { resolvers.interactiveResolve = cb; },
    },
    imageProviders: {
      onFetch(entity, cb) { imageFetchers[entity] = cb; },
    },
    contextMenu: {
      onAction(name, cb) { contextActions[name] = cb; },
    },
    playlists: {
      getTracks(id) { return Promise.resolve((opts.playlists && opts.playlists[id]) || []); },
    },
    ui: {
      setViewData(viewId, payload) { views.push({ viewId: viewId, payload: payload }); },
      setBadge(viewId, badge) { badges.push({ viewId: viewId, badge: badge }); },
      onAction(name, cb) { uiActions[name] = cb; },
      requestAction(name, data) { requests.push({ name: name, data: data }); },
      showNotification(msg) { notifications.push(msg); },
      navigateToView(viewId) { requests.push({ name: "navigateToView", data: viewId }); },
    },
    log(level, message, section) { logs.push({ level: level, message: message, section: section }); },
  };

  // --- Sandbox globals (mirror the host's frozen set) + atob, plus the timer fakes ---
  //
  // CRITICAL: we load via node:vm, NOT `new Function`. With `new Function`, a
  // *bare* reference inside index.js (e.g. `setInterval(...)`, `atob(...)`,
  // `Math`) resolves to Node's REAL global, ignoring the `window`/`globalThis`
  // params — so timer tracking and the noAtob test would silently no-op. A vm
  // context makes bare globals resolve to exactly this sandbox object, which is
  // also more faithful to the host's frozen-global environment.
  const sandbox = {
    console: console, Math: Math, JSON: JSON, Date: Date, Promise: Promise,
    Object: Object, Array: Array, String: String, Number: Number, RegExp: RegExp,
    Error: Error, encodeURIComponent: encodeURIComponent, decodeURIComponent: decodeURIComponent,
    parseInt: parseInt, parseFloat: parseFloat, isNaN: isNaN, isFinite: isFinite,
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    setInterval: fakeSetInterval, clearInterval: fakeClearInterval,
    atob: opts.noAtob ? undefined : (typeof atob === "function" ? atob : undefined),
  };
  // The host passes window/globalThis/self/document as a frozen object; index.js
  // doesn't touch the DOM, so a frozen empty object suffices for those params.
  const frozen = Object.freeze({});

  // --- Load and run index.js as the host does (sandboxed globals) ---
  const code = fs.readFileSync(PLUGIN_PATH, "utf8");
  const context = vm.createContext(sandbox);
  const wrapped = "(function (api, window, globalThis, self, document) {\n" + code + "\n})";
  const factory = vm.runInContext(wrapped, context, { filename: "index.js" });
  const mod = factory(api, frozen, frozen, frozen, frozen);
  mod.activate(api);

  // --- Driver helpers ---
  return {
    activate: mod.activate,
    deactivate: mod.deactivate || function () {},
    api: api,
    // recorders
    fetches: fetches, views: views, badges: badges, playbacks: playbacks,
    downloads: downloads, notifications: notifications, requests: requests, logs: logs,
    // registry presence flags
    has: {
      get streamResolveByUri() { return !!resolvers.streamResolveByUri; },
      get streamResolveFallback() { return !!resolvers.streamResolveFallback; },
      get resolveByUri() { return !!resolvers.resolveByUri; },
      get resolveByMetadata() { return !!resolvers.resolveByMetadata; },
    },
    // drivers
    action(name, data) {
      if (!uiActions[name]) throw new Error("no ui action handler: " + name);
      return uiActions[name](data);
    },
    contextAction(name, target) {
      if (!contextActions[name]) throw new Error("no context action handler: " + name);
      return contextActions[name](target);
    },
    streamResolveByUri(id, quality) { return resolvers.streamResolveByUri(id, quality); },
    streamResolveFallback(title, artist, album) { return resolvers.streamResolveFallback(title, artist, album); },
    resolveByUri(uri, format) { return resolvers.resolveByUri(uri, format); },
    resolveByMetadata(title, artist, album, dur, format) { return resolvers.resolveByMetadata(title, artist, album, dur, format); },
    getQualities() { return resolvers.getQualities(); },
    imageFetch(entity) { var rest = Array.prototype.slice.call(arguments, 1); return imageFetchers[entity].apply(null, rest); },
    // network stub control
    stubFetch(map) {
      fetchImpl = async function (url) {
        // Match the most specific (longest) key first so an overlapping
        // shorter pattern can't shadow a more specific one.
        const keys = Object.keys(map).sort(function (a, b) { return b.length - a.length; });
        for (let i = 0; i < keys.length; i++) {
          if (url.indexOf(keys[i]) !== -1) {
            const entry = map[keys[i]];
            return makeResponse(entry.body, entry.status);
          }
        }
        throw new Error("harness.stubFetch: no mapping matched " + url);
      };
    },
    setFetch(fn) { fetchImpl = fn; },
    timers: { activeIntervals() { return liveIntervals.size; } },
    // Flush pending promise chains. Needed because some handlers (e.g.
    // check-health, search) are fire-and-forget: they kick off an async chain
    // but do NOT return the promise, so awaiting the handler is not enough.
    async settle(ms) { await new Promise((r) => setTimeout(r, ms == null ? 20 : ms)); },
  };
}

module.exports = { loadPlugin: loadPlugin, makeResponse: makeResponse, plain: plain };
