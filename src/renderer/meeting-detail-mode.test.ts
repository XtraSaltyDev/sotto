import { describe, expect, it } from 'vitest';

import { meetingDetailModeForKey } from './App';

describe('meeting detail tab keyboard navigation', () => {
  it('moves between Summary and Transcript with arrow keys', () => {
    expect(meetingDetailModeForKey('summary', 'ArrowRight')).toBe('transcript');
    expect(meetingDetailModeForKey('transcript', 'ArrowLeft')).toBe('summary');
    expect(meetingDetailModeForKey('summary', 'ArrowUp')).toBe('transcript');
  });

  it('supports Home and End without consuming unrelated keys', () => {
    expect(meetingDetailModeForKey('transcript', 'Home')).toBe('summary');
    expect(meetingDetailModeForKey('summary', 'End')).toBe('transcript');
    expect(meetingDetailModeForKey('summary', 'Enter')).toBeNull();
  });
});
