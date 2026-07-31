# Segment-consistency guard follow-up

Date: 2026-07-30

This follow-up is experiment-only. Production diarization, alignment, saved recordings/transcripts, UI behavior, and defaults were not changed.

## Question

Can a low-cost check detect when one raw cluster contains internally conflicting voices and prevent cluster-wide embedding consolidation from erasing a short speaker?

## Measurement

For each supported raw cluster, the local similarity child measures up to the six longest diarization segments, capped at four seconds per segment. It calculates pairwise segment similarities, retains only counts plus minimum/median/maximum scores, and discards all voice vectors before returning. Cached files contain no transcript text, audio, or reusable voice signature.

On the independently annotated 80-second recording:

| Raw cluster | Ready segments | Minimum similarity | Median similarity | Maximum similarity | Annotation evidence |
| ---: | ---: | ---: | ---: | ---: | --- |
| 0 | 6 | 0.447 | 0.593 | 0.662 | Consistent supported group |
| 2 | 5 | 0.379 | 0.503 | 0.624 | Consistent supported group |
| 6 | 3 | **0.151** | **0.189** | **0.352** | Contains both Speaker A and Speaker B ranges |

Across the 12 supported clusters in the first 35-minute meeting, median similarities range from `0.425` to `0.696`; none falls below `0.40`. The mixed cluster in the second recording is clearly separated at `0.189`.

Threshold sensitivity also has a useful stable band:

| Guard threshold | First meeting flagged | Second recording flagged |
| ---: | ---: | ---: |
| 0.20 | 0 | 1 |
| 0.30 | 0 | 1 |
| 0.35 | 0 | 1 |
| 0.40 | 0 | 1 |
| 0.425 | 1 | 1 |
| 0.45 | 2 | 1 |

The experiment uses a `0.40` median threshold. A cluster needs at least two usable segment samples to be evaluated. Explicit inconsistency blocks reliable-cluster merging and filtered-cluster remapping into that cluster; missing evidence alone does not create a conflict.

## Human-scored result

Wrong labels count twice as much as `Unclear`, and equal-speaker loss gives short speakers equal weight.

### First annotated meeting window

| Configuration | Correct words | Wrong words | `Unclear` words | Overall word loss | Equal-speaker loss | Weakest speaker correct | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Production | 70.87% | 0.97% | 28.16% | 30.10% | 65.75% | 0.00% | Baseline |
| Balanced, unguarded | 94.17% | 3.88% | 1.94% | 9.71% | 45.54% | 50.00% | Win |
| Balanced + segment guard | 94.17% | 3.88% | 1.94% | 9.71% | 45.54% | 50.00% | Same win |

All 12 supported clusters pass the guard, so it makes no change in this window. Existing caveats remain: Speaker B has `54.74%` wrong-speaker duration, no annotated boundary is matched, and nine labels are emitted for two annotated speakers.

### Independent annotated recording

| Configuration | Correct words | Wrong words | Overall word loss | Equal-speaker loss | Speaker B correct | Boundaries matched | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Production | 66.67% | 33.33% | 66.67% | 39.39% | 100.00% | 3 of 4 | Baseline |
| Balanced, unguarded | 84.62% | 15.38% | 30.77% | 100.00% | 0.00% | 0 of 4 | Inconclusive tradeoff |
| Balanced + segment guard | 66.67% | 33.33% | 66.67% | 39.39% | 100.00% | 3 of 4 | Exact tie |

The guard identifies one inconsistent supported cluster and blocks the one reliable-cluster merge. It therefore prevents the complete Speaker B regression and returns exactly to production assignments. Omitting the listener's zero-length range produces the same outcome.

## Resource guardrails

- On the 35-minute meeting, cluster plus segment similarity takes `9.17 s` wall time, `18.10 s` CPU time, two threads, and approximately `1.20 GiB` peak memory. Relative to cluster-only similarity, segment checks add about `2.26 s` wall time, `4.83 s` CPU time, and `101 MiB` peak memory.
- On the 80-second recording, the combined pass takes `0.94 s` wall time, `1.74 s` CPU time, two threads, and approximately `537 MiB` peak memory.
- Guard selection itself remains approximately `1–28 ms` per configuration after the cache is available.
- The existing model/runtime is reused; model and packaged-artifact impact is `0 bytes`.
- Repeat runs reuse normalized WAV, Whisper timing, diarization, and the expanded similarity cache.

## Limits

- The threshold is supported by only two annotated recordings.
- Only the six longest segments in each supported cluster are sampled; a short conflicting segment can be missed.
- Filtered clusters are not internally sampled, although remapping into a known inconsistent supported cluster is blocked.
- The guard prevents a harmful merge but does not split the mixed raw cluster or improve production's mistakes on the second recording.
- The first window still has serious short-speaker duration and boundary errors despite its aggregate win.

## Conclusion

The segment-consistency guard is a measurable safety improvement over unguarded balanced consolidation: it preserves the first result and prevents the independently observed short-speaker erasure. It is not a production recommendation because it has only one win and one tie, leaves major errors in both windows, and adds resource cost.

Leave production unchanged. The next bounded hypothesis is segment-level reassignment inside a flagged mixed cluster, with conflicting or weak segment evidence left `Unclear` rather than forcing the entire cluster to one speaker.

