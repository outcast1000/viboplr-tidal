# Changelog

## v1.2.1
- Downloads now default to AAC (320kbps); FLAC (lossless) is offered as the
  second option.
- Saved download files are named from the stream manifest's actual container
  (TIDAL sometimes wraps FLAC in an MP4 container), so the extension matches the
  real file instead of being assumed from the requested format.

## v1.2.0
- Moved the plugin to its own repository with in-app auto-update.
