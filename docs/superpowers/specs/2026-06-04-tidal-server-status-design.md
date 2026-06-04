# Design: TIDAL server-status diagnostic script

**Date:** 2026-06-04
**Status:** Approved (design phase)

## Problem

When the in-app banner reports "TIDAL streaming is unavailable — search may still
work", a maintainer has no quick way to see *which* servers are up and *why* the
others are down. During this session the cause was diagnosed by hand-writing
ad-hoc probes twice — work that surfaced two non-obvious failure modes a naive
check would miss:

- a corporate proxy returning a captive-portal **splash page with HTTP 200**
  (masquerading as a healthy response), and
- servers where **search returns 200 but the streaming endpoint returns
  `403/500 {"detail":"Upstream API error"}`** — an upstream outage, not a dead
  mirror.

This script turns that ad-hoc debugging into one command.

## Scope

**In scope:** a maintainer-run diagnostic `scripts/server-status.js`
(`npm run server-status`) that probes every server the plugin could use —
**sync** (uptime URLs), **search** (api instances), **streaming** (streaming
instances) — and prints a grouped console table with rich failure
classification. Plus unit tests for the pure logic and a `DEVELOPING.md` note.

**Out of scope (YAGNI):**
- `--json` output flag.
- A "source" column tagging where each server came from.
- Refactoring `index.js` to export its probe internals.
- Watch/polling mode.
- Exit-code gating (the script always exits 0).
- CI wiring.

## Form

`scripts/server-status.js` — a **zero-dependency Node script** (Node 18+ global
`fetch`, `AbortController`, `performance.now()`), same shape as
`scripts/update-instances.js`: a `require.main === module` CLI guard, pure logic
exported for unit tests, thin networked probing kept separate. Invoked via
`npm run server-status`.

## Reuse and the one unavoidable duplication

The script builds its server list from the **live upstream merged with the
hardcoded fallback**, reusing `update-instances.js`'s already-exported PURE
functions: `parseBundleInstances`, `parseUptimeJson`, `mergeSources`,
`normalizeUrl` (and friends). Note: `update-instances.js` does NOT export its
networked `fetchBundle`/`fetchUptime` — so this script defines its own
`fetchText` and the small adapters that call those pure parsers.

The probe *details* live inside `index.js`'s `new Function`-wrapped body and are
**not importable**. The script therefore defines its own copies, as named
constants with a comment pointing at the mirrored `index.js` lines so drift is
visible:

- `API_PROBE_PATH = "/search/?s=test&limit=1"` (mirrors `index.js:58`)
- `STREAM_PROBE_TRACK_ID = "35132878"` (mirrors `index.js:59`)
- the streaming path `"/track/?id=" + STREAM_PROBE_TRACK_ID + "&quality=LOW"`
  (mirrors `index.js:150`)
- `hasStreamPayload(json)`: truthy if `data.manifest || data.url ||
  data.streamUrl || data.originalTrackUrl || data.OriginalTrackUrl` where
  `data = json.data || json` (mirrors `index.js:142-146`)

(The rejected alternative — refactoring `index.js` to export these — is out of
scope and risks the shipped plugin.)

## Categories & probes

Three sections, matching the plugin's real concepts:

