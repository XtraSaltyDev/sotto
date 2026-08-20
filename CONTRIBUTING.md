# Contributing to Sotto

Sotto is a local-first Electron application. Keep changes focused, preserve its
offline privacy guarantees, and never commit real recordings, transcripts,
credentials, signing material, private infrastructure details, or generated
runtime payloads.

## Development setup

Use the Node.js and npm versions declared in `.node-version` and `package.json`:

```bash
npm ci
npm run lint
npm run typecheck
npm test
```

Native runtime provisioning and packaging are documented in `README.md` and
`resources/sidecars/README.md`. Local packages are development artifacts and
must not be represented as signed public releases.

## Pull requests

- Explain the user-visible behavior and privacy or security impact.
- Add focused tests for changed behavior.
- Keep generated files and unrelated formatting out of the change.
- Report security vulnerabilities through `SECURITY.md`, not a public pull
  request or issue.
