import { describe, expect, it } from 'vitest';

import {
  adjacentSearchResult,
  matchingTranscriptSegmentIndexes,
} from './transcript-search';

describe('transcript search', () => {
  const segments = [
    { text: 'Welcome to the weekly planning meeting.' },
    { text: 'Morgan reviewed the launch plan.' },
    { text: 'The planning notes stay private.' },
  ];

  it('finds matching segments without case sensitivity or surrounding spaces', () => {
    expect(matchingTranscriptSegmentIndexes(segments, '  PLANNING ')).toEqual([0, 2]);
  });

  it('does not treat an empty query as a match', () => {
    expect(matchingTranscriptSegmentIndexes(segments, '   ')).toEqual([]);
  });

  it('moves through results in both directions and wraps', () => {
    expect(adjacentSearchResult(-1, 3, 1)).toBe(0);
    expect(adjacentSearchResult(-1, 3, -1)).toBe(2);
    expect(adjacentSearchResult(2, 3, 1)).toBe(0);
    expect(adjacentSearchResult(0, 3, -1)).toBe(2);
    expect(adjacentSearchResult(0, 0, 1)).toBe(-1);
  });
});
