# Sotto

Sotto is a private, local-first desktop transcription app built with Electron
Forge, React, and TypeScript. The current macOS Apple Silicon build can import
real audio and video recordings—including downloaded Microsoft Teams MP4s—then
extract audio, transcribe it with a bundled `whisper.cpp` engine, save the
result locally, display timestamped text, and export a plain-text transcript.
It also clusters voices into transcript-local speaker labels that can be
renamed, and exports Microsoft Word (`.docx`) transcripts.
On macOS 13 or newer it can also record a live Teams meeting's desktop audio
and your microphone, then transcribe that capture when you stop.

Nothing is uploaded. Sotto has no cloud service, accounts, analytics, updater,
automatic summarization, or cloud capture.

## What works now

- Common local audio and video import through the native file picker
- Live Teams/system-audio plus microphone capture on macOS 13+ (with explicit
  operating-system recording permissions)
- Audio-track detection and duration probing
- Offline conversion to mono 16 kHz PCM with a minimal, network-disabled FFmpeg
- English transcription with `whisper.cpp` 1.9.1 and the `small.en` model
- Local speaker clustering with generic Speaker 1, Speaker 2, and similar
  labels, plus per-transcript renaming (macOS 15.5+ for the current native
  speaker runtime)
- Live preparing/transcribing/saving progress, cancellation, and CPU fallback
  if Metal cannot initialize
- Atomic transcript persistence plus durable original WebM retention for live
  recordings
- Recoverable failed/cancelled live transcriptions with Retry Transcription,
  Export Recording, and intentional Delete Recording actions
- Recent, timestamped transcript detail, delete, speaker rename, plain-text
  export, and Microsoft Word export views
- One active job at a time, bounded diagnostics, abandoned-job cleanup, and no
  persisted source paths
- A sandboxed renderer and narrow typed IPC boundary
- A reproducible, checksummed macOS arm64 runtime build

On macOS 13 and newer, **Record live meeting** captures the desktop/system audio
that includes Teams participants and mixes it with microphone input when that
permission is granted. While capture is active, Sotto writes a clearly named
private `recording.partial.webm`. When you stop, it closes the stream and
atomically renames that file to a durable `recording.webm` before transcription
starts. The completed original is kept if transcription succeeds, fails, is
cancelled, or the app restarts. Sotto does not join Teams, inspect Teams APIs,
or upload the call. The Record button is disabled on macOS 12, unsupported
platforms, builds without the local engine, and macOS app copies that have not
been granted Screen & System Audio Recording access.

Sotto does not use recordings or transcripts for model training and does not
collect or infer training consent. Any future training use would require a
separate explicit approval design.

## Supported input

The picker accepts AAC, FLAC, M4A, MP3, OGG, OPUS, WAV, AVI, M4V, MKV, MOV,
MP4, WebM, and WMV files up to 20 GB. The bundled decoder supports the common
AAC, ALAC, FLAC, MP3, Opus, Vorbis, WMA, WavPack, and PCM audio tracks found in
those containers. A video without a supported audio track fails with an
actionable error and is never modified.

The transcription model is English-only. Sotto separates voices locally, but
it cannot read participant names from Teams: labels begin as `Speaker 1`,
`Speaker 2`, and so on, and apply only within that transcript. Rename them after
the meeting if desired. Sotto stores no reusable voiceprints. Overlapping
speech, very short turns, music, and noisy mixed audio can remain labeled
`Unclear`; Sotto does not guess when timing is ambiguous. It produces
timestamped speech, not meeting summaries or action items.

## Use the current macOS build

This saved project already contains a verified macOS arm64 runtime and model.
Build the unpacked app:

```bash
npm install
npm run package
npm run make
```

Then open:

```text
out/Sotto-darwin-arm64/Sotto.app
```

For the normal macOS download, use the generated disk image:

```text
out/make/Sotto-0.1.0-arm64.dmg
```

Open the DMG and drag **Sotto** onto **Applications**. The ZIP remains
available as an alternate artifact and for static-file update workflows.

Local packages use an ad-hoc signature without Hardened Runtime. That is
intentional: on macOS 26, a hardened process cannot load Electron components
that were separately ad-hoc signed because they do not share an Apple Team ID.
Set `SOTTO_MAC_SIGNING_IDENTITY` to a valid Developer ID Application identity
when producing a hardened distribution build.

For an ad-hoc local build, open the DMG and drag `Sotto.app` to
**Applications** before setting up live recording. If Sotto shows **Open System
Settings**, use that button and,
under **Privacy & Security → Screen & System Audio Recording**, click **+**,
choose the exact `Sotto.app` copy in Applications, and turn it on. Choose
**Quit & Reopen** when macOS asks. Because an ad-hoc identity changes when the
app is rebuilt, repeat this step after replacing Sotto with a newer build.

