import { describe, expect, it } from 'vitest';

import {
  TRANSCRIPT_COPY_OPTIONS,
  TRANSCRIPT_EXPORT_OPTIONS,
  transcriptCopySuccessMessage,
  transcriptExportFailureLabel,
} from './transcript-output-actions';

describe('transcript output actions', () => {
  it('exposes every useful export once in a calm menu order', () => {
    expect(TRANSCRIPT_EXPORT_OPTIONS.map((option) => option.format)).toEqual([
      'minutes-docx',
      'docx',
      'txt',
      'srt',
      'vtt',
      'json',
    ]);
    expect(new Set(TRANSCRIPT_EXPORT_OPTIONS.map((option) => option.format)).size)
      .toBe(TRANSCRIPT_EXPORT_OPTIONS.length);
  });

  it('labels all five copy targets and gives content-free success feedback', () => {
    expect(TRANSCRIPT_COPY_OPTIONS.map((option) => option.kind)).toEqual([
      'overview',
      'key-points',
      'decisions',
      'action-items',
      'meeting-minutes',
    ]);
    expect(transcriptCopySuccessMessage('meeting-minutes')).toBe(
      'Complete meeting minutes copied.',
    );
    expect(transcriptCopySuccessMessage('overview')).not.toContain('The team');
  });

  it('uses readable fallback export labels', () => {
    expect(transcriptExportFailureLabel('vtt')).toBe('Subtitles (WebVTT)');
    expect(transcriptExportFailureLabel('minutes-docx')).toBe(
      'Meeting minutes (DOCX)',
    );
  });
});
