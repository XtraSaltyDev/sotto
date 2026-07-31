# Local speaker-accuracy experiments

This experiment-only harness measures Sotto's existing offline speaker pipeline without changing the app UI, production defaults, or saved transcripts. It never uses a network service. Keep personal media, Whisper JSON, manual annotations, and generated reports under `.sotto-speaker-eval/` or another local ignored directory.

`test/fixtures/meeting-sample.mp4` is an 11-second, single-speaker runtime fixture. Its anonymous annotation is useful for a safe runtime smoke and for catching false speaker splits, but it is **not** a multi-speaker accuracy benchmark. The existing alignment unit tests also use constructed word timing and cluster data. Neither source can establish real meeting accuracy on its own.

## Run the first pack

```sh
node scripts/run-speaker-accuracy.cjs \
  --config test/fixtures/speaker-accuracy/meeting-sample.config.json
```

Run one configuration while developing:

```sh
node scripts/run-speaker-accuracy.cjs \
  --config test/fixtures/speaker-accuracy/meeting-sample.config.json \
  --configuration baseline-production
```

Generated cache files and reports go to `.sotto-speaker-eval/`. The normalized WAV and full Whisper JSON are named from content/model fingerprints and are reused on later sweeps. The harness never changes or removes a Sotto recording or saved transcript.

## Local input file

Paths are resolved relative to the input JSON. Supply exactly one of `mediaPath` or `normalizedWavPath`:

```json
{
  "schemaVersion": 1,
  "name": "anonymous-meeting-01",
  "mediaPath": "/absolute/local/path/meeting.webm",
  "whisperJsonPath": "/optional/local/path/reusable-whisper-full.json",
  "annotationPath": "/optional/local/path/anonymous-annotation.json",
  "transcriptReferencePath": "/optional/local/path/private-reference.json",
  "outputDirectory": "/optional/local/private/output"
}
```

- `mediaPath`: local media that the harness normalizes to 16 kHz mono WAV once.
- `normalizedWavPath`: an existing normalized WAV, used read-only.
- `whisperJsonPath`: optional reusable full JSON produced by `whisper-cli --output-json-full`; when absent, the harness creates and caches it locally.
- `annotationPath`: optional anonymous ground truth. Without it, the report contains proxy diagnostics and the harness writes an `annotation-template.json` with word indexes and timing only, never transcript text.
- `transcriptReferencePath`: optional local `{"schemaVersion":1,"text":"..."}` reference transcript. The harness normalizes case and punctuation, then reports aggregate word substitutions, deletions, insertions, word error rate, and word accuracy. It never writes either transcript text into its report; keep private references ignored.

When no transcript reference is supplied, the output directory contains `transcript-reference-template.json`. Fill its `text` from independent listening or another checked source, remove `instructions`, and then point `transcriptReferencePath` at the completed local file. Never copy Whisper's output into the reference: that would make the word-error score circular.
- `configurations`: optional explicit configuration array. When omitted, the first pack runs the production baseline and one-factor sweeps for clustering threshold, time shift, nearby on/off duration settings, and a fixed expected speaker count when annotation declares the count.

An explicit configuration can also set experiment-only `recoveryMode`. Existing files default to `production`. The available follow-up modes are `filtered-bridge-one-word`, `filtered-bridge-two-words`, `filtered-bridge-three-words`, the `embedding-consolidation-*` frontier, and the `novel-speaker-*` frontier. Each frontier has `strict`, `balanced`, and `exploratory` variants; `novel-speaker-balanced-segment-guard` adds an internal-consistency safety check to the balanced policy. `novel-speaker-balanced-segment-reassignment` is a narrower local follow-up: only an internally inconsistent supported cluster is considered, only a sampled segment with a strong other-cluster match can be reassigned, and every unmeasured or weak segment from that cluster is removed from alignment input so it stays `Unclear`. These values are accepted only by the local harness; they are not production settings or UI choices.

The filtered bridges operate after unchanged production alignment. They can label only directly timed words from clusters rejected by the reliability filter, enclosed by strong matching speakers inside one Whisper segment. Missing timing, timing gaps, overlapping clusters, one-sided evidence, and conflicting neighbors remain `Unclear`.

Embedding consolidation uses the speaker-embedding model already shipped with Sotto. A crash-isolated child calculates per-cluster voice signatures, converts them to cosine-similarity scores, and discards the signatures. Only aggregate cluster-to-cluster scores are cached under `.sotto-speaker-eval/`; no reusable voice signature is written to disk or included in reports. Strict, balanced, and exploratory thresholds test how much reliable-cluster consolidation and filtered-cluster remapping is possible before short-speaker accuracy regresses.

