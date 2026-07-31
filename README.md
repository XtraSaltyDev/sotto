# Sotto

Sotto is a private, local-first desktop transcription app built with Electron
Forge, React, and TypeScript. The current macOS Apple Silicon and Windows x64
builds can import real audio and video recordings—including downloaded
Microsoft Teams MP4s—then
extract audio, transcribe it with a bundled `whisper.cpp` engine, save the
result locally, display synchronized timestamped text, play retained audio, and
export transcripts, subtitles, portable data, and meeting minutes. Saved transcript segments can be corrected
without changing their timing or speaker assignment. The local Transcript
Library searches titles, transcript text, speaker names, tags, and meeting
summary content without sending a query or transcript off the device.
It also clusters voices into transcript-local speaker labels that can be
renamed, and exports Microsoft Word (`.docx`) transcripts and meeting minutes.
On macOS 13 or newer and Windows 11 x64 it can also record a live Teams
meeting's desktop audio and your microphone, then transcribe that capture when
you stop.

Nothing is uploaded. Sotto has no cloud service, accounts, analytics, updater,
or cloud capture. Its meeting-summary draft is extracted locally from the saved
transcript and links every listed point back to its timestamp.

## What works now

- Common local audio and video import through the native file picker
- Live Teams/system-audio plus microphone capture on macOS 13+ and Windows 11
  x64 (with explicit operating-system recording permissions)
- Microphone-only dictation toggled with **Command/Ctrl + Shift + D** while
  Sotto is running, with cursor insertion and a safe clipboard fallback
- Audio-track detection and duration probing
- Offline conversion to mono 16 kHz PCM with a minimal, network-disabled FFmpeg
- English transcription with `whisper.cpp` 1.9.1 and the `small.en` model
- Local speaker clustering with generic Speaker 1, Speaker 2, and similar
  labels, plus per-transcript renaming (macOS 15.5+ for the current native
  speaker runtime)
- Live preparing/transcribing/saving progress, cancellation, and CPU fallback
  if Metal cannot initialize
- Atomic transcript persistence plus durable original WebM retention and
  closed-file recovery for live recordings
- Recoverable failed/cancelled live transcriptions with Retry Transcription,
  Export Recording, and intentional Delete Recording actions
- A local Transcript Library with full-text search, date/speaker/tag filters,
  editable titles, simple tags, timestamped detail, segment correction,
  transcript search, delete, speaker rename, TXT/DOCX transcript export,
  SRT/WebVTT subtitles, portable JSON, and meeting-minutes export views
- Local meeting-summary drafts with an overview, key points, decisions, action
  items, and transcript-linked timestamps
- Synchronized local playback with clickable segment timestamps, clickable
  words on new transcripts, current-segment highlighting, 0.75x–2x speed, and
  keyboard play/pause and five-second jumps
- One active job at a time, bounded diagnostics, abandoned-job cleanup, and no
  persisted source paths
- A sandboxed renderer and narrow typed IPC boundary
- An optional Local AI connection surface for Ollama and private-network
  OpenAI-compatible endpoints, with model discovery and protected API keys
- Reproducible, checksummed macOS arm64 and Windows x64 runtime builds

