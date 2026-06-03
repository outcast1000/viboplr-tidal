# Changelog

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
