# Viboplr TIDAL Plugin

Search, stream, and download from TIDAL inside Viboplr. Talks to TIDAL over HTTP
via the host's `api.network.fetch` (no native backend support required).

Plugin id: `tidal-browse` (installed from the Viboplr plugin gallery; it is not
bundled in the app).

## Install

In Viboplr: **Extensions → Install from URL** and paste this repo's URL, or it
auto-updates if already installed (the app checks `updateUrl` every 24h).

## Develop & Release

For every release:

1. **Refresh the TIDAL server list:** run `npm run update-instances` and commit
   any resulting change to `index.js` (it rewrites the hardcoded
   `FALLBACK_INSTANCES` / `UPTIME_URLS` from upstream, or reports "No changes").
   See `DEVELOPING.md` → *Updating the TIDAL server list*.
2. Edit `index.js` / `manifest.json` as needed, **bump `version` in
   `manifest.json`**, and add a `## vX.Y.Z` section at the top of `CHANGELOG.md`.

Then publish via CI (preferred) or manually.

### Release via CI (preferred)

A GitHub Actions workflow (`.github/workflows/release.yml`) builds and publishes
the release. It verifies the `manifest.json` version matches the release version
and that the zip has `manifest.json` at its root, then attaches `tidal.zip` +
`update.json`. Two ways to trigger it:

- **Push a tag:** after committing the version bump + changelog, run
  `git tag vX.Y.Z && git push origin vX.Y.Z`.
- **Manual dispatch:** GitHub → Actions → *Release* → *Run workflow*, enter the
  version (must equal `manifest.json`). CI creates the tag for you.

Bump helper: `scripts/bump.sh <patch|minor|major|X.Y.Z>` rewrites the
`manifest.json` version and prepends a `## vX.Y.Z` CHANGELOG section (with a
`TODO` to fill in). It does not commit/tag/push — review, fill in the changelog,
then release.

### Release manually (fallback)

1. `scripts/package.sh` → produces `tidal.zip` + `update.json`.
   - The zip MUST contain `manifest.json` at its root (the script guarantees this;
     verify via the printed `unzip -l`).
2. `gh release create vX.Y.Z tidal.zip update.json --repo outcast1000/viboplr-tidal --title "vX.Y.Z" --notes-file CHANGELOG.md`

The update endpoint is the permanent
`https://github.com/outcast1000/viboplr-tidal/releases/latest/download/update.json`.

See `DEVELOPING.md` for the plugin develop/debug workflow.
