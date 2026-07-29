# Native runtime staging

Sotto keeps native executables outside the Electron ASAR and resolves them only
from the application resources directory. The renderer never receives a binary
path or permission to launch a process.

## Provision the Apple Silicon development runtime

On an Apple Silicon Mac with Xcode (including the Metal toolchain), CMake, Git,
and curl installed, run:

```bash
bash scripts/provision-darwin-arm64.sh
```

Set `SOTTO_BUILD_JOBS` to a positive integer to override the default parallelism:

```bash
SOTTO_BUILD_JOBS=4 bash scripts/provision-darwin-arm64.sh
```

To validate an already-staged runtime without network access, builds, downloads,
or filesystem changes, run:

```bash
bash scripts/provision-darwin-arm64.sh --verify-only
```

The script downloads only pinned HTTPS inputs, verifies the FFmpeg source and
model SHA-256 digests before use, verifies the whisper.cpp tag resolves to its
pinned commit, and builds locally. It is safe to rerun. An unexpected origin,
dirty cached source checkout, checksum mismatch, non-arm64 output, unexpected
dynamic dependency, or incompatible existing model causes it to stop instead of
silently replacing the questionable input.

It stages:

```text
resources/
├── models/
│   └── ggml-small.en.bin
└── sidecars/
    └── darwin-arm64/
        ├── ffmpeg
        ├── whisper-cli
        ├── runtime-manifest.json
        └── licenses/
```

The two executables and the model are deliberately ignored by Git. The runtime
manifest records the locally built executable hashes and the pinned source/model
identities. A release build should provision these files before packaging and
archive that generated manifest with the build evidence.

## Provision the Windows x64 runtime

On a Mac with Docker or Colima running, provision the Windows runtime in a
pinned Debian cross-build container:

```bash
bash scripts/provision-win32-x64.sh
```

To validate an already-staged runtime without network access, builds, downloads,
or filesystem changes, run:

```bash
bash scripts/provision-win32-x64.sh --verify-only
```

The script cross-builds PE32+ x64 `whisper-cli.exe` and `ffmpeg.exe`, rejects
unexpected project or MinGW DLL dependencies, rejects Windows networking imports
from FFmpeg, verifies the sherpa-onnx addon's four-DLL dependency closure, and
stages the pinned model, Windows speaker runtime, speaker models, complete
licenses/notices, and runtime manifest. These checks establish the
package structure; execution and audio behavior still need qualification on a
native Windows x64 machine.

The Windows Whisper runtime uses an explicit AVX2/FMA/F16C CPU baseline (with
SSE4.2, AVX, AVX2, BMI2, F16C, and FMA enabled). This avoids the scalar
cross-build that made short recordings dramatically slower than real time. The Windows x64
package therefore requires a processor with those instruction sets; supported
Windows 11-era Intel and AMD processors meet that baseline.

## Runtime characteristics

- `whisper-cli` is an arm64 Release build from whisper.cpp `v1.9.1`, with
  project libraries linked statically, Metal enabled and embedded,
  `GGML_BLAS=OFF`, and a macOS 12.0 deployment target.
- `ffmpeg` is an arm64, minimal, static-FFmpeg-library build of FFmpeg `8.1.2`
  under LGPL 2.1-or-later. Its runtime network protocols are disabled. It
  supports local files/pipes and the bounded set of containers/codecs documented
  in [PROVENANCE.md](PROVENANCE.md).
- `ggml-small.en.bin` is the English-only small Whisper model. It is larger and
  slower than `base.en`, but gives a more useful initial accuracy baseline for
  meetings and recorded video.
- macOS itself does not support fully static executables. “Static” here means
  the FFmpeg, whisper.cpp, and GGML project libraries are not external dylibs;
  Apple system libraries and frameworks remain dynamically linked.

## Other targets

`darwin-x64/` remains an unprovisioned target directory. It needs its own pinned
build procedure, checksums, runtime manifest, and native-host verification. The
`win32-x64/` runtime has a pinned cross-build procedure, but still needs native
Windows execution and clean-machine qualification. Do not copy executables
between target directories.

See [sources.json](sources.json) for machine-readable source pins,
[PROVENANCE.md](PROVENANCE.md) for the reproducibility and licensing boundary,
and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for redistribution notices.
