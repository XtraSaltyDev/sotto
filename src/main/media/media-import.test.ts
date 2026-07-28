import { describe, expect, it } from 'vitest';

import { MAX_MEDIA_FILE_BYTES, validateSelectedMedia } from './media-import';

describe('validateSelectedMedia', () => {
  it('accepts a Teams-style MP4 recording', () => {
    expect(validateSelectedMedia('/Meetings/Weekly Sync.MP4', 4096)).toEqual({
      ok: true,
      media: {
        extension: 'MP4',
        mediaKind: 'video',
        name: 'Weekly Sync.MP4',
        path: '/Meetings/Weekly Sync.MP4',
        sizeBytes: 4096,
      },
    });
  });

  it('accepts common audio recordings', () => {
    expect(validateSelectedMedia('/Meetings/audio.m4a', 512).ok).toBe(true);
    expect(validateSelectedMedia('/Meetings/audio.wav', 512).ok).toBe(true);
  });

  it('rejects unsupported, empty, and oversized files', () => {
    expect(validateSelectedMedia('/Meetings/notes.txt', 128).ok).toBe(false);
    expect(validateSelectedMedia('/Meetings/audio.wav', 0).ok).toBe(false);
    expect(
      validateSelectedMedia('/Meetings/audio.wav', MAX_MEDIA_FILE_BYTES + 1).ok,
    ).toBe(false);
  });
});
