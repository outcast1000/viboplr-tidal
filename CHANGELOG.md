# Changelog

## v1.3.0
- **Runs in the plugin worker runtime.** It now gets only what it asks for
  — `network:*`, `system:open`, `playback:control`, `library:read` — and can't reach anything else in the app. Viboplr asks
  you to allow these once when you update. Requires Viboplr 1.0.85.
- **Fixed: "Download playlist from TIDAL" did nothing.** It called the host's
  background download queue, which no longer exists. It now matches the
  playlist's tracks on TIDAL and opens the standard download modal with them,
  saying how many weren't found.
- `network:*` because the list of TIDAL API instances is fetched at runtime
  and changes without a plugin release.

## v1.2.4
- **Menu items no longer carry a "TIDAL:" prefix of their own** ("Search",
  "Play", "Download"). Apps that prefix plugin menu items with the plugin name
  show them as "TIDAL: Search" etc.; older apps show the bare labels.

## v1.2.3
- Refreshed the built-in TIDAL server list from upstream: dropped two dead
  status-tracker endpoints and reprioritized the fallback instances, so the
  plugin spends fewer probes on unreachable servers when the live list is down.

## v1.2.2
- Stream manifest decoding no longer depends on a browser `atob` global: it uses
  a self-contained base64 decoder as a fallback, so streaming and downloads work
  regardless of which globals the host sandbox exposes.
- Removed the developer-only "Mock Mode" setting (it served fake search/stream
  data and was not meant for end users).

## v1.2.1
- Downloads now default to AAC (320kbps); FLAC (lossless) is offered as the
  second option.
- Saved download files are named from the stream manifest's actual container
  (TIDAL sometimes wraps FLAC in an MP4 container), so the extension matches the
  real file instead of being assumed from the requested format.

## v1.2.0
- Moved the plugin to its own repository with in-app auto-update.
