import { describe, expect, it } from 'vitest';

import {
  isTranscriptCopyKind,
  isTranscriptExportFormat,
  parseTranscriptLibraryQuery,
  parseTranscriptMetadataUpdate,
} from './transcript-ipc-validation';

describe('Transcript Library IPC validation', () => {
  it('accepts and normalizes the narrow library query shape', () => {
    expect(
      parseTranscriptLibraryQuery({
        text: '  launch  ',
        createdFrom: '2026-07-01T00:00:00Z',
        speaker: ' Morgan ',
        tag: ' Client ',
      }),
    ).toEqual({
      text: 'launch',
      createdFrom: '2026-07-01T00:00:00.000Z',
      speaker: 'Morgan',
      tag: 'Client',
    });
  });

  it('rejects malformed dates and oversized searches', () => {
    expect(() =>
      parseTranscriptLibraryQuery({
        text: 'x'.repeat(501),
        createdFrom: null,
        speaker: null,
        tag: null,
      }),
    ).toThrow('cannot exceed 500');
    expect(() =>
      parseTranscriptLibraryQuery({
        text: '',
        createdFrom: 'not-a-date',
        speaker: null,
        tag: null,
      }),
    ).toThrow('date filter is invalid');
  });

  it('allows only bounded title and tag metadata', () => {
    expect(
      parseTranscriptMetadataUpdate({
        title: 'Planning',
        tags: ['Client'],
      }),
    ).toEqual({ title: 'Planning', tags: ['Client'] });
    expect(() =>
      parseTranscriptMetadataUpdate({ title: 'Planning', path: '/private' }),
    ).toThrow('Only transcript title and tags');
    expect(() =>
      parseTranscriptMetadataUpdate({ tags: ['x'.repeat(49)] }),
    ).toThrow('48 characters');
  });

  it('accepts only the fixed local output formats and copy targets', () => {
    expect([
      'txt',
      'docx',
      'srt',
      'vtt',
      'json',
      'minutes-docx',
    ].every(isTranscriptExportFormat)).toBe(true);
    expect(isTranscriptExportFormat('pdf')).toBe(false);
    expect(isTranscriptExportFormat({ format: 'srt' })).toBe(false);

    expect([
      'overview',
      'key-points',
      'decisions',
      'action-items',
      'meeting-minutes',
    ].every(isTranscriptCopyKind)).toBe(true);
    expect(isTranscriptCopyKind('transcript')).toBe(false);
    expect(isTranscriptCopyKind('/private/meeting.txt')).toBe(false);
  });

});
