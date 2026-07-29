import type { TranscriptSegment } from '../shared/contracts';

export const PLAYBACK_JUMP_SECONDS = 5;

export const activeSegmentIndexAt = (
  segments: readonly TranscriptSegment[],
  currentTimeMs: number,
): number =>
  segments.findIndex(
    (segment) =>
      currentTimeMs >= segment.startMs && currentTimeMs < segment.endMs,
  );

export const isPunctuationOnlyToken = (text: string): boolean =>
  text.trim().length > 0 && !/[\p{L}\p{N}]/u.test(text);

export const shouldIgnorePlaybackShortcut = (target: EventTarget | null): boolean => {
  const element = target as (EventTarget & {
    isContentEditable?: boolean;
    tagName?: string;
  }) | null;
  if (!element || typeof element.tagName !== 'string') return false;
  return (
    element.isContentEditable === true ||
    ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A'].includes(element.tagName)
  );
};
