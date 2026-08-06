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
- Apple Team ID: `TEAMID1234`;
- signing authority: `Developer ID Application: XtraSaltyDev (TEAMID1234)`;
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

The update service downloads the ZIP over HTTPS with the configured private CA,
refuses redirects and cross-origin artifacts, enforces published size and
SHA-256, writes a local Squirrel feed, and waits for Squirrel's
`update-downloaded` event. **Restart now** calls `autoUpdater.quitAndInstall()`.

Sotto must never move, delete, edit, or replace its own running app bundle. It
must never relaunch a path inside a retired bundle. Rollback copies and update
replacement are owned by the framework, not application code.

## Ad-hoc to Developer ID transition

Published 0.1.22 through 0.1.24 Mac artifacts are ad-hoc signed. They have no
Apple Team ID, fail Gatekeeper, and cannot establish the identity required for
safe automatic updates.

The first corrected release must use `SOTTO_MAC_MANUAL_INSTALL_ONLY=1`. Its
legacy-compatible signed manifest omits the Mac ZIP, causing old clients to
download and reveal the signed/notarized DMG. Users replace the app manually
once. The next release removes the flag and proves Developer ID A-to-B automatic
updating.

The manual replacement preserves user data because application data is outside
the bundle. The first transition can require one final microphone or system
audio approval. Later releases with the same bundle ID, Team ID, and designated
requirement should retain the stable macOS identity; this must still be tested
on a representative installed client.

## Release and acceptance gates

`scripts/release.sh` must stop before publication unless all source, package,
and Apple checks pass. `scripts/publish-spark-distribution.sh` independently
rechecks the exact DMG and ZIP content, then uploads artifacts under pending
names and publishes the signed manifest last.

Release acceptance requires separate evidence for:

- source: lint, type checking, tests, and clean release commit;
- package: embedded config/CA/receipt and native resource verification;
- Apple: Developer ID authority, Team ID, Hardened Runtime, app and DMG tickets,
  and Gatekeeper acceptance;
- publication: hosted hashes and signed manifest match the release commit;
- installation: fresh DMG install from a representative user path;
- update: installed Developer ID version A updates to B through Squirrel.Mac;
- continuity: settings, transcripts, microphone, and system-audio capture remain
  usable after update;
- network: office LAN and corporate VPN can fetch the real manifest and ZIP.

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
