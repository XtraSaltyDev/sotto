# Filtered-fragment recovery follow-up

Date: 2026-07-30

This follow-up is experiment-only. Production clustering threshold `0.75`, the top-12 reliability filter, alignment/recovery behavior, saved transcripts, and UI defaults were not changed.

## Question

Can words stranded by raw cluster fragmentation be recovered without converting short-speaker speech from safely `Unclear` into the wrong speaker?

The experiment reused the cached normalized WAV, Whisper timing, production-threshold raw diarization, and the anonymous 36-second annotation inside the retained 35-minute candidate. Diarization and Whisper were not rerun. Reports contain aggregate metrics only.

## Temporal filtered-fragment bridges

Three policies extended the existing same-speaker bridge to at most one, two, or three directly timed words. Every candidate still required strong matching speaker evidence on both sides, short gaps, one Whisper source segment, no competing raw cluster, and no overlap or missing timing.

Across the full meeting, 11 filtered runs were eligible for inspection. None passed all safety gates:

| Policy | Recovered words | Main rejection evidence | Scored result |
| --- | ---: | --- | --- |
| One word | 0 | All 11 exceeded the word, duration, or text bound | Exact tie |
| Two words | 0 | 3 bounds, 7 neighbor-evidence failures, 1 source boundary | Exact tie |
| Three words | 0 | 3 bounds, 7 neighbor-evidence failures, 1 source boundary | Exact tie |

This is useful negative evidence. A wider temporal fill would have to weaken conflict or source-boundary protection and is therefore not a safe next production candidate.

## Local embedding consolidation

The installed 3D-Speaker model can calculate a 512-value voice signature for a cluster. A crash-isolated experiment child compared those signatures with cosine similarity, retained only cluster-to-cluster scores, and discarded the signatures. No voice signature, transcript text, or audio was written to the report or repository.

The policies first merge highly similar reliable clusters into the strongest cluster, then map a filtered cluster only when its nearest reliable cluster clears both an absolute similarity threshold and a nearest-versus-second-nearest margin.

| Policy | Reliable clusters merged | Filtered clusters remapped | Full-meeting changed words | Correct words | Wrong words | `Unclear` words | Overall weighted loss | Equal-speaker loss | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Production | 0 | 0 | 0 | 70.87% | 0.97% | 28.16% | 30.10% | 65.75% | Baseline |
| Strict | 2 | 3 | 373 | 70.87% | 0.97% | 28.16% | 30.10% | 65.75% | Tie in scored window |
| Balanced | 5 | 10 | 926 | 70.87% | 0.97% | 28.16% | 30.10% | 65.75% | Tie in scored window |
| Exploratory | 8 | 13 | 1,464 | 89.32% | 3.88% | 6.80% | 14.56% | 70.54% | Inconclusive tradeoff |

The exploratory result recovers nearly all annotated Speaker A words: that speaker improves from 78.49% to 98.92% correct. It does not recover Speaker B. Speaker B remains 0% correct, while wrong-speaker words rise from 10% to 40% and wrong-speaker duration rises from 6.90% to 54.74%. The duration-weighted equal-speaker loss worsens from 61.67% to 77.52%. No policy matches an annotated speaker boundary within the one-second tolerance.

Strict and balanced consolidation alter hundreds of words across the full recording but do not touch the currently annotated window. Those changes are proxy observations only and cannot be called accurate without more labels.

## Resource guardrails

- Raw production diarization was reused: original wall time `195.5 s`, RTF `0.093`, peak memory `6.48 GiB`, and two CPU threads.
- The similarity pass adds `6.91 s` wall time and `13.27 s` CPU time, uses two threads, and peaks at approximately `1.12 GiB`.
- Alignment/consolidation itself takes approximately `25–35 ms` per configuration.
- Similarity results are cached locally and reused by later threshold policies.
- Model and packaged-artifact impact is `0 bytes`; the experiment uses Sotto's existing embedding model and runtime.

## Conclusion

Leave production unchanged. Temporal bridging is too constrained to affect this recording safely. Embedding consolidation demonstrates that much of the dominant speaker's fragmentation is recoverable, but the exploratory policy harms the short speaker and therefore fails the equal-speaker guardrail.

The next hypothesis is **novel-speaker preservation**: after redundant reliable clusters are consolidated, use the freed speaker slots for filtered clusters that are sufficiently dissimilar from every reliable cluster instead of forcing them into a dominant-speaker group. This should be evaluated as a separate policy, with strict label-count and wrong-speaker safeguards, before any production proposal.

The aggregate local run is stored at:

```text
.sotto-speaker-eval/runs/retained-2161-filtered-recovery/report.md
```