Novel-speaker preservation starts with exploratory embedding consolidation, then spends any freed slots under the existing 12-label ceiling on filtered clusters whose voice is sufficiently unlike every retained reliable cluster. Candidates must have direct word timing, enough word and audio support for the selected policy, and no competing overlap. Candidate selection is deterministic: stronger word support wins first, then greater voice dissimilarity, then the raw cluster number. Any cluster outside the final allowlist is returned to `Unclear`; overlap and ambiguous timing are never promoted.

The segment guard measures up to the six longest raw speech segments in each supported cluster, using at most four seconds from each segment. It caches only segment counts and the minimum, median, and maximum pairwise similarities; the voice vectors are discarded inside the isolated child process. A supported cluster with at least two usable segment samples is treated as internally inconsistent when its median is below `0.40`. The guarded policy refuses reliable-cluster merges and filtered-cluster remaps involving that cluster. Missing segment evidence does not manufacture a conflict, and the guard never changes production behavior.

`segmentAnchorOptions` is an optional experiment-only object for controlled
gate sweeps of the segment-anchor reassignment mode. Omitted fields use the
conservative defaults: internal-median similarity `0.40`, other-cluster
similarity `0.50`, margin `0.20`, and sampled-segment duration `500 ms`. The
object is ignored unless that recovery mode is selected, appears only in local
experiment configuration/report JSON, and is never read by Sotto's production
pipeline.

## Anonymous annotation format

Use labels such as `Speaker A`, `Speaker B`, and `Speaker C`. Labels are local to one recording and must not contain names or other identifying details.

```json
{
  "schemaVersion": 1,
  "durationMs": 60000,
  "speakers": ["Speaker A", "Speaker B"],
  "ranges": [
    { "startMs": 0, "endMs": 12500, "speaker": "Speaker A" },
    { "startMs": 12500, "endMs": 21400, "speaker": "Speaker B" }
  ],
  "words": [
    { "wordIndex": 37, "speaker": "Speaker A" }
  ]
}
```

Ranges must be ordered, inside `durationMs`, and non-overlapping. A word assignment overrides the range for that word. Unannotated timing is excluded from accuracy scoring. This conservative format does not claim to score simultaneous overlapping speakers.

## Metrics and comparison rules

System speaker numbers are anonymous, so the scorer finds the one-to-one label permutation that maximizes correctly attributed annotated word duration. It then reports:

- correct, wrong-speaker, and `Unclear` word counts and word-timed duration;
- label coverage and `Unclear` coverage;
- signed and absolute speaker-count error;
- fragmentation (one reference speaker spread across extra system labels);
- merging (one system label covering extra reference speakers);
- speaker-change boundary count and timing error when the annotation supports it;
  a boundary is a match only when it falls within the fixed one-second tolerance.
  More distant system changes are reported as missed reference boundaries and
  extra system boundaries, rather than being presented as late matches. The
  report includes boundary precision, recall, and F1 alongside the timing
  error of matched boundaries;
- word-timed diarization error: `(wrong duration + Unclear duration) / annotated word duration`, a clearly bounded DER-like measure that does not score overlap;
- weighted loss, where a wrong label costs twice as much as `Unclear`;
- per-speaker correct/wrong/`Unclear` rates and balanced weighted loss, which gives each annotated speaker equal weight so short interjections cannot be hidden by a dominant speaker;
- raw clusters and per-cluster segment duration/word support before Sotto's reliability filter;
- experiment-only recovery counts, remapped duration/word support, recovery wall time, CPU time, and peak memory;
- supported cluster count, labeled/Unclear coverage, wall time, real-time factor (wall time divided by audio duration), CPU time/observed CPU percentage, peak resident memory, context switches, output size, and current model/runtime bytes.

The first pack changes one factor at a time. Its baseline exactly matches current production speaker settings: threshold `0.75`, `minDurationOn=0.2`, `minDurationOff=0.5`, Auto speakers, zero time shift, and the current alignment/recovery code. Experiment parameters are passed only to the experiment child process.

A single run can expose regressions and rank candidates, but it is not enough to change production. A production recommendation requires repeated multi-speaker ground-truth wins across more than one recording while staying inside the current CPU, memory, wall-time, and artifact-size guardrails.

Comparison labels require both recording-wide weighted loss and equal-per-speaker balanced loss to improve. If one improves while the other worsens, the result is reported as inconclusive rather than allowing a dominant speaker to hide a minority-speaker regression.
