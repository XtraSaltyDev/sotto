# Runtime provenance and reproducibility

The source of truth for the Apple Silicon and Windows x64 runtimes is
`scripts/provision-darwin-arm64.sh` and `scripts/provision-win32-x64.sh`,
respectively. `sources.json` duplicates the common immutable inputs in
machine-readable form so packaging and release checks can compare the staged
runtime with the intended source set.

## whisper.cpp

- Repository: <https://github.com/ggml-org/whisper.cpp.git>
- Release: `v1.9.1`
- Commit: `f049fff95a089aa9969deb009cdd4892b3e74916`
- License: MIT

Provisioning fetches the tag into a dedicated ignored checkout and rejects it
unless the tag resolves to the pinned commit. It refuses a checkout with local
changes. The Release build targets only arm64 and macOS 12.0, disables shared
project libraries, BLAS, OpenMP, native-host tuning, tests, benchmarks, server,
Core ML, OpenVINO, SDL, and whisper.cpp's FFmpeg integration. Metal is enabled
and its shader library is embedded in the executable.

The script confirms the effective CMake cache contains:

```text
GGML_BLAS:BOOL=OFF
GGML_METAL:BOOL=ON
GGML_METAL_EMBED_LIBRARY:BOOL=ON
```

The Windows script builds the same pinned commit in a digest-pinned Debian
container with the MinGW-w64 x86-64 POSIX compiler. It disables Metal, BLAS,
OpenMP, runtime backend loading, native-host tuning, and all optional network or
service integrations. It explicitly targets an AVX2/FMA/F16C CPU baseline with
SSE4.2, AVX, AVX2, BMI2, F16C, and FMA enabled; the container build verifies the
effective CMake cache and compiler flags before staging the binary. Project
libraries and the MinGW C/C++ runtimes are linked statically.
`_WIN32_WINNT=0x0601` is used only while compiling whisper.cpp to avoid an
optional thread power-throttling API missing from the pinned MinGW headers; the
packaged Electron application itself retains its Windows 10 target.

## FFmpeg

- Archive: <https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz>
- Archive SHA-256:
  `464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c`
- License: LGPL 2.1-or-later

The archive is verified before extraction. The minimal decoder is configured
with the following reviewed option set:

```text
--disable-everything
--disable-autodetect
--disable-network
--disable-doc
--disable-debug
--disable-ffplay
--disable-ffprobe
--enable-ffmpeg
--enable-static
--disable-shared
--enable-small
--enable-pthreads
--enable-protocol=file,pipe
--enable-demuxer=aac,asf,avi,flac,matroska,mov,mp3,mpegts,ogg,wav
--enable-decoder=aac,aac_fixed,alac,flac,mp3,mp3float,opus,vorbis,wavpack,wmav1,wmav2,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_s32be,pcm_f32le,pcm_f32be,pcm_u8,pcm_s8
--enable-parser=aac,aac_latm,mpegaudio,opus,vorbis
--enable-encoder=pcm_s16le
--enable-muxer=wav
--enable-filter=anull,aformat,aresample
--extra-cflags=-mmacosx-version-min=12.0
--extra-ldflags=-mmacosx-version-min=12.0
```

This covers common local meeting and video inputs, including MP4/MOV/M4A,
Matroska/WebM, Microsoft ASF/WMV and AVI, MPEG-TS, MP3, Ogg, FLAC, AAC, and WAV,
when their audio track uses one of the explicitly enabled codecs. Unsupported
containers or codecs must fail closed with an actionable application error; the
runtime should not fetch codecs or submit media to a service.

Provisioning refuses the build unless FFmpeg's configuration summary says both
`License: LGPL version 2.1 or later` and `network support no`. It also checks the
built executable still reports `--disable-network`.

The Windows build uses the same bounded protocol, container, codec, parser,
encoder, muxer, and filter set. Platform-specific changes select MinGW x86-64,
Win32 threads, static executable linking, and a Windows 10 target. The
provisioner additionally rejects a `WS2_32.dll` import so the staged FFmpeg
cannot reach the Windows sockets library.

## Model

- Source:
  <https://huggingface.co/ggerganov/whisper.cpp/resolve/c521a4b02f422512d734391fdf08bb08c0862f68/ggml-small.en.bin?download=true>
- Hugging Face revision: `c521a4b02f422512d734391fdf08bb08c0862f68`
- SHA-256:
  `c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d`
- License: MIT (OpenAI Whisper)

The URL is not treated as an identity: the expected SHA-256 digest is. A changed
or truncated response is rejected before it reaches the staged model path.

## Output verification

For macOS, both executables must be single-architecture arm64 Mach-O files with
a macOS 12.0 minimum version. Provisioning rejects Homebrew paths, `/usr/local`
paths, loader-relative dylibs, and dynamically linked FFmpeg/whisper/GGML
libraries. It writes final SHA-256 digests and source/model identities to
`darwin-arm64/runtime-manifest.json`.

For Windows, both executables, the sherpa native addon, and its four required
native DLLs must be PE32+ x86-64 files. Provisioning rejects dynamically linked
project libraries and MinGW runtime DLLs, verifies the speaker-library
dependency closure and required license bundle, and writes native-binary hashes
alongside the executable digests and source/model identities in
`win32-x64/runtime-manifest.json`. These are structural cross-build checks; a
native Windows integration run is still required before release qualification.

For release reproducibility, retain the provisioning log, generated runtime
manifest, compiler/CMake versions, container image identity or macOS SDK/Xcode
version, and build-host version with the packaging evidence. Source pins make
the inputs reproducible; compiler and SDK versions can still change the exact
executable bytes.
