# Threshold frontier follow-up

Date: 2026-07-30

This follow-up remains experiment-only. Production threshold `0.75`, speaker-duration settings, alignment/recovery behavior, and UI defaults were not changed.

## Full retained-recording proxy frontier

The anonymous retained candidate is 2,108.20 seconds long. Normalized audio, Whisper timing, and previously computed threshold results were reused from the local ignored cache. No saved Sotto recording or transcript was modified.

| Threshold | Raw clusters | Supported labels | Label coverage | Wall time | RTF | Peak memory |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `0.75` production | 105 | 12 | 72.30% | 195.5 s | 0.093 | 6.48 GiB |
| `0.85` | 75 | 12 | 82.26% | 220.7 s | 0.105 | 5.08 GiB |
| `0.875` | 66 | 12 | 83.51% | 209.6 s | 0.099 | 5.81 GiB |
| `0.90` | 61 | 12 | 83.88% | 190.8 s | 0.090 | 5.84 GiB |
| `0.925` | 56 | 12 | 84.42% | 235.0 s | 0.111 | 4.75 GiB |
| `0.95` | 52 | 12 | 86.46% | 208.0 s | 0.099 | 5.84 GiB |

Raw cluster count decreases and label coverage increases monotonically through `0.95`. There is no clear proxy knee that can establish accuracy. This pattern may be better consolidation, harmful merging, or both.

The source WebM is stereo, but a full-recording decode found nearly identical channels: correlation `0.999997`, effectively equal RMS, and no one-second window with at least 6 dB channel dominance. Channel-preserving diarization is therefore not a useful experiment for this candidate.

## Three-minute disagreement sample

The highest-value contiguous sample was source time `04:30–07:30`, selected without examining transcript text. On full-recording assignments, threshold `0.95` labels 108 words that production leaves `Unclear` within this window.

When the excerpt is clustered independently:

| Threshold | Raw clusters | Supported labels | Label coverage | RTF | Peak memory |
| ---: | ---: | ---: | ---: | ---: | ---: |
| `0.75` | 21 | 12 | 89.60% | 0.090 | 1.99 GiB |
| `0.85` | 15 | 11 | 94.13% | 0.088 | 1.98 GiB |
| `0.875` | 14 | 10 | 94.13% | 0.088 | 1.98 GiB |
| `0.90` | 13 | 10 | 94.13% | 0.098 | 1.98 GiB |
| `0.925` | 13 | 10 | 94.13% | 0.092 | 1.98 GiB |
| `0.95` | 12 | 9 | 94.13% | 0.086 | 1.98 GiB |

Coverage reaches its plateau at `0.85`; higher thresholds only reduce the number of system labels. This makes `0.85` the more conservative ground-truth candidate for the excerpt.

## One-minute annotation sample

The smaller source interval `05:40–06:40` contains the strongest disagreement: full-recording threshold `0.95` labels 72 words that production leaves `Unclear`. When clustered independently:

| Threshold | Raw clusters | Supported labels | Label coverage | Speaker wall time |
| ---: | ---: | ---: | ---: | ---: |
| `0.75` | 6 | 5 | 95.91% | 5.10 s |
| `0.85` | 5 | 4 | 96.49% | 5.20 s |
| `0.95` | 3 | 3 | 97.66% | 5.49 s |

The local audio and timing-only annotation template are:

```text
.sotto-speaker-eval/annotation-packs/retained-threshold-frontier/clip-05m40s-06m40s.wav
.sotto-speaker-eval/runs/retained-2161-one-minute-sample/annotation-template.json
```

The listener supplied anonymous Speaker A/B ranges covering 36 seconds; the final 23 seconds and one-second gaps were deliberately left unassigned. The labels were saved only in the ignored local experiment cache. No transcript text or identifying speaker information was added to the repository.

## Human-scored results

The same labels were scored in two ways:

1. The 60-second WAV was diarized independently. This tests whether a configuration can separate the short clip in isolation.
2. The labels were shifted back to their original `05:40–06:40` position and scored against diarization of the complete 35-minute recording. This is the production-relevant check because cluster identities and the top-12 reliable-cluster filter are established across the full meeting.

### Independently clustered one-minute clip

| Configuration | Correct words | Wrong words | `Unclear` words | Weighted word loss | Equal-speaker loss | Weakest speaker correct |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `0.75` production | 57.69% | 40.38% | 1.92% | 82.69% | 101.09% | 33.33% |
| `0.85` | 92.31% | 5.77% | 1.92% | 13.46% | 54.71% | 41.67% |
| `0.85`, shift `-500 ms` | 94.23% | 3.85% | 1.92% | 9.62% | 38.04% | 58.33% |
| `0.85`, fixed 2 speakers | 92.31% | 5.77% | 1.92% | 13.46% | 54.71% | 41.67% |
| `0.85`, fixed 2, shift `-500 ms` | 94.23% | 3.85% | 1.92% | 9.62% | 38.04% | 58.33% |

In isolation, `0.85` with a `-500 ms` diarization shift is the strongest result. It reduces wrong words by 36.53 percentage points and improves the less-frequent speaker from 33.33% to 58.33% correct. Fixed two-speaker clustering produces the same final word assignment on this clip. None of the challengers matches the annotated speaker-change boundaries within the one-second tolerance, so the apparent word win does not establish boundary accuracy.

### Full-recording clustering, scored only in the annotated minute

| Configuration | Correct words | Wrong words | `Unclear` words | Weighted word loss | Equal-speaker loss | Weakest speaker correct |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `0.75` production | 70.87% | 0.97% | 28.16% | 30.10% | 65.75% | 0.00% |
| `0.85` | 73.79% | 19.42% | 6.80% | 45.63% | 60.97% | 30.00% |
| `0.85`, shift `-500 ms` | 70.87% | 20.39% | 8.74% | 49.51% | 63.12% | 20.00% |
| `0.85`, shift `-250 ms` | 72.82% | 18.45% | 8.74% | 45.63% | 56.51% | 30.00% |
| `0.85`, shift `+250 ms` | 73.79% | 20.39% | 5.83% | 46.60% | 65.97% | 30.00% |
| `0.95` | 73.79% | 19.42% | 6.80% | 45.63% | 60.97% | 30.00% |

The full-recording result reverses the isolated-clip conclusion. Production leaves more words `Unclear`, but has only 0.97% wrong-speaker words. At `0.85`, wrong-speaker words rise to 19.42%, and the overall weighted word loss worsens from 30.10% to 45.63%. Duration-weighted loss likewise worsens from 27.61% to 35.85%. The less-frequent annotated speaker improves from 0% to 30% correct by word count, so this is a real tradeoff rather than a clean win. The comparison is classified as inconclusive because the overall and equal-speaker metrics move in opposing directions.

Threshold `0.95` produces the same scored assignments as `0.85` in this minute while reducing full-recording raw clusters from 75 to 52. That is consolidation without a measured accuracy gain. The timing shifts reduce neither full-recording wrong-speaker attribution nor overall weighted loss. Fixed two-speaker mode is not applicable to the full retained meeting because only the sample's speaker count is known.

## Current recommendation

Leave production unchanged. The human-scored minute does not support a global threshold or timing-shift change: the isolated clip win fails the full-recording check, where additional label coverage comes with substantially more wrong-speaker attribution. The next experiment should target bounded recovery of filtered fragments while preserving `Unclear` when evidence conflicts, rather than globally increasing the clustering threshold. Any production proposal still needs repeatable wins on more than one annotated multi-speaker recording within the existing CPU, memory, and wall-time guardrails.
