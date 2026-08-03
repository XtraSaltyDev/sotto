# Synthetic ground-truth pack: constructed annotations and a segment-anchor regression

Date: 2026-08-03. Harness: `scripts/run-speaker-accuracy.cjs` with the
standard schema, metrics, and decision rule. All runs local; no production
change.

## Motivation

The segment-anchor reassignment candidate is blocked on a second annotated
recording containing a guarded mixed cluster, and no listener time was
available to annotate retained media. This pack sidesteps listening: each
recording is synthesized from macOS TTS voices, so the annotation is exact
by construction — every range's speaker is the voice that rendered it, every
boundary is computed to the sample, and the reference transcript is the
script itself (never Whisper output, so WER stays non-circular).

Generator: `synthetic/generate-synthetic-meetings.py`. Audio is written to
the git-ignored `synthetic/media/`; annotations, references, and configs are
committed and regenerate deterministically (seeded noise). Configurations per
recording: `production`, `guard` (`novel-speaker-balanced-segment-guard`),
`anchor-conservative` (defaults 0.40/0.50/0.20/500 ms), `anchor-relaxed`
(0.48 similarity / 250 ms sample floor).

**Evidence boundary.** TTS speech is cleaner than a real meeting: no room
reverb, no crosstalk, no overlap, and neural voices are acoustically more
uniform than real speakers. Results are mechanism evidence and regression
protection, not proof about real-meeting accuracy.

## Recordings

| Name | Length | Speakers | Design |
| --- | ---: | ---: | --- |
| `synthetic-rapid-two` | 49.9 s | 2 | Rapid turns (60–200 ms gaps), many one-word interjections |
| `synthetic-similar-pair` | 44.6 s | 2 | Similar female voices, mild noise, short turns |
| `synthetic-three-clean` | 42.7 s | 3 | Distinct pitch-separated voices, normal gaps |
| `synthetic-mixed-cluster` | 61.1 s | 2 | Long clear turns around a rapid exchange |
| `synthetic-guarded-mix` | 61.1 s | 2 | Same, but the rapid exchange is low-passed + noised to detach its embeddings |

A first iteration without pitch separation collapsed both two-speaker
recordings into **one raw cluster** (47–55 % correct, zero boundaries):
un-shifted TTS voices under-cluster badly. Per-speaker resampling pitch
shifts (factors 0.85–1.08) restored separability and are required for any
future TTS-based case.

## Results (word-timed; balanced loss per decision rule)

| Recording | Config | Raw clusters | Correct | Wrong | Unclear | Weighted loss | Boundaries |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| rapid-two | all four | 1 | 48.20 % | 51.80 % | 0.00 % | 103.60 % | 0/19 |
| similar-pair | all four | 2 | 87.50 % | 12.50 % | 0.00 % | 25.00 % | 0/15 |
| three-clean | all four | 3 | 93.20 % | 6.80 % | 0.00 % | 13.59 % | 6/9 |
| mixed-cluster | all four | 2 | 99.43 % | 0.00 % | 0.57 % | 0.57 % | 5/5 matched of 9 ref¹ |
| guarded-mix | production | 3 | **98.77 %** | 0.00 % | 1.23 % | 1.23 % | 5/9 |
| guarded-mix | guard | 3 | **98.77 %** | 0.00 % | 1.23 % | 1.23 % | 5/9 |
| guarded-mix | anchor-conservative | 3 | **45.06 %** | 2.47 % | **52.47 %** | 57.41 % | **0/9** |
| guarded-mix | anchor-relaxed | 3 | **45.06 %** | 2.47 % | **52.47 %** | 57.41 % | **0/9** |

¹ Boundary rows report matched/reference at the fixed 1 000 ms tolerance.

Whisper reference check on `synthetic-guarded-mix`: 8.33 % WER
(156/168 correct, 12 substitutions, 2 insertions) — transcription is not the
error source, consistent with the small-model report.

## Findings

1. **Segment-anchor reassignment has an unbounded blast radius.** On
   `synthetic-guarded-mix`, the degraded stretch drove one of the two
   *primary supported clusters* below the 0.40 internal-median guard
   (lowest median 0.289). Production still attributed 98.77 % correctly —
   but both reassignment gates then removed the flagged cluster's
   unmeasured and weak segments from alignment, demoting **52.47 % of
   annotated words to Unclear**, collapsing the weakest speaker from
   97.30 % to 1.14 % correct and boundary recall from 5/9 to 0/9. The mode
   was designed for small mixed clusters (the retained recording's flagged
   cluster held 4.81 s); nothing restricts it when the flagged cluster *is*
   a main speaker. This is the first measured regression for the candidate
   and blocks promotion in its current form.
2. **The guard alone remains safe.** Exact tie with production on all five
   recordings, including the one where it flags (cost ≤ 0.74 s per run).
   Its prior evidence (one win, now four ties, no regression) still supports
   shipping the guard as a protective check once the production child emits
   similarity scores.
3. **Rapid-turn under-clustering reproduced synthetically.**
   `synthetic-rapid-two` (60–200 ms gaps) collapses to one raw cluster and
   0/19 boundaries — the same failure class as the retained rapid-turn
   minute (57.69 % correct, 1/5). The synthetic case is a cheap regression
   target for future segmentation-model experiments.
4. **Recovery modes never fire spuriously.** On the four recordings without
   a guarded cluster, every candidate configuration is byte-identical to
   production — further scope-safety evidence.

## Required next step for the candidate

Before segment-anchor reassignment can be reconsidered, it needs a bound on
demotion: for example, only apply to flagged clusters whose word support is
below a small share of total support (the retained case was ~6 % of the
recording), or cap the duration the mode may move to Unclear, falling back
to guard-only behavior beyond the cap. `synthetic-guarded-mix` plus the
retained mixed-cluster recording form the test pair: the bounded mode must
keep the retained win and turn the synthetic regression back into a tie.

## Follow-up (same date): blast radius bounded, test pair passes

`SegmentAnchorReassignmentOptions` gained `maximumFlaggedSupportShare`
(default 0.15): a flagged cluster carrying more than that share of all
supported word support keeps guard-only behavior — its segments stay
untouched instead of being demoted. Experiment-only; production unchanged.

| Test-pair case | Config | Before bound | After bound (default 0.15) |
| --- | --- | ---: | ---: |
| `synthetic-guarded-mix` (flagged primary, ~44 % share) | anchor conservative + relaxed | 45.06 % correct, 52.47 % Unclear, 0/9 boundaries | **98.77 % correct — exact production tie** |
| Retained mixed-cluster recording (flagged cluster ~6 % share) | anchor-conservative | 97.44 % correct, harness verdict **win** | 97.44 % correct, harness verdict **win** (unchanged) |
| Retained mixed-cluster recording | 250 ms / 0.48 relaxed gates | 100 % correct, 4/4 boundaries, **win** | 100 % correct, **win** (unchanged) |

An attempted synthetic small-flagged-cluster case (`synthetic-small-mix`,
two degraded turns ≈ 2.5 s) did not detach a cluster — production absorbed
it at 99.40 % with no guard flag — so the fires-below-cap behavior is
demonstrated by the retained recording and unit tests rather than a second
synthetic recording. The candidate's promotion requirement is unchanged
(an independently annotated real mixed-cluster win), but its known
unbounded-demotion failure mode is now closed and regression-tested.
