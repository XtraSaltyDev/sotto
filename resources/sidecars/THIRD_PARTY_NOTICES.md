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
source checkout to each target runtime's `licenses/whisper.cpp.LICENSE`.

## FFmpeg

- Project: FFmpeg
- Source: <https://ffmpeg.org/>
- Pinned source archive and checksum: see [sources.json](sources.json)
- Configured license: LGPL 2.1-or-later

The build does not enable GPL, nonfree, or version-3-only features. The script
requires FFmpeg's configuration summary to identify the result as LGPL 2.1 or
later. It stages the upstream `COPYING.LGPLv2.1` and `COPYING.LGPLv3` texts in
each target runtime's `licenses/` directory, together with FFmpeg's `LICENSE.md`
overview, for
redistribution with the executable.

FFmpeg is distributed without warranty under its applicable license. Recipients
must be able to obtain the corresponding source used for a distributed binary;
retain the source URL, archive checksum, build configuration, and release build
records documented in [PROVENANCE.md](PROVENANCE.md).

## OpenAI Whisper model

- Model: Whisper `large-v3-turbo`, converted to whisper.cpp GGML format
- Distribution: `ggerganov/whisper.cpp` on Hugging Face
- Pinned content checksum: see [sources.json](sources.json)
- Upstream project: <https://github.com/openai/whisper>
- License: MIT

The OpenAI Whisper MIT license is committed at
`licenses/openai-whisper-model.LICENSE` and copied into the target runtime's
license directory during provisioning.

## sherpa-onnx and speaker models

- Runtime: `sherpa-onnx-node` 1.13.4
- Source: <https://github.com/k2-fsa/sherpa-onnx>
- License: Apache-2.0
- Segmentation model: Pyannote Segmentation 3.0, MIT
- Embedding model: 3D-Speaker ERes2Net base, Apache-2.0

The exact model download URLs and SHA-256 hashes are recorded in `sources.json`.
The Windows npm package URLs and SHA-512 hashes are pinned in
`scripts/provision-win32-x64.sh`.
The Pyannote model's upstream MIT text is committed at
`licenses/pyannote-segmentation-3.0.LICENSE`. The native npm package and both
models are staged as local, offline runtime resources; no model service is
contacted while Sotto is running.

The complete Apache-2.0 text is staged as
`licenses/sherpa-onnx.Apache-2.0.LICENSE` and
`licenses/3D-Speaker.Apache-2.0.LICENSE`. The native package also contains ONNX
Runtime 1.27.0; its MIT license and upstream third-party notices are staged as
`licenses/onnxruntime.LICENSE` and
`licenses/onnxruntime.ThirdPartyNotices.txt`. The provisioner downloads these
files from their pinned upstream release tags and verifies their SHA-256 hashes
before they can enter a package.

## docx

- Project: `docx` 9.7.1
- Source: <https://github.com/dolanmiu/docx>
- License: MIT

Sotto uses this library only to create Word-compatible transcript exports.
