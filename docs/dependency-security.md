# Dependency security

Sotto's CI treats production dependencies and development-only packaging tools
as separate trust boundaries. Every push and pull request runs:

```bash
npm audit --omit=dev --audit-level=high
```

Production dependencies must have no unresolved high-severity advisory. The
full development tree is also reviewed, but an upstream build-tool advisory is
not automatically treated as shipped application code.

## Current Electron Forge exceptions

As of August 20, 2026, Electron Forge 7.11.2 is the latest stable release and
still pulls two high-severity advisory paths for which no compatible published
upgrade exists:

- `@electron/packager` uses `extract-zip@2.0.1`. Sotto reaches it only while
  unpacking checksum-verified Electron release archives during development and
  packaging; the application never exposes it to imported recordings or other
  user-controlled ZIP files.
- `@electron-forge/maker-dmg` uses `image-size@0.7.5` through `appdmg`. Sotto
  reaches it only for the maker's package-pinned default background image; it never
  processes a user-selected image.

The webpack development server is explicitly bound to loopback and is never
included in a packaged application. Compatible fixed transitive versions are
pinned through `package.json` overrides where available.

These exceptions must be rechecked whenever Electron Forge publishes a stable
upgrade. They do not waive production audit failures or justify processing
untrusted archives or images with the affected packages.
