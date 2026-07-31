# Second retained-recording validation

Date: 2026-07-30

This test is experiment-only. Production diarization, saved recordings/transcripts, UI behavior, and defaults were not changed.

## Candidate and evidence boundary

The retained-audio inventory contains one independent candidate long enough to be useful after the first 35-minute meeting: an approximately 80-second recording. Four other retained recordings are only about 2–11 seconds long.

The candidate's saved transcript has segment timing but no word timing or speaker assignments, so it cannot support speaker-accuracy scoring. The harness normalized the media and generated Whisper full timing locally once. Both are cached under the ignored `.sotto-speaker-eval/` directory for reuse. No transcript text, audio, or voice signature is present in this report.

The listener anonymously labeled the final 14-second disagreement window with alternating Speaker A/B ranges. One supplied range was `0:07-0:07`; the primary score treats it as the likely intended one-second bucket `0:07-0:08`, and a sensitivity score omits it. Both interpretations reach the same conclusion.

## Baseline versus balanced recovery

Wrong labels count twice as much as `Unclear`. Equal-speaker loss gives the short Speaker B ranges the same weight as Speaker A.

| Configuration | Correct words | Wrong words | `Unclear` words | Overall word loss | Equal-speaker word loss | Correct duration | Wrong duration | Equal-speaker duration loss | Weakest speaker correct | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Production baseline | 66.67% | 33.33% | 0.00% | 66.67% | 39.39% | 71.84% | 28.16% | 32.51% | 60.61% | Baseline |
| Novel-speaker balanced | 84.62% | 15.38% | 0.00% | 30.77% | 100.00% | 86.63% | 13.37% | 100.00% | 0.00% | Inconclusive tradeoff |

Balanced improves the recording-weighted totals by assigning the disputed raw cluster to dominant Speaker A. It simultaneously changes Speaker B from 6 of 6 correctly labeled words under production to 0 of 6; all `560 ms` of Speaker B's annotated word duration becomes wrong-speaker attribution. Production correctly matches three of four annotated boundaries, while balanced matches none.

The system label count moves from three to the correct total of two, but accuracy gets worse for the short speaker. This is direct evidence that a correct speaker count does not imply correct assignments.

When the zero-length range is omitted, production scores 62.86% correct words and balanced scores 82.86%, but Speaker B still changes from 100% correct to 0%. The equal-speaker loss still worsens to 100%, so the interpretation of that one range does not affect the conclusion.

## One-factor sweep

| Factor | Raw-cluster effect | Scored effect |
| --- | --- | --- |
| Threshold `0.60–0.90` | Changes raw clusters from 5 down to 2 | Exact tie on annotated scored metrics |
| Time shifts `-500`, `-250`, `+250 ms` | Reuses production clusters | No improvement; `+250 ms` adds one `Unclear` word |
| Nearby `minDurationOn`/`minDurationOff` values | Raw count remains 3 | Exact tie on annotated scored metrics |
| Fixed expected speakers `2` | Reduces raw/output labels to 2 | Exact tie on annotated scored metrics |

No sweep configuration improves the annotated word assignments. Lower thresholds fragment more; higher thresholds and fixed-two mode reach the expected label count but do not separate the alternating voices correctly.

## What the failure shows

All three production raw clusters already pass the reliability filter. The cluster changed by balanced recovery contains three non-contiguous speech segments totaling `4.81 s` and 21 word assignments. The annotation indicates that this single raw cluster includes both Speaker A and Speaker B speech. A single cluster-level voice signature therefore cannot safely decide which speaker owns all three segments.

The segment-consistency follow-up detects this cluster at a `0.189` internal median and blocks its cluster-wide merge. The guarded policy returns to the production score and preserves Speaker B instead of erasing it. See `segment-consistency-guard-report.md`.

## Resource observations

- Normalization: `0.17 s` wall time.
- Whisper full timing: `11.32 s` wall time, run once and cached.
- Production diarization: `8.06 s` wall time, RTF `0.101`, approximately `1.58 GiB` peak memory, two CPU threads.
- Similarity pass: `0.38 s` wall time, `0.74 s` CPU time, approximately `0.48 GiB` peak memory, two CPU threads.
- Sweep diarization configurations: approximately `7.05–8.49 s` each, RTF `0.089–0.107`, and approximately `1.58 GiB` peak memory.
- Alignment/recovery: approximately `1–2 ms` per configuration.
- Model and packaged-artifact impact: `0 bytes`.

## Conclusion

Balanced novel-speaker preservation is not repeatable across the two annotated retained recordings. It was a measurable win in the first window, but this independent window shows a complete short-speaker regression. Thresholds, timing shifts, duration settings, and fixed speaker count do not resolve it.

Leave production unchanged. The tested guard prevents this regression but does not itself improve the mixed cluster's underlying assignments. The subsequent local segment-anchor experiment records a targeted attribution win with a boundary-timing caveat in `segment-anchor-reassignment-report.md`; it is not a production recommendation.
