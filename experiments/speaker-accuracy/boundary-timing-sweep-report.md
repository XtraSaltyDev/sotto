# Boundary-timing sweep follow-up

Date: 2026-07-30

This experiment-only follow-up tested the guarded segment-anchor reassignment
with the same `-500 ms`, `-250 ms`, `0 ms`, and `+250 ms` diarization shifts
on two independently annotated local recordings. It reused cached normalized
WAV, Whisper timing, raw diarization, and isolated similarity measurements.
No saved recording, saved transcript, production default, or UI behavior was
changed.

## Boundary scoring correction

The evaluation documentation has always described a one-second boundary
tolerance, but the prior scorer paired every nearest system and reference
boundary even when they were far apart. The scorer now applies that fixed
`1,000 ms` tolerance: only an in-tolerance pair is a match; all remaining
reference boundaries are missed and all remaining system boundaries are extra.
The focused scoring test covers this distant-boundary case.

## Results

| Annotated recording | Configuration | Correct words | Wrong words | `Unclear` words | Weighted loss | In-tolerance boundaries | Result |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| One-minute rapid-turn window | Production baseline | 57.69% | 40.38% | 1.92% | 82.69% | 1 / 5 | Baseline |
| One-minute rapid-turn window | Segment-anchor, `-500 ms` | 60.58% | 0.96% | 38.46% | 40.38% | 0 / 5 | Attribution win; boundary regression |
| One-minute rapid-turn window | Segment-anchor, `-250 ms` | 59.62% | 2.88% | 37.50% | 43.27% | 0 / 5 | Attribution win; boundary regression |
| One-minute rapid-turn window | Segment-anchor, `0 ms` | **74.04%** | **1.92%** | 24.04% | **27.88%** | 0 / 5 | Best attribution; no boundary recovery |
| One-minute rapid-turn window | Segment-anchor, `+250 ms` | 58.65% | 2.88% | 38.46% | 44.23% | 0 / 5, 1 extra | Regression from zero shift |
| Independent mixed-cluster recording | Production baseline | 66.67% | 33.33% | 0.00% | 66.67% | 3 / 4 | Baseline |
| Independent mixed-cluster recording | Segment-anchor, `-500 ms` | 51.28% | 0.00% | 48.72% | 48.72% | 0 / 4 | Inconclusive tradeoff; boundary regression |
| Independent mixed-cluster recording | Segment-anchor, `-250 ms` | 51.28% | 0.00% | 48.72% | 48.72% | 0 / 4 | Inconclusive tradeoff; boundary regression |
| Independent mixed-cluster recording | Segment-anchor, `0 ms` | **97.44%** | **0.00%** | 2.56% | **2.56%** | 2 / 4 | Best attribution; one fewer exact boundary |
| Independent mixed-cluster recording | Segment-anchor, `+250 ms` | 51.28% | 2.56% | 46.15% | 51.28% | 0 / 4 | Regression |

## Conclusion

There is no timing-shift candidate. The conservative zero-shift segment rule is
consistently the best attribution option, but it does not improve—and in these
samples reduces—boundary recall. The separate paired gate sweep below found one
targeted exception; it does not make a timing shift or the broader segment rule
ready for production. Future work must improve turn segmentation itself while
preserving the existing conservative handling of overlap, missing timing,
distant speech, and conflicting boundaries.

## Nearby duration controls

The same guarded zero-shift rule was also tested with the nearby
`minDurationOn`/`minDurationOff` pairs `0.10/0.30`, `0.20/0.30`,
`0.20/0.70`, and `0.30/0.50`.

Every pair was an exact accuracy and boundary tie with the zero-shift segment
result on both recordings: `74.04%` correct, `1.92%` wrong, `0/5` boundary
recall in the rapid-turn minute; and `97.44%` correct, `0%` wrong, `2/4`
boundary recall in the independent mixed-cluster recording. The variations
only changed diarization wall time. There is therefore no duration setting to
promote, and the problem is not resolvable by nearby timing knobs.

## Segment-anchor gate follow-up

On the independent mixed-cluster recording, lowering only the sample-duration
floor to `250 ms` or only the similarity floor to `0.48` was an exact tie with
the conservative rule. Lowering both while retaining the `0.40` inconsistency
guard and `0.20` margin reassigned one additional `320 ms` segment. It produced
`100%` correct speaker words, `0%` wrong, `0%` `Unclear`, and `4/4`
in-tolerance boundaries. The combined gate made no change in either annotated
long-meeting case and stayed inert at `100%` with the exact boundary in the
clean short negative control.

This is a repeatable targeted experiment result, not proof that the relaxed
gate improves general turn segmentation. It remains outside production until
another independently annotated mixed-cluster case confirms both the
attribution and boundary result.
