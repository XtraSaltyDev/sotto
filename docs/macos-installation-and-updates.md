# macOS Installation and Update Contract

This is Sotto's engineering contract for direct macOS distribution outside the
Mac App Store. It separates development packages, release artifacts,
publication, installation, automatic updates, and privacy-permission acceptance.

## Distribution model

Sotto is distributed directly as an Apple Silicon application. The supported
artifacts are:

- a DMG for first install, repair, and the one-time Developer ID bootstrap;
- a ZIP containing `Sotto.app` for automatic updates through Electron's
  Squirrel.Mac framework.

The Mac App Store path is out of scope. A Developer ID release is not App Store
review, and direct distribution does not require App Sandbox. Hardened Runtime
and notarization are required.

## Stable application identity

Every release must preserve all of these values:

- bundle ID: `com.sotto.desktop`;
- Apple Team ID: the project-owned release team configured outside Git;
- signing authority: a Developer ID Application identity for that same team;
- a designated code requirement compatible with the installed release;
- a strictly increasing numeric `CFBundleShortVersionString`.

Apple describes the designated requirement as the rule that identifies future
versions of the same program. Squirrel.Mac uses that boundary to reject an
update that is not signed as the same application.

## Release artifact requirements

The app and every nested executable must:

1. be signed with the Developer ID Application identity;
2. use Hardened Runtime;
3. include a secure signing timestamp;
4. keep code and resources in valid bundle locations;
5. pass `codesign --verify --deep --strict`;
6. be accepted by Apple's notary service;
7. carry a stapled notarization ticket;
8. pass Gatekeeper execution assessment.

The DMG must contain the exact verified app at its root and an Applications
shortcut. The finished DMG must also be Developer ID signed, submitted to the
notary service, stapled, checksum-valid, and accepted by Gatekeeper. The ZIP
must be created after the app is stapled so the update contains that exact app.

Do not modify anything inside `Sotto.app` after signing. Settings, transcripts,
models downloaded after install, update staging, and all other mutable data
belong under normal per-user data directories, not in the signed bundle.

## Installation behavior

The supported manual journey is:

1. download the DMG from the authenticated Sotto channel;
2. open the DMG;
3. quit any running Sotto process;
4. drag Sotto to Applications and approve replacement when applicable;
5. eject the DMG;
6. launch Sotto from Applications.

Running from a mounted DMG is unsupported because the volume is read-only and
cannot be updated. Running arbitrary copies from Downloads or build output is
also unsupported for installed-client acceptance because each path can have a
different code and privacy identity.

Gatekeeper evaluates downloaded software at install/first launch. The release
must work without asking users to disable Gatekeeper, remove quarantine, use
Control-click overrides, or run `xattr` commands.

## Automatic update behavior

Sotto keeps two independent trust layers:

1. its Ed25519-signed manifest authenticates version, bundle ID, source commit,
   publication time, artifact URL, size, and SHA-256;
2. Squirrel.Mac verifies the downloaded replacement against the installed
   app's Apple code requirement and applies it after the app quits.

For an update ZIP no larger than 900 MiB, the update service downloads it over
HTTPS with the configured trust roots, refuses redirects and cross-origin
artifacts, enforces the published size and SHA-256, then streams the verified
file to Squirrel through a temporary server bound only to `127.0.0.1`. The
loopback feed closes as soon as Squirrel reports `update-downloaded`. Do not use
a `file://` feed here.

Squirrel.Mac still buffers the full response internally. The default Whisper
model is now external to the signed app, so ordinary update archives are
expected to remain comfortably below 900 MiB and can use the automatic path.
The publisher must omit any archive above the ceiling, and the client
independently ignores an oversized archive that appears in a manifest. In that
case Sotto downloads the signed, notarized DMG to Downloads and asks the user to
replace the app manually. The model is provisioned separately through the
trusted update origin and is not copied again during an app update.

Sotto must never move, delete, edit, or replace its own running app bundle. It
must never relaunch a path inside a retired bundle. Rollback copies and update
replacement are owned by the framework, not application code.

## Ad-hoc to Developer ID transition

Existing ad-hoc Mac artifacts have no Apple Team ID, fail Gatekeeper, and
cannot establish the identity required for safe automatic updates.

The first corrected release is automatically manual-only while its verified
Mac ZIP exceeds 900 MiB. Its legacy-compatible signed manifest omits the ZIP,
causing old clients to
download and reveal the signed/notarized DMG. Users replace the app manually
once. Later releases may remove the flag only after the update archive is below
the enforced Squirrel size ceiling. With the Whisper model external to the app,
unchanged-model Mac releases can use the automatic archive path.

The manual replacement preserves user data because application data is outside
the bundle. The first transition can require one final microphone or system
audio approval. Later releases with the same bundle ID, Team ID, and designated
requirement should retain the stable macOS identity; this must still be tested
on a representative installed client.

## Release and acceptance gates

The GitHub-native public-release workflow requires a clean tagged commit,
pinned toolchain and lockfile, source and native-runtime gates, Developer ID
signing, notarization, artifact checksums, provenance, and mounted-DMG
verification. Publication remains separate from candidate creation and never
silently falls back to ad-hoc signing. Fresh-install acceptance from the public
GitHub Release remains a required operator check before announcing a release.

Release acceptance requires separate evidence for:

- source: lint, type checking, tests, and clean release commit;
- package: embedded config/CA/receipt and native resource verification;
- Apple: Developer ID authority, Team ID, Hardened Runtime, app and DMG tickets,
  and Gatekeeper acceptance;
- staging: remote immutable artifacts match the candidate hashes while the
  stable pointer is unchanged;
- publication: the hosted signed stable manifest exactly matches the accepted
  candidate and release commit;
- installation: fresh DMG install from a representative user path;
- update: an installed Developer ID version downloads and installs the
  notarized DMG, or—only for an archive below the enforced ceiling—updates
  through Squirrel.Mac;
- continuity: settings, transcripts, microphone, and system-audio capture remain
  usable after update;
- model continuity: an upgrade reuses a matching managed model without a second
  copy, while a fresh install visibly provisions or imports the model;
- network: a representative client can fetch the published manifest and
  artifacts from the intended release origin.

Package or server checks alone do not prove the installed update journey.

## Primary references

- [Apple: Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- [Apple: Customizing the notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)
- [Apple: Resolving common notarization issues](https://developer.apple.com/documentation/security/resolving-common-notarization-issues)
- [Apple: Packaging Mac software for distribution](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution)
- [Apple: macOS Code Signing In Depth](https://developer.apple.com/library/archive/technotes/tn2206/_index.html)
- [Apple: Developer ID](https://developer.apple.com/support/developer-id/)
- [Electron: Updating applications](https://www.electronjs.org/docs/latest/tutorial/updates)
- [Electron: `autoUpdater`](https://www.electronjs.org/docs/latest/api/auto-updater/)
- [Electron: Code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing)
- [Electron Forge: ZIP update manifests](https://www.electronforge.io/config/makers/zip)
