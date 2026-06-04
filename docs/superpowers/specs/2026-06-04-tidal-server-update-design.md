# Design: TIDAL server-list updater script

**Date:** 2026-06-04
**Status:** Approved (design phase)

## Problem

TIDAL streaming servers ("instances") periodically go offline and are replaced.
The plugin already fetches a live list at runtime from status-tracker "uptime"
APIs every 15 minutes (`CACHE_TTL_MS`), probes each instance, and caches the
working ones (`index.js:52–271`). What goes **stale** is the *hardcoded* data
baked into `index.js`:

- `FALLBACK_INSTANCES` (`index.js:66–88`) — a hand-copied mirror of Monochrome's
  built-in default list, used only when all uptime URLs are unreachable.
- `UPTIME_URLS` (`index.js:54–58`) — the status-tracker endpoints. The plugin
  currently hardcodes three; the live Monochrome bundle now lists only one
  (`tidal-uptime.geeked.wtf`), so this has already drifted.

A maintainer currently updates these by hand. This design adds a maintainer-run
script to regenerate them from upstream sources before a release.

## Scope

**In scope:** a dev-side updater script that refreshes `FALLBACK_INSTANCES` and
`UPTIME_URLS` in `index.js`, plus unit tests and a `DEVELOPING.md` note.

**Out of scope (YAGNI):**
- Runtime behavior changes (how the plugin fetches/caches live lists).
- Auto-committing or auto-bumping the version.
- Scheduled CI / drift-detection automation.
- Changing how the plugin loads its fallback (no external JSON artifact).

## Form

`scripts/update-instances.mjs` — a **zero-dependency Node script** (Node 18+
built-in `fetch`), consistent with the repo's existing zero-dep test harness.
Invoked via `npm run update-instances`. No new dependencies, no bash.

## Flow

```
fetch 3 sources → parse each → merge + dedupe → reconcile fields
   → prioritize ordering → render new JS blocks → splice into index.js
   → print git diff (no commit)
```

## Sources & parsing

Three source adapters, each returning a normalized shape (missing parts → empty
arrays), each wrapped in try/catch with a short timeout and best-effort
semantics:

```
{ api: [{url, version}], streaming: [{url, version}], uptimeUrls: [string] }
```

1. **Monochrome bundle (canonical source of truth).**
   - Fetch `https://monochrome.tf/`.
   - Regex out the current `assets/index-*.js` path (the asset hash changes per
     release, so it must be read dynamically).
   - Fetch that bundle.
   - Extract the `defaultInstances:{api:[...],streaming:[...]}` object literal
     and the `INSTANCES_URLS:[...]` array using a tolerant extractor:
     balanced-brace/bracket slice, then normalize the minified
     `{url:"...",version:"..."}` entries into parseable JSON.
   - Contributes: versioned api/streaming split + uptime URLs.

2. **Uptime API** (`https://tidal-uptime.geeked.wtf`).
   - Fetch JSON `{api, streaming}`. Contributes live URLs.
   - Note: this endpoint did not respond during design-phase probing, which is
     exactly why every source is treated as best-effort.

3. **GitHub `INSTANCES.md`**
   (`https://raw.githubusercontent.com/monochrome-music/monochrome/main/INSTANCES.md`).
   - Fetch raw markdown, parse the API-instances table rows for URLs.
   - No version/split available → all URLs go to the `api` bucket, `version: null`.
   - Note: this file is self-flagged "outdated (April 30th, 2026)", so it is the
     weakest source — contributes extra URLs only.

**Resilience:** if a non-canonical source fails, log a warning and continue. If
the **bundle** (source of truth) fails to fetch or parse, **abort** with a clear
error rather than producing a degraded list.

## Merge & reconcile

- **Normalize** each URL: strip trailing slashes (mirrors the plugin's
  `normalizeInstance`, `index.js:92–97`) and lowercase the scheme+host portion
  (instance URLs are bare origins with no path). This makes dedupe
  case-insensitive on host while leaving the runtime normalization unchanged.
- **Dedupe by URL**, per bucket (api / streaming).
- **Field reconciliation:**
  - `version` — prefer the bundle's value; else first non-null from another
    source; else `null`.
  - bucket — the bundle's api/streaming split wins; URLs seen only in the uptime
    API keep their bucket; `INSTANCES.md`-only URLs default to `api`.
- **uptimeUrls** — union of the bundle's `INSTANCES_URLS` and any others, deduped.
- **Ordering** — mirror the *bucketing* of the plugin's `prioritizeInstances`
  (`index.js:123–134`): hifi.geeked.wtf first, `.qqdl.site` last, everything else
  in the middle. The runtime shuffles the middle and qqdl groups for load
  distribution; the updater deliberately **does not shuffle** — it emits each
  group in source order so that unchanged upstream data produces a byte-stable
  diff. (The shuffle still happens at runtime, on the written list.)

## Rewriting index.js & output

- Locate `var FALLBACK_INSTANCES = {…};` and `var UPTIME_URLS = […];` by
  anchored regex (`var NAME = ` … balanced delimiter … `;`).
- Render replacements in the file's existing style: 2-space indentation,
  `var`/double-quotes, `{ url: "...", version: "..." }` one entry per line —
  byte-identical formatting to the current blocks, so unchanged entries produce
  no diff noise.
- Splice in place, write the file, then run `git diff -- index.js` and print it.
- The script **does not commit, bump, or edit the changelog** — the maintainer
  reviews the diff, then follows the normal release flow (bump + CHANGELOG + tag).
- **Safety:** if either block cannot be located, abort without writing (no
  partial edits).

## Testing

`test/update-instances.test.js` covering the **pure logic** against fixed string
fixtures (no network), matching the existing zero-dep harness style:

- bundle-snippet parsing (object-literal + array extraction)
- merge + dedupe across sources
- field reconciliation (version preference, bucket assignment)
- deterministic prioritization/ordering
- JS-block rendering (byte-identical formatting)

Networked source adapters are kept thin and separated from pure logic so the
logic is unit-testable without mocking `fetch`.

## Docs

A note in `DEVELOPING.md` describing when and how to run
`npm run update-instances`, and that the maintainer reviews the printed diff
before committing.

## Components summary

| Unit | Responsibility | Depends on |
| --- | --- | --- |
| source adapters (×3) | fetch + parse one upstream source → normalized shape | `fetch` |
| `mergeInstances` | union + dedupe + reconcile fields | pure |
| `prioritize` | deterministic ordering | pure |
| `renderBlock` | normalized list → byte-exact JS source block | pure |
| `spliceIndexJs` | locate + replace the two blocks, abort-safe | fs |
| CLI entry | orchestrate flow, print diff | child_process (git) |
