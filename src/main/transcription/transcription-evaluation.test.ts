import { describe, expect, it } from 'vitest';

import {
  parseTranscriptionReference,
  scoreTranscriptionAccuracy,
} from './transcription-evaluation';

const whisper = (words: string[]) => ({
  durationMs: 1_000,
  language: 'en',
  text: words.join(' '),
  segments: [],
  words: words.map((text, index) => ({
    startMs: index * 100,
    endMs: index * 100 + 90,
    text: index === 0 ? text : ` ${text}`,
    segmentIndex: 0,
  })),
});

describe('local transcription reference scoring', () => {
  it('counts substitutions, insertions, and deletions deterministically', () => {
    const reference = parseTranscriptionReference({
      schemaVersion: 1,
      text: 'Alpha bravo charlie delta',
    });
    const first = scoreTranscriptionAccuracy(
      whisper(['alpha', 'beta', 'delta', 'echo']),
      reference,
    );
    const second = scoreTranscriptionAccuracy(
      whisper(['alpha', 'beta', 'delta', 'echo']),
      reference,
    );

    expect(first).toEqual({
      referenceWordCount: 4,
      hypothesisWordCount: 4,
      correctWordCount: 2,
      substitutionCount: 1,
      deletionCount: 1,
      insertionCount: 1,
      wordErrorRate: 0.75,
      wordAccuracyRate: 0.5,
    });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('normalizes punctuation and rejects malformed or oversized references', () => {
    const reference = parseTranscriptionReference({
      schemaVersion: 1,
      text: 'Don’t—STOP, 42!',
    });
    expect(scoreTranscriptionAccuracy(
      whisper(["don't", 'stop', '42']),
      reference,
    ).wordErrorRate).toBe(0);
    expect(() => parseTranscriptionReference({ schemaVersion: 2, text: 'no' }))
      .toThrow('schemaVersion 1');
    expect(() => parseTranscriptionReference({ schemaVersion: 1, text: '' }))
      .toThrow('non-empty');
  });
});