Click **Import Recording**, choose a local audio/video file, and leave the
source file in place until the job completes. The source is read-only. Sotto
deletes only its derived normalized WAV and temporary engine output after each
terminal job.

For a live Teams call on macOS 13+, complete the Screen & System Audio
Recording setup above, then click **Record live meeting** before the call
begins. Approve the microphone prompt if you want your side of the conversation
included. Keep the Teams call playing through the Mac's normal audio output;
Sotto captures that desktop mix and your microphone without joining or
controlling Teams.
Click **Stop recording** when the call ends. Sotto closes and promotes the local
WebM file, records its job/transcript link in private metadata, and starts
transcription automatically. If transcription fails or is cancelled, the saved
recording remains visible with a Retry Transcription action. If microphone
permission is declined, the recording can continue with Teams/system audio
only, with a warning shown in the app.

Completed transcripts and original live recordings live under Electron's
per-user application-data directory:

```text
macOS:   ~/Library/Application Support/Sotto/transcripts/
         ~/Library/Application Support/Sotto/recordings/
         ~/Library/Application Support/Sotto/jobs/       (temporary only)
Windows: %APPDATA%\Sotto\transcripts\
         %APPDATA%\Sotto\recordings\
```

Each transcript is one schema-validated JSON file with display-only source
metadata, text, timestamps, transcript-local speaker labels, duration,
language, and engine provenance. Exported `.txt` and `.docx` files go only to
the location selected in the native save dialog. Imported media stays in its
original location and is not copied into Sotto.

Each saved live recording has its own private directory containing
`recording.webm` and atomic, schema-validated `metadata.json`. Directories use
owner-only permissions (`0700`) and files use `0600` where the operating system
supports Unix permissions. Metadata links the recording to its current job and
transcript without exposing a filesystem path to the renderer. Interrupted
partial captures are removed at startup; finalized WebMs are recovered even if
their metadata update was interrupted.

**Export Recording** copies the WebM to a location chosen in the native save
dialog. **Delete Recording** requires a confirmation and removes only the saved
original; an existing transcript remains. Deleting only a transcript keeps the
original recording and makes it available for transcription again.

## Local development

Prerequisites for the app:

- Node.js 22 or newer
- npm 10 or newer

Prerequisites for rebuilding the macOS arm64 runtime:

- Apple Silicon and macOS 12 or newer
- Xcode command-line tools with the Metal compiler
- CMake, Git, curl, make, and tar/xz support

The current `sherpa-onnx` speaker runtime uses a native ONNX Runtime build that
requires macOS 15.5 or newer. On macOS 13–15.4, Sotto can still record and
transcribe, but saves the transcript without speaker labels if that native pass
cannot start. Missing or unreadable speaker resources are handled the same way:
Whisper remains available and the transcript is saved without labels. The
native speaker pass runs in a separate utility process so a native crash cannot
take down Electron or discard the completed Whisper text.

Install, provision, and start:

```bash
npm install
npm run setup:runtime:mac
npm start
```

`setup:runtime:mac` downloads pinned source/model inputs, verifies their hashes,
builds the two native executables, stages complete license material, and writes
`resources/sidecars/darwin-arm64/runtime-manifest.json`. The model is about
465 MB, and the two speaker models add about 45 MB. Native binaries and model
files are intentionally ignored by Git.

To verify an already staged runtime without network, builds, or writes:

```bash
bash scripts/provision-darwin-arm64.sh --verify-only
```

Quality checks:

```bash
npm run lint
npm run typecheck
npm test
npm run test:runtime:mac
npm run package
```

The runtime integration test sends the bundled AAC-in-MP4 fixture through the
real FFmpeg → whisper.cpp → atomic repository pipeline and checks recognized
speech. It is separate from the fast unit suite because it loads the 465 MB
model.

## Architecture

```text
src/
├── index.ts                         Electron lifecycle and secure window
├── preload.ts                       narrow contextBridge API
├── shared/contracts.ts              renderer/main typed contract
├── main/
│   ├── app-controller.ts            state, transcript queries, export mapping
│   ├── ipc/register-desktop-ipc.ts  sender checks and native dialogs
│   ├── media/                       import validation, probe, normalization
│   ├── process/                     direct child process runner
│   ├── recording/                   partial capture, durable store, recovery
│   ├── runtime/                     packaged/dev engine resolution
│   ├── storage/                     atomic transcript repository
│   ├── export/                      DOCX generation
│   └── transcription/               job orchestration, text, speaker alignment
└── renderer/                        React shell, progress, list, detail

scripts/
└── speaker-diarization-child.cjs    isolated native speaker-process entry

resources/
├── diarization/                     staged speaker models outside the ASAR
├── models/                          staged Whisper model outside the ASAR
├── speaker-runtime/                 staged native speaker engine
└── sidecars/<platform-arch>/        executables, manifest, and licenses
```

