# Runtime test fixture

`meeting-sample.mp4` is a small, locally generated H.264/AAC MP4 built from the
11-second JFK speech sample distributed in the pinned whisper.cpp source tree.
It exists only to exercise the same video-container and audio-extraction path
used for imported meeting recordings. No model output or personal media is
stored in the repository.

The file is a single-speaker runtime fixture, not a multi-speaker accuracy
benchmark. `speaker-accuracy/meeting-sample.annotation.json` supplies anonymous
single-speaker timing for a safe false-split smoke test. See
`experiments/speaker-accuracy/README.md` for the local multi-speaker annotation
and evaluation workflow.
