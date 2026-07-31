# Segment-anchor gate sweep

Date: 2026-07-30

This is an experiment-only local result. It reuses the bundled speaker runtime,
cached local audio/Whisper timing/raw diarization, and aggregate similarity
diagnostics. It does not change production diarization, alignment, defaults,
UI behavior, recordings, or saved transcripts.

## Question

The conservative segment-anchor rule leaves samples below `500 ms` or `0.50`
similarity `Unclear`, even after an internally inconsistent cluster and a
clear `0.20` nearest-speaker margin have been established. Can a narrow paired
relaxation recover a genuine short turn without generalizing beyond that guard?

## Controlled gates

All trials retain the existing `0.40` internal-inconsistency gate and `0.20`
margin. Only the following two gates vary:

| Trial | Minimum sampled duration | Minimum other-cluster similarity |
| --- | ---: | ---: |
| Conservative | 500 ms | 0.50 |
| Duration only | 250 ms | 0.50 |
| Similarity only | 500 ms | 0.48 |
| Paired relaxation | 250 ms | 0.48 |

## Independent annotated mixed-cluster recording

| Configuration | Correct words | Wrong words | `Unclear` words | Weighted loss | Boundary recall | Boundary F1 | Reassigned segments | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Production baseline | 66.67% | 33.33% | 0.00% | 66.67% | 3 / 4 | 85.71% | 0 | Baseline |
| Conservative | 97.44% | 0.00% | 2.56% | 2.56% | 2 / 4 | 66.67% | 2 | Attribution win, boundary regression |
| Duration only | 97.44% | 0.00% | 2.56% | 2.56% | 2 / 4 | 66.67% | 2 | Exact tie |
| Similarity only | 97.44% | 0.00% | 2.56% | 2.56% | 2 / 4 | 66.67% | 2 | Exact tie |
| Paired relaxation | **100.00%** | **0.00%** | **0.00%** | **0.00%** | **4 / 4** | **100.00%** | 3 | Complete targeted win |

The paired change recovers the additional `320 ms` raw segment. Its aggregate
similarity clears `0.48` and retains a margin above `0.20`; no voice vector,
audio, or transcript text is retained in this report.

## Cross-checks

| Local sample | Paired-relaxation outcome |
| --- | --- |
| One-minute rapid-turn meeting | Exact tie with conservative reassignment: 74.04% correct, 1.92% wrong, 24.04% `Unclear`, 0/5 boundaries. |
| Annotated long fragmented-meeting window | Exact tie with conservative reassignment: 94.17% correct, 3.88% wrong, 1.94% `Unclear`, 0/5 boundaries. |
| Clean short two-speaker negative control | Exact tie with production: 100% correct, 0% wrong, 0% `Unclear`, 1/1 boundary; no segment was reassigned. |
| Additional unannotated retained proxy | One supported raw cluster across `7.74 s`; 21 labeled words, 0 `Unclear`, no inconsistent cluster, and no reassignment. This is a scope/coverage check only, not an accuracy score. |

## Resource and decision boundary

The gate values change only the local post-similarity decision; they add no
model bytes and do not rerun Whisper or diarization when caches are present.
The existing isolated similarity measurement remains the cost: about `2.98 s`
wall time, `5.61 s` CPU time, and `542.5 MiB` peak resident memory on the
independent recording.

The candidate is promising but remains experimental. It has one complete
boundary-and-attribution win, ties on the other checks, and no new regression;
it has not yet repeated that complete win on a second independently annotated
mixed-cluster case. Leave production unchanged.
