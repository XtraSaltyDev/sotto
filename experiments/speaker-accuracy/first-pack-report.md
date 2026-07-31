# First speaker-accuracy experiment pack

Date: 2026-07-30

Production behavior and defaults were not changed. All media, Whisper timing, annotations, raw diarization output, and generated JSON reports remained local. This checked-in report contains only aggregate, anonymous measurements.

## Confirmed pipeline and evaluation gap

Sotto currently runs local media normalization, Whisper full JSON/token timing, offline sherpa-onnx diarization, the 12-label reliability filter, conservative word alignment/recovery, and one atomic transcript save. The existing `meeting-sample.mp4` fixture is an 11.27-second single-speaker runtime sample. It can catch false splits and runtime failures, but it cannot measure multi-speaker attribution. Existing alignment tests primarily use constructed timings and cluster assignments.

Before this pack, there was no repeatable local path that preserved normalization/Whisper work, captured clusters before the reliability filter, scored anonymous labels by permutation, or compared speaker settings with CPU, memory, time, and artifact measurements.

## Non-sensitive fixture evidence

The full 13-configuration one-factor pack reused its normalized WAV and Whisper full JSON after the first baseline. Production baseline and every threshold, shift, duration, and fixed-one-speaker configuration produced:

- one raw cluster and one supported label;
- 22/22 annotated lexical words attributed correctly;
- zero wrong-speaker and zero `Unclear` words;
- RTF from 0.031 to 0.033 (speaker wall time divided by recording duration);
- peak resident memory from 410 to 414 MiB;
- two configured CPU threads and roughly 191% to 197% observed CPU;
- zero model or runtime artifact-size change.

Result: all configurations tied. There is no measurable win or regression on this single-speaker fixture, and it supplies no evidence about real speaker changes, merging, fragmentation across voices, or boundary accuracy.

## Read-only retained-recording proxy evidence

One anonymous retained candidate was inspected read-only. It is 2,108.20 seconds long. The harness created its own ignored normalized WAV and Whisper timing cache; it did not change the saved recording or transcript. Ground truth is not yet annotated, so the following are fragmentation, coverage, and resource proxies rather than accuracy scores.

| Configuration | Raw clusters | Supported labels | Labeled words | `Unclear` words | Label coverage | Wall time | RTF | Peak memory |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Production baseline (`0.75`, `0.2/0.5`, Auto, zero shift) | 105 | 12 | 3,257 | 1,248 | 72.30% | 195.5 s | 0.093 | 6.48 GiB |
| Threshold `0.60` | 168 | 12 | 2,474 | 2,031 | 54.92% | 189.0 s | 0.090 | 6.31 GiB |
| Threshold `0.90` | 61 | 12 | 3,779 | 726 | 83.88% | 190.8 s | 0.090 | 5.84 GiB |
| Shift `-500 ms` | 105 | 12 | 3,227 | 1,278 | 71.63% | cached baseline | cached | cached |
| Shift `+250 ms` | 105 | 12 | 3,232 | 1,273 | 71.74% | cached baseline | cached | cached |
| Duration `0.10/0.30` | 105 | 12 | 3,263 | 1,242 | 72.43% | 217.4 s | 0.103 | 5.24 GiB |
| Duration `0.30/0.70` | 99 | 12 | 3,262 | 1,243 | 72.41% | 203.7 s | 0.097 | 6.59 GiB |

The first private preprocessing pass took 2.4 seconds for normalization and 250.8 seconds for Whisper. Later sweeps reused both files. Time-shift evaluations also reused cached raw baseline diarization because a time shift changes alignment input, not native clustering.

The current-host speaker models plus checked-in speaker runtimes occupy 124.2 MiB. Every experiment configuration uses the same artifacts, so the per-configuration artifact delta is zero bytes.

## Wins, regressions, and inconclusive results

Benchmark evidence:

- No configuration beat production on the non-sensitive single-speaker benchmark; all tied exactly.
- Threshold `0.60` is a measurable proxy regression on the retained candidate: 60% more raw clusters than baseline and 17.38 percentage points less label coverage.
- Both tested time shifts are measurable proxy regressions in label coverage (about 0.6 percentage points) and do not change fragmentation.
- Both duration variants are effectively flat on coverage. The lower variant is about 11% slower; the higher variant reduces six raw clusters but is about 4% slower and uses more peak memory than baseline.

Hypotheses, not accuracy evidence:

- Threshold `0.90` is the only strong proxy candidate: 42% fewer raw clusters, 11.58 percentage points more label coverage, slightly lower wall time, and lower measured peak memory.
- The same stronger merging that removes fragments can silently join different real speakers. Without anonymous reference speakers, correct/wrong-speaker rates, merging, fragmentation by true voice, word-timed DER, and boundary error are unavailable. Therefore `0.90` is still inconclusive for accuracy.

## Annotation still required

The retained candidate's local template is:

```text
.sotto-speaker-eval/runs/retained-2161-proxy/annotation-template.json
```

It contains word indexes and timing only, not transcript text. To unlock accuracy scoring, the user must:

1. Replace the placeholder speaker list with anonymous labels such as `Speaker A`, `Speaker B`, and `Speaker C`.
2. Mark reliable speaker time ranges and/or individual word indexes. Word assignments override broad ranges.
3. Leave uncertain and overlapping intervals unannotated rather than guessing.
4. Remove the template-only `wordTimingReference` and `instructions` fields, then set the local config's `annotationPath` to that file.
5. Rerun baseline, threshold `0.90`, and fixed Expected speakers matching the annotated speaker count at least twice; then expand to the full pack if the candidate remains better.

## Recommendation

Leave production unchanged. Threshold `0.90` merits the next ground-truth comparison, but the current evidence cannot show whether its extra coverage is correct attribution or harmful merging. A production change should require repeated multi-speaker wins in weighted loss (wrong labels count twice as much as `Unclear`), word-timed diarization error, fragmentation/merging, and boundary timing while remaining within current CPU, memory, wall-time, and artifact-size guardrails.
