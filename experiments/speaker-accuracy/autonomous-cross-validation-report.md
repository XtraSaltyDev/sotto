# Autonomous cross-validation follow-up

Date: 2026-07-30

This local-only follow-up reran existing, anonymous annotations from cached
audio, Whisper timing, and diarization artifacts. It did not create, edit, or
upload a recording or transcript, and it did not change the app, its speaker
defaults, or its UI.

## Operating rule

The harness can run and compare every configuration for an already annotated
local input without further human input. Where a window has no annotation, it
continues to collect raw-cluster, coverage, timing, CPU, and memory diagnostics
but marks the result as a proxy rather than claiming speaker accuracy. A new
manual annotation is only useful when choosing whether to promote a candidate
to production; it is not a prerequisite for routine experiment sweeps.

## Cross-recording result

Wrong labels cost twice as much as `Unclear`. Equal-speaker loss prevents a
short speaker from being hidden by a longer one.

| Annotated local sample | Production baseline | Threshold `0.85` | Segment-anchor reassignment | What it establishes |
| --- | --- | --- | --- | --- |
| One-minute rapid-turn window | 57.69% correct, 40.38% wrong, 1.92% `Unclear`, 82.69% loss; 1/5 boundaries | 92.31% correct, 5.77% wrong, 1.92% `Unclear`, 13.46% loss; 0/5 boundaries | 74.04% correct, 1.92% wrong, 24.04% `Unclear`, 27.88% loss; 0/5 boundaries | `0.85` has a strong attribution result here, but neither candidate repairs turn timing. |
| Independent mixed-cluster recording | 66.67% correct, 33.33% wrong, 66.67% loss; 3/4 boundaries | Exact attribution tie; fewer raw labels but no accuracy improvement | Conservative gate: **97.44%** correct, 0% wrong, 2.56% `Unclear`, 2/4 boundaries. Relaxed `250 ms / 0.48` gate: **100% correct, 0% wrong, 0% `Unclear`, 4/4 boundaries** | The paired relaxation is a complete targeted win here; it needs broader boundary validation. |
| Long fragmented-meeting window | 70.87% correct, 0.97% wrong, 28.16% `Unclear`, 30.10% loss | 73.79% correct, **19.42% wrong**, 6.80% `Unclear`, **45.63% loss** | Not a threshold candidate; the separate guarded check made no change when its inconsistency precondition was absent | A smaller raw cluster count is not evidence of better speaker accuracy. `0.85` converts uncertainty into harmful wrong labels. |
| Clean short two-speaker negative control | 100% correct, 0% wrong, exact boundary | Higher tested thresholds `0.825` and `0.90` merge speakers: 46.67% wrong | Exact tie: 100% correct, no reassigned segments | The guarded segment rule stays inert when the baseline is already correct. |

## Resource observation

The threshold runs have no new model or artifact bytes. On the one-minute
window, `0.85` used about `5.20 s` diarization wall time (`0.086×` real time)
and `1.10 GiB` peak resident memory, essentially the same as the production
baseline. On the independent recording, it used `23.39 s` (`0.294×` real
time) and `1.58 GiB`, again comparable to baseline.

Segment-anchor reassignment reuses Sotto's already bundled embedding runtime.
Its decision step is below `2 ms` after cached similarity evidence is
available. The isolated similarity measurement is still a material experiment
cost (about `2.98 s` wall time and `5.61 s` CPU time on the independent
recording), so it remains outside the production path until attribution and
boundary results repeat across more mixed-cluster cases.

## Decision

- Reject a global threshold increase: `0.85` is a local win in one window,
  an attribution tie in another, and a harmful regression in the long
  fragmented meeting; higher thresholds also merge the clean short speakers.
- Keep the production `0.75`, Auto-speaker, zero-shift, and current alignment
  behavior unchanged.
- Keep segment-anchor reassignment as the leading **experiment-only** candidate.
  The conservative gate has two attribution wins; the paired `250 ms / 0.48`
  gate adds one complete 100%/4-of-4 targeted win and stays inert on the clean
  negative control. The rapid-turn minute still has no boundary recovery, so
  this remains insufficient for a production change.

Future automated runs should use the same baseline/candidate/negative-control
set and report a production recommendation only after both attribution and
boundary metrics improve on additional independently annotated mixed-cluster
recordings within the existing resource guardrails.