On macOS 13 and newer and Windows 11, **Record live meeting** captures the desktop/system audio
that includes Teams participants and mixes it with microphone input when that
permission is granted. While capture is active, Sotto writes a clearly named
private `recording.partial.webm`. When you stop, it closes the stream, marks the
closed file as recoverable, and atomically renames it to a durable
`recording.webm` before transcription starts. If promotion is interrupted, the
closed audio is retried on the next launch instead of being deleted. The
completed original is kept if transcription succeeds, fails, is cancelled, or
the app restarts. Sotto does not join Teams, inspect Teams APIs,
or upload the call. The Record button is disabled on macOS 12, unsupported
platforms, builds without the local engine, and macOS app copies that have not
been granted Screen & System Audio Recording access. Windows permission errors
use Windows-specific guidance rather than macOS setup steps.

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
the meeting if desired. Before importing or recording, **Expected speakers** can
be left on **Auto** or set from 1 to 12 when the count is known. A known count
constrains the existing clustering step, which can prevent noisy recordings
from producing extra speaker labels without running another model pass.
Microphone-only dictation uses one expected speaker automatically. Sotto stores
no reusable voiceprints. At the end of the
local speaker pass, Sotto reviews short timing gaps beside reliable speaker
turns so slightly delayed detections are less likely to strand their opening
words. It also folds a tiny filtered cluster back into a speaker only when
strong matching turns tightly enclose it within the same transcription turn.
Automatic clustering uses a more conservative merge threshold and only
promotes clusters with meaningful word-timing support, capped at 12 reliable
automatic labels. Other tiny fragments become `Unclear` instead of creating
dozens of phantom speakers. Overlapping speech, very short turns, longer gaps,
music, and noisy mixed audio can remain labeled `Unclear`; Sotto does not guess
when timing is still ambiguous.

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

For local DMG validation, use the generated disk image:

```text
out/make/Sotto-0.1.9-arm64.dmg
```

Open the DMG and drag **Sotto** onto **Applications**. The ZIP remains
available as an alternate artifact and for static-file update workflows.

Local packages use an ad-hoc signature without Hardened Runtime. That is
intentional: on macOS 26, a hardened process cannot load Electron components
that were separately ad-hoc signed because they do not share an Apple Team ID.
Set `SOTTO_MAC_SIGNING_IDENTITY` to a valid Developer ID Application identity
when producing a hardened distribution build.

Do not send the output from the normal `npm run make` command as a public
upgrade. It is intentionally ad-hoc signed, so macOS sees each rebuild as a
different app and cannot carry Screen & System Audio or microphone permission
forward. Public macOS releases use the guarded release command:

```bash
export SOTTO_MAC_SIGNING_IDENTITY='Developer ID Application: Company Name (TEAMID)'
export SOTTO_MAC_NOTARY_KEYCHAIN_PROFILE='sotto-release'
npm run make:mac:release
```

Create the named Keychain profile once with `xcrun notarytool
store-credentials`. Release packaging stops if either setting is missing, if
the signing identity is not a Developer ID Application identity, or if signing
fails. Forge notarizes and staples the signed app before placing it in the DMG
and ZIP. Keep both the Apple Developer team and `com.sotto.desktop` bundle ID
unchanged for every release.

That guarded Forge flow notarizes and staples the application before creating
the DMG. If distribution policy also requires the downloadable DMG container
itself to carry a notarization ticket, submit and staple the finished DMG as a
separate release step.

The first Developer-ID-signed release cannot inherit permission that was
granted to an older ad-hoc build because the old grant names that build's exact
code hash. That transition may need one final approval. Use **Request access for
this Sotto** when Sotto detects a stale recording decision. That button calls
Apple's screen-capture consent API from a bundled native helper and keeps any
existing permission entry intact. Approve Apple's prompt with Touch ID or the
Mac password. Sotto never makes this request without the user's repair action.
After the Developer ID transition,
replacing Sotto with later releases signed by the same Apple team should keep
the existing permission.

For an ad-hoc local build, open the DMG and drag `Sotto.app` to
**Applications** before setting up live recording. If Sotto reports a stale
permission after an upgrade, click **Request access for this Sotto**. Because an
ad-hoc identity changes
when the app is rebuilt, repeat this approval after replacing Sotto with a newer
build. If macOS does not show the native prompt, Sotto opens System Settings as
a fallback without removing the existing entry. Under **Privacy & Security →
Screen & System Audio Recording**, turn Sotto on. Do not remove the entry: on
current macOS Tahoe releases, removing it can prevent Apple's native request
from returning until the Mac is restarted. Choose **Quit & Reopen** when macOS
asks.
If macOS has never asked for access, Sotto instead enables **Set up live
recording** so a user click can start the system permission request.