The main-process flow is:

```text
native file selection or user-started desktop/system-audio capture
  → extension/size/regular-file validation
  → streamed private partial WebM capture (live mode only)
  → atomic promotion to a durable original WebM (live mode only)
  → first-audio-stream probe
  → private temporary 16 kHz WAV
  → whisper.cpp full JSON output with word timing
  → strict output normalization
  → crash-isolated local speaker segmentation, clustering, and bounded word alignment
  → atomic transcript save
  → Recent/detail state update
```

Only the main process sees filesystem paths or launches native code. Child
processes are invoked directly with `shell: false`; loader-injection and Node
runtime environment variables are removed. The renderer has
`contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`. Its
preload exposes only state, import, live-recording chunks, retry/cancel,
recording and transcript delete/export, record lookup, and state-change
methods. IPC requests must come from the current window's main frame, IDs are
validated UUIDs, new windows and unexpected navigation are denied, and only
the trusted renderer's explicit media-capture request is permitted.

Live chunk writes are bounded to 4 MiB per IPC request and 20 GiB per recording.
Opening the private file, each write, and the final stream close have a
15-second wait bound. Asynchronous stream errors and disk-full/quota errors
stop the incomplete capture and show an honest failure; a low-free-space check
blocks a new recording below the 512 MiB safety reserve. These checks reduce
risk but do not replace keeping adequate free disk space for long meetings and
the derived PCM WAV.

## Runtime provenance

The committed provisioning metadata pins:

- `whisper.cpp` v1.9.1 at commit
  `f049fff95a089aa9969deb009cdd4892b3e74916`
- FFmpeg 8.1.2 source archive SHA-256
  `464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c`
- `ggml-small.en.bin` at Hugging Face revision
  `c521a4b02f422512d734391fdf08bb08c0862f68`, SHA-256
  `c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d`

The FFmpeg build is static, LGPL 2.1-or-later, and configured with networking,
shared libraries, documentation, unrelated programs, and unneeded codecs
disabled. See `resources/sidecars/PROVENANCE.md`, `sources.json`, and
`THIRD_PARTY_NOTICES.md` for the exact configuration and redistribution notes.

## Packaging status

### macOS

`npm run package` has been qualified on macOS arm64 and copies the runtime,
model, manifests, and license files outside the ASAR. The local bundle is ad-hoc
signed without Hardened Runtime by the packaging toolchain, which is enough for
local testing but not a public release. A hardened ad-hoc Electron bundle is
rejected at launch by macOS 26 library validation because its nested components
do not share a Developer ID Team ID. Live capture is qualified for the Electron
desktop-capture path on macOS 13+; macOS 12 remains import-only because Chromium
cannot capture desktop audio there without a virtual audio device.

Distribution still requires an owned Apple Developer ID identity supplied as
`SOTTO_MAC_SIGNING_IDENTITY`, hardened runtime signing for the app and sidecars,
notarization, stapling, and a final Sotto app icon. The DMG is the primary
macOS delivery format; the ZIP remains available for alternate and update
workflows.
Intel (`darwin-x64`) has a folder contract but no built or qualified runtime yet.

### Windows

The secure IPC, storage, and `win32-x64` sidecar path contracts are implemented,
and Squirrel.Windows is configured. Windows is **not ready for use yet**: the
pinned x64 `whisper-cli.exe` and minimal `ffmpeg.exe` must be built on a Windows
release host, staged with licenses/model, code-signed, packaged, and exercised
against the same integration fixture on a clean Windows machine. No macOS test
can substitute for that platform qualification.

## Bounded next work

1. Add Windows x64 runtime/provisioning, desktop-audio capture, and a
   clean-machine installer test.
2. Add macOS Intel only if there is a real deployment need.
3. Add an explicit multilingual model choice if non-English meetings are in
   scope.
4. Evaluate speaker-label quality on representative multi-person Teams meetings
   and rebuild the native speaker runtime for older macOS versions if needed.

Cloud sync, accounts, an updater, and automatic summarization remain
intentionally out of scope.

## Primary references

- [Electron Forge Webpack + TypeScript template](https://www.electronforge.io/templates/typescript-%2B-webpack-template)
- [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)
- [Electron process sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox)
- [Electron desktop capture and system-audio caveats](https://www.electronjs.org/docs/latest/api/desktop-capturer)
- [Apple ScreenCaptureKit audio capture](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos)
- [whisper.cpp CLI documentation](https://github.com/ggml-org/whisper.cpp/blob/v1.9.1/examples/cli/README.md)
- [FFmpeg downloads and source](https://ffmpeg.org/download.html)
- [Electron Packager `extraResource`](https://electron.github.io/packager/main/interfaces/Options.html#extraResource)