1. **SYNC (uptime URLs)** — each `UPTIME_URLS` endpoint. Probe: plain GET of the
   URL. `UP` means it returns a parseable JSON body (the plugin's actual use). A
   `200` whose body is HTML is a failure (catches a sync endpoint serving a
   splash/HTML page).
2. **SEARCH (api instances)** — each merged api instance, probed with
   `API_PROBE_PATH`. `UP` = HTTP 2xx with a JSON body.
3. **STREAMING (streaming instances)** — each merged streaming instance, probed
   with the streaming path. `UP` = 2xx **and** `hasStreamPayload` true.

**Server list source:** live-fetched bundle + uptime data, merged with the
hardcoded fallback via `mergeSources`, so the report reflects what the plugin
sees at runtime — not just the baked-in list. Rows are listed by category only
(no source-tag column).

The `UPTIME_URLS` list itself is mirrored from `index.js` the same way the probe
constants are (it is not exported). It is both probed as the SYNC category and
used (together with the bundle) as a source for the api/streaming lists.

## Failure classification (pure function)

`classify(category, result)` → verdict, where `result` is
`{ status, bodyText, threw, timedOut }`. Pure and unit-testable. Verdicts:

| Verdict | Trigger |
| --- | --- |
| `UP` | Passed the category's success rule (2xx + expected payload). |
| `TIMEOUT` | The probe aborted on the timeout. |
| `CONN-FAILED` | `fetch` threw (DNS/TLS/refused). |
| `PROXY-SPLASH` | Body looks like a captive-portal/HTML page: matches `/<!doctype html/i`, `/Proxy-VPN/i`, or `/splash/i`. |
| `UPSTREAM-ERROR` | Reached the server but it reports upstream failure: body contains `"Upstream API error"`, OR (streaming category) 2xx with no stream payload. |
| `HTTP <code>` | Any other non-2xx response (e.g. `HTTP 502`, `HTTP 403`). |

**Precedence** (first match wins):

1. `threw` → `CONN-FAILED`
2. `timedOut` → `TIMEOUT`
3. body matches splash patterns → `PROXY-SPLASH` (checked before status, so an
   intercepted 200/4xx is never mislabeled)
4. body contains `"Upstream API error"` → `UPSTREAM-ERROR`
5. status is 2xx:
   - SYNC/SEARCH: body parses as JSON → `UP`, else `PROXY-SPLASH` (a 2xx whose
     body isn't JSON is an interception/garbage page)
   - STREAMING: `hasStreamPayload` true → `UP`, else `UPSTREAM-ERROR` (server
     answered but produced no stream)
6. else → `HTTP <code>`

This is the single source of truth for classification; the verdict table above
is a summary of these rules.

## Probing, errors & output

- **Concurrency:** within a category, probe in parallel (`Promise.all`); across
  categories, sequential so sections print in a stable order (SYNC, SEARCH,
  STREAMING).
- **Timeout:** per-request `AbortController`, ~12s.
- **Latency:** `performance.now()` around each fetch, reported in ms.
- **Best-effort list-building:** if the live upstream fetch fails (proxy/outage),
  fall back to the hardcoded list alone and print a one-line warning — never
  abort. The script must be useful *during* an outage.
- **Exit code:** always `0` (it is a report, not a gate).
- **Output:** plain text, no color codes (copy-pasteable). Simple column padding.
  Each row: verdict, HTTP status, latency (ms), and a short truncated `detail`
  snippet (e.g. the `{"detail":...}` text). Each category ends with a summary
  line, e.g. `SEARCH: 6/11 up`.

### Example output (illustrative)

```
SYNC (uptime URLs)
  UP            200  142ms  https://tidal-uptime.geeked.wtf
  ...
  SYNC: 1/1 up

SEARCH (api instances)
  UP            200  210ms  https://api.monochrome.tf
  HTTP 502      502   88ms  https://maus.qqdl.site
  CONN-FAILED     -    -    https://tidal.kinoplus.online  (fetch failed)
  SEARCH: 6/11 up

STREAMING (streaming instances)
  UPSTREAM-ERROR 403  176ms  https://hifi.geeked.wtf  ({"detail":"Upstream API error"})
  STREAMING: 0/6 up
```

## Components summary

| Unit | Responsibility | Depends on |
| --- | --- | --- |
| `classify` | (category, result) → verdict string. Pure. | none |
| `formatTable` | rows → printable lines (padding, summaries). Pure. | none |
| `fetchText` / probe adapters | thin networked I/O per server. | `fetch` |
| list builder | live bundle + uptime + fallback → merged lists. | `update-instances.js` pure exports, `fetchText` |
| CLI entry | orchestrate categories, print table, exit 0. | the above |

## Testing

`test/server-status.test.js` (zero-dep, no network), matching the existing
harness style:

- `classify` against fixtures: good search JSON (→ `UP`), good stream payload
  (→ `UP`), `{"detail":"Upstream API error"}` (→ `UPSTREAM-ERROR`), proxy-splash
  HTML (→ `PROXY-SPLASH`, including when carried on a 200 and on a 403 to prove
  precedence), a 502 (→ `HTTP 502`), HTML body on a SYNC probe (→ `PROXY-SPLASH`
  / failure), streaming 2xx without payload (→ `UPSTREAM-ERROR`), `threw`
  (→ `CONN-FAILED`), `timedOut` (→ `TIMEOUT`).
- `formatTable`: given rows, asserts the expected line strings and summary count.

Networked probing is kept thin and separated from pure logic so no `fetch`
mocking is needed.

## Docs

A short `DEVELOPING.md` subsection near §7c describing `npm run server-status`
and when to use it: "when the in-app banner says streaming is unavailable and you
want to know *why* — it classifies each server (up / HTTP error / timeout /
proxy-splash / upstream-error)."