Click **Import Recording**, choose a local audio/video file, and leave the
source file in place until the job completes. The source is read-only. When the
transcript succeeds, Sotto atomically retains its derived mono 16 kHz WAV as a
private playback-audio copy. It does not retain the imported video or its
original path, so playback continues if the original is moved or deleted. The
retained copy is about 115 MB per hour and is normally much smaller than source
video; temporary engine output is removed after every terminal job. Failed or
cancelled imports do not retain a playback copy.

### Local AI connections

Open **Local AI** from the sidebar to connect Ollama or another
OpenAI-compatible endpoint running on this computer or a private network.
**Connect Ollama** uses `http://127.0.0.1:11434/v1`. Sotto also accepts
private IPv4/IPv6 addresses and `.local` hosts, including authenticated LAN
controllers. Public internet endpoints, credentials embedded in URLs, query
strings, redirects, and non-HTTP protocols are rejected.

**Connect and find models** makes a bounded, eight-second `GET /v1/models`
request and validates the OpenAI model-list shape before saving anything. An
optional bearer key is encrypted through the operating system and the renderer
only learns whether a key exists; it never receives the saved value. The
connection file is written atomically with owner-only permissions where the
operating system supports them. Disconnect removes the saved endpoint and
encrypted key.

Sotto always creates its own private meeting draft with Key Points, Decisions,
and Action Items. From a transcript, click **Improve with Local AI** to ask the
selected model for a richer draft. That action sends the transcript text and
speaker labels only to the configured endpoint; it does not change the original
transcript. Sotto maps every generated item back to a real transcript segment,
so its timestamp and speaker link come from the recording rather than the
model. The built-in draft remains available for comparison. Editing transcript
text or a speaker label clears the AI draft so stale results are not shown or
exported.

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
         ~/Library/Application Support/Sotto/playback/
         ~/Library/Application Support/Sotto/jobs/       (temporary only)
Windows: %APPDATA%\Sotto\transcripts\
         %APPDATA%\Sotto\recordings\
         %APPDATA%\Sotto\playback\
