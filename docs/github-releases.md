# GitHub Releases

Sotto publishes public macOS artifacts through the manually dispatched
`Publish signed macOS release` workflow. A release is allowed only when an
existing `vX.Y.Z` tag points to the exact `main` commit and `package.json`
contains the same version.

The workflow runs the complete source gates, provisions the pinned native
runtime, imports a Developer ID certificate into an ephemeral keychain, signs
and notarizes the app and DMG, mounts and verifies the result, creates SHA-256
checksums and GitHub build-provenance attestations, and finally creates the
GitHub Release. Every prerequisite fails closed.

## Release environment secrets

Configure these secrets in the protected `release` environment:

- `SOTTO_MAC_CERTIFICATE_P12_BASE64`
- `SOTTO_MAC_CERTIFICATE_PASSWORD`
- `SOTTO_CI_KEYCHAIN_PASSWORD`
- `SOTTO_APPLE_ID`
- `SOTTO_APPLE_APP_SPECIFIC_PASSWORD`
- `SOTTO_APPLE_TEAM_ID`

The P12 must contain exactly one Developer ID Application identity. Secrets,
private keys, notarization profiles, and exported certificates must never be
stored in Git.

## Publishing

1. Update `package.json` and `package-lock.json` to the intended version.
2. Merge the verified version commit to `main`.
3. Create and push `vX.Y.Z` at that exact commit.
4. Dispatch `Publish signed macOS release` with that tag.
5. Install the DMG from an anonymous browser session and verify launch,
   Gatekeeper acceptance, recording permissions, transcription, and removal.

Public builds intentionally do not embed the former private update
configuration or CA. Until a separately reviewed public update origin exists,
users download new signed releases from GitHub Releases.
