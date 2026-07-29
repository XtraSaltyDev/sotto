import { describe, expect, it } from 'vitest';

import type { TranscriptSegment } from '../shared/contracts';
import {
  activeSegmentIndexAt,
  isPunctuationOnlyToken,
  shouldIgnorePlaybackShortcut,
} from './playback';

const segments: TranscriptSegment[] = [
  { startMs: 0, endMs: 1_000, text: 'Hello.', speakerId: null, words: [] },
  { startMs: 1_500, endMs: 2_000, text: 'Next.', speakerId: null, words: [] },
];

describe('transcript playback helpers', () => {
  it('finds only the segment covering the current playback time', () => {
    expect(activeSegmentIndexAt(segments, 999)).toBe(0);
    expect(activeSegmentIndexAt(segments, 1_000)).toBe(-1);
    expect(activeSegmentIndexAt(segments, 1_500)).toBe(1);
  });

  it('keeps punctuation visible without presenting it as a seekable word', () => {
    expect(isPunctuationOnlyToken('!')).toBe(true);
    expect(isPunctuationOnlyToken(' hello')).toBe(false);
    expect(isPunctuationOnlyToken('   ')).toBe(false);
  });

  it('does not take playback shortcuts from normal interactive controls', () => {
    expect(shouldIgnorePlaybackShortcut({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true);
    expect(shouldIgnorePlaybackShortcut({ tagName: 'BUTTON' } as unknown as EventTarget)).toBe(true);
    expect(shouldIgnorePlaybackShortcut({ tagName: 'DIV' } as unknown as EventTarget)).toBe(false);
  });
});