```

Each transcript is one schema-validated JSON file with display-only source
metadata, text, segment and word timestamps, transcript-local speaker labels,
title, tags, duration, language, and engine provenance. Schema-v1/v2/v3
transcripts remain readable. Older records gain an empty tag list in memory and
are not rewritten merely because they were opened; schema-v1/v2 records simply
have no clickable word timing. The next transcript, segment, speaker, title, or
tag edit writes the current schema atomically. On Unix-like systems, the
transcript directory is owner-only (`0700`) and each JSON file is owner-private
(`0600`).
Exported `.txt`, `.docx`, `.srt`, `.vtt`, and `.json` files go only to the
location selected in the native save dialog. Sotto writes a private temporary
file beside the selected destination, flushes it, and then replaces the
destination in one rename; a failed write removes the temporary file and does
not truncate an existing export. Imported originals stay in their original
location and are never copied into Sotto; only Sotto's audio-only playback
derivative is retained.

Use **Transcript Library** to search every saved transcript. Search covers
manual titles, full transcript text and segments, transcript-local speaker
names, tags, and the existing local meeting-summary draft. Terms are
case-insensitive, accent-insensitive, and can match different fields in the
same transcript. Date, speaker, and tag filters can be combined with search.
Press **Command + F** on macOS or **Ctrl + F** on Windows while the library is
open to focus its search field. Opening a result and returning to the library
restores keyboard focus to that transcript when it is still visible.

Open a transcript and use **Transcript information** to replace its title or
edit its comma-separated tags. Titles are manual only; Sotto does not generate
them. A transcript can have up to 32 tags of 48 characters each. Tags are a
flat local organizing aid rather than folders, nested workspaces, or shared
collections. Title and tag changes use the same validated atomic record write
as transcript corrections.

Open a transcript to use **Synchronized playback**. Click a timestamp, segment,
or timed word to seek. Space plays or pauses when focus is not in an input or
button; Left and Right Arrow jump five seconds. The speed menu offers 0.75x,
1x, 1.25x, 1.5x, and 2x. The current segment is highlighted. Sotto shows the
retained copy's size and lets **Delete playback audio** remove it while keeping
the transcript. Deleting an imported transcript also deletes its playback copy.
Deleting a live transcript keeps its original WebM ready for another
transcription. If playback audio is missing, was deleted outside Sotto, or
cannot be decoded, the transcript remains readable and exportable and the
detail view shows a non-destructive explanation.

Use **Find in transcript** to search without sending text anywhere. Results are
case-insensitive matching segments; Previous, Next, or Enter moves through them,
scrolls the selected segment into view, and seeks available playback to that
segment without starting it. Use **Edit segment** to correct its text while the
recording remains available for reference. Saving keeps that segment's start
and end time and speaker label, refreshes the Transcript Library and future
exports, and writes the full validated transcript atomically. Because corrected
prose no longer has
a reliable one-to-one relationship with the original Whisper tokens, Sotto
removes old word-level click targets from that edited segment; its timestamp and
whole-segment seeking continue to work. Corrections have explicit Save and
Cancel actions. Sotto does not yet provide search-and-replace, annotations, or
revision history.

Press **Command + Shift + D** on macOS or **Ctrl + Shift + D** on Windows to
start a microphone-only dictation from anywhere while Sotto is running. Press
the same shortcut again to stop, save the private recording, and start local
transcription. Sotto stays in the background and, when transcription finishes,
inserts the converted text at the cursor in the currently focused app. The
**Dictate** button starts the same flow and hides Sotto so you can place the
cursor in the destination app before stopping.

On macOS, automatic insertion requires Sotto under **Privacy & Security →
Accessibility** because the operating system protects simulated paste actions.
If access is missing, or if Windows cannot send the paste action, Sotto leaves
the completed text on the clipboard and keeps the normal saved transcript so
nothing is lost. Paste it manually with **Command+V** or **Ctrl+V**. Cursor
insertion replaces the current clipboard text with the completed dictation.

Each transcript includes a local draft summary. Sotto selects exact transcript
sentences for the overview and key points and recognizes clear decision and
action-item wording. Summary entries keep their source timestamp and speaker
reference, so available playback can jump to the supporting audio. This is an
extractive aid, not a generative model: it does not invent missing context, and
the user should review the linked transcript before relying on it. TXT and DOCX
exports include the same summary.

### Useful output

The transcript detail toolbar keeps output actions in two keyboard-accessible
menus. **Export** opens the native save dialog. **Copy** writes the selected
plain text to the operating-system clipboard and reports success or failure
without logging the copied transcript content.

The export formats are:

- **Full transcript (TXT)**: title, completion date, duration, language, the
  current local meeting summary, and timestamped transcript segments.
- **Full transcript (DOCX)**: a formatted Word document with transcript
  metadata, the current local meeting summary, timestamps, stored speaker
  labels, and the complete transcript.
- **Subtitles (SRT)**: numbered cues with `HH:MM:SS,mmm` timing. Cues use saved
  segment timing and stored speaker labels. When speaker analysis ran but a
  segment could not be assigned, the cue says `Unclear`; Sotto does not invent
  a participant name.
- **Subtitles (WebVTT)**: a valid `WEBVTT` document with numbered cues and
  `HH:MM:SS.mmm` timing. It follows the same timing and speaker rules as SRT and
  escapes cue-text markup characters.
- **Portable transcript data (JSON)**: deterministic UTF-8 JSON with
  `format: "sotto-portable-transcript"` and `formatVersion: 1`. It contains the
  transcript ID, title, tags, dates, duration, language, display-only source
  name/type/media kind, transcription engine, stored speakers, full text,
  segments, word timing arrays, and the current local meeting summary. It does
  not contain raw filesystem paths, playback or private app URLs, recording
  links, file sizes, temporary jobs, permission state, or unrelated storage
  metadata.
- **Meeting minutes (DOCX)**: a focused Word document with the transcript title
  and date, overview, key points, decisions, action items, stored speaker labels
  where available, and timestamp references. It does not duplicate the full
  transcript and does not use a generative model.

The Copy menu provides **Overview**, **Key points**, **Decisions**, **Action
items**, and **Complete meeting minutes**. List items use reusable plain-text
bullets with `HH:MM:SS` references and stored speaker labels when available.
Complete minutes include the title, ISO completion date, and all four summary
sections. Empty sections say that no item was found instead of claiming a fact.

Subtitle export works for schema-v1 and schema-v2 transcripts when segment
timing exists; word timing is not required. Blank segments are omitted. Cue
text is flattened to clean single-line text, and text longer than 240
characters is split at a sensible word boundary with its saved segment time
distributed deterministically. Zero-length cues are extended to at least one
millisecond, and malformed or overlapping inputs are ordered and moved forward
so the exported cues remain valid. These repairs do not alter the saved
transcript. Older transcripts expose empty word arrays in portable JSON.

The summary and minutes remain extractive: short transcripts may have a sparse
overview, and decisions or action items appear only when the saved wording
matches Sotto's local rules. Timestamp references point to the start of the
supporting transcript sentence, not a new factual claim. Export stays on the
device, but anything copied to the operating-system clipboard—including text
placed there for cursor dictation—can be read by other local applications
according to the operating system's clipboard rules.

Each saved live recording has its own private directory containing
`recording.webm` and atomic, schema-validated `metadata.json`. Directories use
owner-only permissions (`0700`) and files use `0600` where the operating system
supports Unix permissions. Metadata links the recording to its current job and
transcript without exposing a filesystem path to the renderer. Interrupted
partial captures are removed at startup. A recording whose encoder closed
successfully has a distinct finalizing marker and is recovered even if file
promotion or its metadata update was interrupted.

**Export Recording** copies the WebM to a location chosen in the native save
dialog. **Delete Recording** requires a confirmation and removes only the saved
original; an existing transcript remains. Deleting only a transcript keeps the
original recording and makes it available for transcription again.

## Local development

Prerequisites for the app:

- Node.js 22.12 or newer
- npm 10 or newer

Prerequisites for rebuilding the macOS arm64 runtime:

- Apple Silicon and macOS 12 or newer
- Xcode command-line tools with the Metal compiler
- CMake, Git, curl, make, and tar/xz support

Prerequisites for cross-building the Windows x64 runtime on a Mac:

- Docker or Colima running with an x86-64-capable Linux container runtime
- Bash plus standard `file`, SHA-256, and archive tools

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

To build and stage the pinned Windows x64 runtime, or verify an existing staged
copy without downloading or changing it:

```bash
npm run setup:runtime:windows
bash scripts/provision-win32-x64.sh --verify-only
```

The Windows provisioner cross-builds static `whisper-cli.exe` and a minimal,
network-disabled `ffmpeg.exe`, stages the Windows speaker runtime and models,
checks their architecture and imported libraries, and records final hashes in
`resources/sidecars/win32-x64/runtime-manifest.json`.

Quality checks:

```bash
npm run lint
npm run typecheck
npm test
npm run test:runtime
npm run package
npm run verify:package:mac
npm run make:windows:zip
npm run verify:package:windows
```

The runtime integration test selects the current supported host and sends the
bundled AAC-in-MP4 fixture through the real FFmpeg → whisper.cpp → sherpa-onnx
→ atomic repository pipeline. It checks recognized speech, timing, persistence,
and speaker IDs. `test:runtime:mac` and `test:runtime:windows` are explicit
aliases. The integration is separate from the fast unit suite because it loads
the 465 MB model. The package verifiers inspect the unpacked application that
Forge actually produced: they reject foreign native runtimes, check required
models and licenses, verify immutable runtime hashes, and confirm that the ASAR
contains the current package version.

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
│   ├── export/                      DOCX, subtitle, JSON, and copy formatting
│   └── transcription/               job orchestration, text, speaker alignment
└── renderer/                        React shell, progress, list, detail

scripts/
├── speaker-diarization-child.cjs    isolated native speaker-process entry
└── verify-packaged-app.mjs          final package resource/hash checks

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
  → crash-isolated local speaker segmentation, clustering, bounded word alignment,
    and conservative timing-gap recovery
  → imported-media-only atomic private playback WAV retention
  → atomic schema-v4 transcript save with validated word timing and local tags
  → Transcript Library/detail state update
```

