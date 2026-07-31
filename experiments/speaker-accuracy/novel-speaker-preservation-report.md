# Novel-speaker preservation follow-up

Date: 2026-07-30

This follow-up is experiment-only. Production clustering threshold `0.75`, the top-12 reliability filter, alignment/recovery behavior, saved transcripts, and UI defaults were not changed.

## Question

After redundant reliable clusters are consolidated, can a freed label slot preserve a short second speaker without forcing uncertain speech into the dominant speaker?

The experiment reused the cached normalized WAV, Whisper timing, production-threshold raw diarization, cluster-similarity scores, and the anonymous 36-second annotation inside the retained 35-minute candidate. Whisper, diarization, and the similarity pass were not rerun. Reports contain aggregate metrics only.

## Policy

All three policies begin with exploratory embedding consolidation. They retain its canonical reliable clusters and use only the remaining capacity under the existing 12-label ceiling. A filtered raw cluster is eligible as a novel speaker only when it:

- is sufficiently dissimilar from every retained reliable cluster;
- has directly timed word and audio support above the policy's minimum;
- has no competing overlap on the promoted word;
- wins the deterministic ordering by word support, voice dissimilarity, and raw cluster number.

Clusters outside the final allowlist become `Unclear`. Missing timing, overlap, and conflicting evidence remain conservative.

| Policy | Maximum nearest similarity | Minimum word support | Minimum voice sample |
| --- | ---: | ---: | ---: |
| Strict | `< 0.35` | 1,000 ms | 1,000 ms |
| Balanced | `< 0.40` | 750 ms | 750 ms |
| Exploratory | `< 0.50` | 500 ms | 500 ms |

## Annotated result

Wrong labels count twice as much as `Unclear`. Equal-speaker loss gives Speaker A and the much shorter Speaker B equal weight.

| Policy | Correct words | Wrong words | `Unclear` words | Overall word loss | Equal-speaker word loss | Overall duration loss | Equal-speaker duration loss | Weakest speaker correct | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Production | 70.87% | 0.97% | 28.16% | 30.10% | 65.75% | 27.61% | 61.67% | 0.00% | Baseline |
| Strict | 89.32% | 3.88% | 6.80% | 14.56% | 70.54% | 19.36% | 77.52% | 0.00% | Inconclusive |
| Balanced | 94.17% | 3.88% | 1.94% | 9.71% | 45.54% | 14.68% | 58.56% | 50.00% | Measurable win |
| Exploratory | 89.32% | 3.88% | 6.80% | 14.56% | 70.54% | 19.36% | 77.52% | 0.00% | Inconclusive |

Balanced is the first tested policy to improve both the recording-weighted and equal-speaker losses. Word-timed diarization error falls from `26.76%` to `7.93%`. It labels 92 of 93 annotated Speaker A words correctly and 5 of 10 Speaker B words correctly. Speaker B had no correctly labeled words under production.

The gain is not clean enough for production. Four of Speaker B's ten words are assigned to the wrong speaker, representing `54.74%` of its annotated timed duration; one word remains `Unclear`. None of the five annotated speaker-change boundaries is matched within the one-second tolerance.

## Label and fragmentation diagnostics

| Policy | Novel clusters promoted | Promoted words across meeting | Clusters demoted | Demoted words | Final allowlist | Labels actually emitted | Count error in scored assignment | Fragmentation | Merging |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Strict | 4 | 21 | 7 | 231 | 8 | 7 | +5 | 0 | 1 |
| Balanced | 8 | 31 | 7 | 231 | 12 | 9 | +7 | 1 | 1 |
| Exploratory | 8 | 61 | 7 | 231 | 12 | 10 | +8 | 0 | 1 |

The annotation has two reference speakers. Balanced emits nine labels across the full meeting and shows one fragmentation and one merging error in the scored assignment. The policy therefore improves the annotated words while still preserving too many raw identities.

## Resource guardrails

- Raw production diarization was reused: original wall time `195.5 s`, RTF `0.093`, peak memory `6.48 GiB`, and two CPU threads.
- The cached similarity pass originally added `6.91 s` wall time and `13.27 s` CPU time, used two threads, and peaked at approximately `1.12 GiB`.
- Novel-speaker selection and alignment take approximately `29 ms` per configuration after the cache is available.
- Model and packaged-artifact impact is `0 bytes`; the experiment uses Sotto's existing embedding model and runtime.
- Cached similarity files contain aggregate cluster-to-cluster scores, not reusable voice signatures, transcript text, or audio.

## Conclusion

Balanced novel-speaker preservation is a measurable win on this one annotated window, but production remains unchanged. The result needs to repeat on another independently annotated multi-speaker window or recording, and the extra-label count plus short-speaker wrong-duration rate need to fall, before this can become a production candidate.

The independent follow-up does **not** repeat the win. In the second annotated recording, balanced recovery improves dominant-speaker totals but changes the short speaker from 100% correct to 0% correct. See `second-validation-report.md`. The later segment-consistency guard prevents that merge and returns to a production tie, but it still does not establish a repeatable production win. See `segment-consistency-guard-report.md`.

The aggregate private local run is stored at:

```text
.sotto-speaker-eval/runs/retained-2161-filtered-recovery/report.md
```
