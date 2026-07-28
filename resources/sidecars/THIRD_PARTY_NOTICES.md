# Third-party runtime notices

Sotto's provisioned transcription runtime contains third-party software and
model data. This file is a notice summary, not a replacement for the complete
license texts staged beside the runtime.

## whisper.cpp

- Project: whisper.cpp
- Source: <https://github.com/ggml-org/whisper.cpp>
- Pinned release and commit: see [sources.json](sources.json)
- License: MIT

The provisioning script copies the exact `LICENSE` file from the verified pinned
source checkout to `darwin-arm64/licenses/whisper.cpp.LICENSE`.

## FFmpeg

- Project: FFmpeg
- Source: <https://ffmpeg.org/>
- Pinned source archive and checksum: see [sources.json](sources.json)
- Configured license: LGPL 2.1-or-later

The build does not enable GPL, nonfree, or version-3-only features. The script
requires FFmpeg's configuration summary to identify the result as LGPL 2.1 or
later. It stages the upstream `COPYING.LGPLv2.1` and `COPYING.LGPLv3` texts in
`darwin-arm64/licenses/`, together with FFmpeg's `LICENSE.md` overview, for
redistribution with the executable.

FFmpeg is distributed without warranty under its applicable license. Recipients
must be able to obtain the corresponding source used for a distributed binary;
retain the source URL, archive checksum, build configuration, and release build
records documented in [PROVENANCE.md](PROVENANCE.md).

## OpenAI Whisper model

- Model: Whisper `small.en`, converted to whisper.cpp GGML format
- Distribution: `ggerganov/whisper.cpp` on Hugging Face
- Pinned content checksum: see [sources.json](sources.json)
- Upstream project: <https://github.com/openai/whisper>
- License: MIT

The OpenAI Whisper MIT license is committed at
`licenses/openai-whisper-model.LICENSE` and copied into the target runtime's
license directory during provisioning.
