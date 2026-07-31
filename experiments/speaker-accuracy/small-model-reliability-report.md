# Small-model reliability follow-up

Date: 2026-07-30

This follow-up keeps Sotto's bundled `small.en` Whisper model and all production diarization behavior unchanged. No alternate model was downloaded, no private text was added to source control, and all private reference material remains local and ignored.

## What was measured

The experiment pack now accepts an optional local transcription reference:

```json
{ "schemaVersion": 1, "text": "private reference transcript" }
```

It compares the cached Whisper word stream with that reference after case and punctuation normalization. It reports only aggregate substitution, deletion, insertion, word-error-rate, and word-accuracy metrics; neither transcript is written to the report.

## Controlled runtime reliability

The existing non-sensitive 11-second fixture exercised the full local path ten times in sequence:

`media validation → FFmpeg normalization → small.en Whisper → sherpa diarization → alignment → atomic transcript save`

All 10 of 10 runs completed and saved a valid transcript with one speaker. Individual end-to-end times were `2.3–3.0 s`.

The same fixture has a 22-word public reference transcript. Its cached small-model result has 22/22 correct normalized words, zero substitutions, zero deletions, zero insertions, and 0% word error rate. It also has zero wrong-speaker and zero `Unclear` words.

This proves the controlled path is currently repeatable, not that failure rates are negligible. With zero failures in ten trials, the approximate 95% upper confidence bound is still 26%. About 299 independent clean trials would be needed merely to put that bound below 1%, and repeating one short clean fixture would still not represent real meetings.

## Speaker-accuracy follow-up

The separately annotated one-minute retained window confirms that speaker identity and turn boundaries must be measured independently:

| Configuration | Correct words | Wrong words | `Unclear` words | Overall word loss | Equal-speaker loss | Boundaries matched |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Production small-model baseline | 57.69% | 40.38% | 1.92% | 82.69% | 101.09% | 1 / 5 |
| Threshold `0.85` | 92.31% | 5.77% | 1.92% | 13.46% | 54.71% | 0 / 5 |
| Conservative segment reassignment | 74.04% | 1.92% | 24.04% | 27.88% | 48.37% | 0 / 5 |

The segment rule improves on baseline by leaving uncertain speech `Unclear` rather than forcing a wrong label, but it does not repair boundaries. The higher threshold has strong word-level scores in this one window but removes every annotated turn boundary; it has already failed the full-recording check, so it is not a default candidate.

## Current evidence and next requirement

There is no evidence that `small.en` transcription itself is the main cause of the speaker failures. Whisper affects word timing, but diarization errors arise from raw speaker clusters and turn boundaries. The strongest targeted speaker result remains mixed-cluster reassignment. Its conservative gates have attribution wins but boundary regressions; a paired experiment-only relaxation (`250 ms` sample floor and `0.48` similarity floor, while retaining the inconsistency and margin gates) reached 100% speaker words and 4/4 in-tolerance boundaries on the independent mixed-cluster recording. It made no change in the annotated long-meeting cases or clean negative control, so it is not a production recommendation.

To approach a meaningful low-failure claim, the next local inputs need both kinds of ground truth:

1. A short private reference transcript for each selected window, using `transcriptReferencePath`, to measure small-model word error directly.
2. Anonymous Speaker A/B/C ranges or word assignments for the same window, leaving overlap and uncertainty unannotated.
3. Multiple independent conditions: clean speech, interruptions, overlap, noise, and at least two distinct speaker-count patterns.

## Prepared next candidate

A separate retained short recording was inspected read-only and then independently annotated locally. Its 16-word small-model transcript has zero substitutions, deletions, and insertions against the local reference (0% word error). The production baseline has two supported raw clusters across four diarization segments and scores 100% correct speaker words, 0% wrong, 0% `Unclear`, and an exact match for its one annotated turn boundary.

The full small-model first pack is also a useful negative result for global tuning:

| Configuration group | Speaker result | Interpretation |
| --- | --- | --- |
| Production baseline, lower thresholds, nearby duration settings, fixed two speakers | Exact tie at 100% correct speaker words and the exact boundary | No measurable improvement over current production settings |
| Threshold `0.825` or `0.90` | One raw cluster, 46.67% wrong speaker words, missed boundary | Clear regression: the two annotated speakers are merged |
| `+250 ms` timing shift | 6.67% `Unclear`, missed boundary | Clear regression |

This produces a second small-model transcript-reference success and a second short multi-speaker diarization success for the current baseline. It is still not a negligible-failure claim: both direct transcript checks are short, clean samples, and the longer recordings still expose fragmentation and boundary problems.

Production remains unchanged. A negligible-failure claim requires repeated independent success on both transcript word error and wrong-speaker/boundary metrics, not merely repeated completion of a clean fixture.