Only the main process sees filesystem paths or launches native code. Child
processes are invoked directly with `shell: false`; loader-injection and Node
runtime environment variables are removed. The renderer has
`contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`. Its
preload exposes only state, import, live-recording chunks, retry/cancel,
recording and transcript delete/export, fixed local copy targets, validated segment correction, speaker
rename, transcript metadata updates, local library search, record lookup, and
state-change methods. Playback uses a
separate `sotto-media` transport that accepts only a
validated transcript UUID and streams byte ranges from an app-owned file; raw
filesystem paths never reach the renderer. IPC requests must come from the current window's main frame, IDs are
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

The distribution path now requires an owned Apple Developer ID identity,
hardened runtime signing for the app and sidecars, and a named notarization
Keychain profile. `npm run make:mac:release` fails closed when that release
configuration is incomplete; the ordinary local packaging commands remain
ad-hoc for development. This machine does not currently have a valid Developer
ID identity installed, so a signed/notarized artifact and real permission-
preserving upgrade have not yet been qualified. The DMG is the primary macOS
delivery format; the ZIP remains available for alternate and update workflows.
Intel (`darwin-x64`) has no built or qualified runtime. Packaging now rejects
that target, Windows arm64, and Linux instead of producing an unusable app with
the wrong native resources. Each supported package also prunes the other
platform's native payload before signing and archive creation.

