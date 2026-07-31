# Segment-anchor reassignment follow-up

Date: 2026-07-30

This is an experiment-only result. Production diarization, alignment, UI behavior, defaults, saved recordings, and saved transcripts were not changed.

## Question

After the segment-consistency guard detects a supported raw cluster that mixes voices, can local segment-level evidence repair its assignments without repeating the earlier short-speaker regression?

## Method and safeguards

The isolated local similarity child already samples up to six of the longest speech segments for each supported raw cluster, capped at four seconds each. This follow-up compares each sampled segment only with aggregate embeddings for the *other* supported clusters. It returns timing plus similarity scores, not voice vectors or transcript text; vectors are discarded before the child exits.

The reassignment trial begins with the existing `0.40` internal-median guard. Only a segment from a flagged cluster is eligible. It must be a sample of at least `500 ms`, have similarity at least `0.50` to another stable supported cluster, and exceed its next-best match by at least `0.20`. Every other segment from the flagged cluster—including unmeasured, too-short, weak, or conflicting segments—is removed from alignment input and therefore remains `Unclear`.

These are fixed local experiment gates, not app settings. They do not run in Sotto's production pipeline.

## Evidence

On the independently annotated short recording, the mixed cluster supplied three usable samples. Their nearest supported-group choices separated into two samples for one anonymous speaker and one for the other, with similarity range `0.489–0.600` and margin range `0.218–0.411`. The `500 ms` floor accepts the two longer samples and leaves the `320 ms` sample `Unclear`.

### Independent annotated recording

Wrong labels count twice as much as `Unclear`; equal-speaker loss gives the short speaker equal weight.

| Configuration | Correct words | Wrong words | `Unclear` words | Overall word loss | Equal-speaker loss | Correct duration | Speaker-count error | Boundaries matched | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Production | 66.67% | 33.33% | 0.00% | 66.67% | 39.39% | 71.84% | 1 | 3 / 4 | Baseline |
| Balanced + guard | 66.67% | 33.33% | 0.00% | 66.67% | 39.39% | 71.84% | 1 | 3 / 4 | Tie |
| Guard + segment-anchor reassignment | **97.44%** | **0.00%** | 2.56% | **2.56%** | **8.33%** | **100.00%** | **0** | 2 / 4 | Win |

The reassignment changes two measured segments totaling `4.49 s`; no segment is demoted by the fixed gates. It eliminates wrong word and duration attribution in this annotated window, but it misses one additional reference boundary. Under the fixed one-second boundary tolerance, its two matched boundaries are exact and its other two reference boundaries remain missed. This is a speaker-attribution win, not a boundary-timing win.

The supplied zero-length-range sensitivity gives the same direction: production is 62.86% correct words with 37.14% wrong, while the reassignment is 97.14% correct, 0% wrong, and 2.86% `Unclear`. Its equal-speaker loss remains 8.33%. The sensitivity does not resolve the boundary limitation.

### Independent 35-minute annotated window

No supported cluster falls below the `0.40` internal-median guard on this separate meeting. The reassignment path therefore makes no segment-level change and exactly reproduces the guarded balanced result: 94.17% correct words, 3.88% wrong, 1.94% `Unclear`, 9.71% overall word loss, and 45.54% equal-speaker loss. This is a useful negative control: the new rule did not expand its scope simply because the mode was enabled.

## Resource and repeatability boundary

- The short recording's combined cluster and segment-similarity measurement took `0.905 s` wall time, `1.70 s` CPU time, two threads, and about `540 MiB` peak resident memory. The reassignment decision itself took less than `2 ms` after cache reuse.
- The 35-minute meeting's combined measurement took `9.15 s` wall time, `18.03 s` CPU time, two threads, and about `1.20 GiB` peak resident memory. The reassignment path adds no measured work when no cluster is flagged.
- Normalized WAV, Whisper timing, raw diarization, and similarity results were reused for repeat configurations. The existing local model/runtime was reused; model and packaged-artifact impact is `0 bytes`.

## Conclusion

This is a measurable local win for the independently annotated mixed cluster and does not change the other annotated meeting when its precondition is absent. It is still not a production recommendation: the rule has one targeted win, no independent second mixed-cluster win, and a clear boundary-timing regression in the winning window. Keep production unchanged.

The next useful evidence is a fresh, independently annotated multi-speaker case containing a guarded mixed cluster. It should run the same fixed gates and report attribution and boundary metrics before any production decision.
