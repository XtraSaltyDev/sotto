import { describe, expect, it } from 'vitest';

import {
  createTranscriptLibraryQuery,
  parseTranscriptTagDraft,
  transcriptLibraryCreatedFrom,
} from './transcript-library';

describe('Transcript Library renderer helpers', () => {
  const now = new Date('2026-07-29T18:00:00.000Z');

  it('creates stable local date filters and leaves all dates unbounded', () => {
    expect(transcriptLibraryCreatedFrom('all', now)).toBeNull();
    expect(transcriptLibraryCreatedFrom('7-days', now)).toBe(
      '2026-07-22T18:00:00.000Z',
    );
    expect(transcriptLibraryCreatedFrom('30-days', now)).toBe(
      '2026-06-29T18:00:00.000Z',
    );
  });

  it('builds a compact query with empty selects represented as null', () => {
    expect(
      createTranscriptLibraryQuery({
        dateRange: 'all',
        speaker: '',
        tag: '',
        text: '  launch notes  ',
        now,
      }),
    ).toEqual({
      text: 'launch notes',
      createdFrom: null,
      speaker: null,
      tag: null,
    });
  });

  it('parses comma-separated tags, removing blank and duplicate values', () => {
    expect(parseTranscriptTagDraft(' Client, planning, client,  next steps ')).toEqual({
      ok: true,
      tags: ['Client', 'planning', 'next steps'],
    });
  });

  it('rejects overlong tag drafts before sending them to the desktop process', () => {
    expect(parseTranscriptTagDraft('x'.repeat(49))).toEqual({
      ok: false,
      reason: 'Each tag must be 48 characters or fewer.',
    });
  });
});