### Windows

The secure IPC, storage, packaged-runtime path, Windows icon, and speaker-runtime
contracts are implemented. Build the pinned x64 runtime and portable package
with:

```bash
npm run setup:runtime:windows
npm run make:windows:zip
```

The ZIP is written to `out/make/zip/win32/x64/`. Extract the whole archive on a
Windows x64 machine and run `Sotto.exe`; it is not an installer.

The cross-built executables, model, complete native speaker DLL closure,
licenses, packaged resource layout, and ZIP integrity are checked from macOS.
An earlier 0.1.2 package was also exercised on a real Windows 11 x64 machine:
the app launched and a live recording completed normalization, Whisper
transcription, and speaker labeling. That test exposed
a scalar Whisper build that took about 96 seconds for roughly six seconds of
audio. Version 0.1.3 rebuilds Whisper with an explicit AVX2/FMA/F16C baseline,
uses up to eight logical CPU threads, and shows the initial model phase as
indeterminate instead of holding at a misleading 20%. The optimized 0.1.3
binary still needs a native Windows timing retest, the native integration
fixture, and clean-machine qualification before public release.

The Windows x64 runtime requires SSE4.2, AVX, AVX2, BMI2, F16C, and FMA CPU
features. Its runtime manifest records that baseline and hashes the speaker
addon plus all four required DLLs. The portable ZIP and executable are not
Authenticode-signed, so they are internal test artifacts.

Squirrel.Windows is configured for an installer build, but Electron Forge only
supports that maker on Windows or Linux with Wine and Mono. Run
`npm run make:windows` from a qualified Windows x64 release host. A public
installer also needs Authenticode code signing and an install/upgrade test.

## Bounded next work

1. Retest the optimized Windows x64 package on native Windows, including the
   integration fixture, live desktop/microphone timing, code signing, and a
   clean-machine installer/upgrade test.
2. Add macOS Intel only if there is a real deployment need.
3. Add an explicit multilingual model choice if non-English meetings are in
   scope.
4. Evaluate speaker-label quality on representative multi-person Teams meetings
   and rebuild the native speaker runtime for older macOS versions if needed.
5. Add cancellation and a pre-send transcript preview to the Local AI summary
   action.

Cloud sync, accounts, an updater, and internet-hosted summarization remain
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
