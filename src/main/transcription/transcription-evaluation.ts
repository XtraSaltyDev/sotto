import type { NormalizedWhisperOutput } from './whisper-output';

const MAX_REFERENCE_CHARACTERS = 1_000_000;
const MAX_REFERENCE_WORDS = 10_000;

export interface TranscriptionReference {
  schemaVersion: 1;
  text: string;
}

export interface TranscriptionAccuracyMetrics {
  referenceWordCount: number;
  hypothesisWordCount: number;
  correctWordCount: number;
  substitutionCount: number;
  deletionCount: number;
  insertionCount: number;
  wordErrorRate: number | null;
  wordAccuracyRate: number | null;
}

interface EditCell {
  distance: number;
  correct: number;
  substitutions: number;
  deletions: number;
  insertions: number;
}

const fail = (message: string): never => {
  throw new TypeError(message);
};

const normalizeWords = (text: string): string[] =>
  text
    .normalize('NFKC')
    .replaceAll('’', "'")
    .toLocaleLowerCase('en-US')
    .match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];

const pickBest = (candidates: readonly EditCell[]): EditCell =>
  [...candidates].sort((left, right) =>
    left.distance - right.distance ||
    right.correct - left.correct ||
    left.substitutions - right.substitutions ||
    left.deletions - right.deletions ||
    left.insertions - right.insertions,
  )[0];

export const parseTranscriptionReference = (value: unknown): TranscriptionReference => {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    typeof (value as { text?: unknown }).text !== 'string'
  ) {
    return fail('Transcription reference must use schemaVersion 1 and contain text.');
  }
  const text = (value as { text: string }).text;
  if (
    text.length === 0 ||
    text.length > MAX_REFERENCE_CHARACTERS ||
    text.includes('\0')
  ) {
    return fail('Transcription reference text must be a bounded, non-empty string.');
  }
  if (normalizeWords(text).length > MAX_REFERENCE_WORDS) {
    return fail(`Transcription reference cannot contain more than ${MAX_REFERENCE_WORDS} words.`);
  }
  return { schemaVersion: 1, text };
};

/**
 * Scores the cached Whisper result against a locally supplied reference. The
 * report retains aggregate edit counts only; neither source text is emitted.
 */
export const scoreTranscriptionAccuracy = (
  whisper: NormalizedWhisperOutput,
  reference: TranscriptionReference,
): TranscriptionAccuracyMetrics => {
  const expected = normalizeWords(reference.text);
  const actual = normalizeWords(whisper.words.map((word) => word.text).join(''));
  const empty: EditCell = {
    distance: 0,
    correct: 0,
    substitutions: 0,
    deletions: 0,
    insertions: 0,
  };
  let previous: EditCell[] = [empty];
  for (let index = 1; index <= actual.length; index += 1) {
    previous.push({
      ...previous[index - 1],
      distance: index,
      insertions: index,
    });
  }
  for (let expectedIndex = 1; expectedIndex <= expected.length; expectedIndex += 1) {
    const current: EditCell[] = [{
      ...previous[0],
      distance: expectedIndex,
      deletions: expectedIndex,
      insertions: 0,
    }];
    for (let actualIndex = 1; actualIndex <= actual.length; actualIndex += 1) {
      const diagonal = previous[actualIndex - 1];
      if (expected[expectedIndex - 1] === actual[actualIndex - 1]) {
        current.push({
          ...diagonal,
          correct: diagonal.correct + 1,
        });
        continue;
      }
      current.push(pickBest([
        {
          ...diagonal,
          distance: diagonal.distance + 1,
          substitutions: diagonal.substitutions + 1,
        },
        {
          ...previous[actualIndex],
          distance: previous[actualIndex].distance + 1,
          deletions: previous[actualIndex].deletions + 1,
        },
        {
          ...current[actualIndex - 1],
          distance: current[actualIndex - 1].distance + 1,
          insertions: current[actualIndex - 1].insertions + 1,
        },
      ]));
    }
    previous = current;
  }
  const result = previous.at(-1) as EditCell;
  return {
    referenceWordCount: expected.length,
    hypothesisWordCount: actual.length,
    correctWordCount: result.correct,
    substitutionCount: result.substitutions,
    deletionCount: result.deletions,
    insertionCount: result.insertions,
    wordErrorRate: expected.length > 0 ? result.distance / expected.length : null,
    wordAccuracyRate: expected.length > 0 ? result.correct / expected.length : null,
  };
};
