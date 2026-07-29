import { describe, expect, it } from 'vitest';

import {
  TRANSCRIPT_SCHEMA_VERSION,
  type TranscriptRecord,
} from '../transcription/transcript-types';
import { searchTranscriptRecords } from './transcript-library';

const createRecord = (
  overrides: Partial<TranscriptRecord> = {},
): TranscriptRecord => ({
  schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
  id: '32ce6fee-8f3e-4f03-a266-46d6c00ef08c',
  title: 'Quarterly planning',
  tags: ['Client', 'Roadmap'],
  createdAt: '2026-07-27T12:00:00.000Z',
  completedAt: '2026-07-27T12:10:00.000Z',
  source: {
    type: 'recording',
    name: 'meeting.webm',
    mediaKind: 'audio',
    sizeBytes: 42,
  },
  durationMs: 4_000,
  language: 'en',
  engine: { name: 'whisper.cpp', model: 'small.en', version: '1.9.1' },
  speakerAnalysis: {
    engine: {
      name: 'sherpa-onnx',
      model: 'pyannote + 3D-Speaker',
      version: '1.13.4',
    },
    speakers: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        label: 'Mórgan',
      },
    ],
  },
  text: 'We decided to move the launch to Tuesday.',
  segments: [
    {
      startMs: 0,
      endMs: 4_000,
      text: 'We decided to move the launch to Tuesday.',
      speakerId: '11111111-1111-4111-8111-111111111111',
      words: [],
    },
  ],
  ...overrides,
});

const query = {
  text: '',
  createdFrom: null,
  speaker: null,
  tag: null,
};

describe('Transcript Library search', () => {
  it.each([
    ['title', 'quarterly'],
    ['transcript text and summary content', 'launch Tuesday'],
    ['local speaker label', 'morgan'],
    ['tag', 'roadmap'],
  ])('matches %s without case or accent sensitivity', (_field, text) => {
    expect(
      searchTranscriptRecords([createRecord()], { ...query, text }).records,
    ).toHaveLength(1);
  });

  it('requires every search term while allowing terms from different fields', () => {
    expect(
      searchTranscriptRecords([createRecord()], {
        ...query,
        text: 'Morgan Tuesday',
      }).records,
    ).toHaveLength(1);
    expect(
      searchTranscriptRecords([createRecord()], {
        ...query,
        text: 'Morgan Thursday',
      }).records,
    ).toHaveLength(0);
  });

  it('combines date, speaker, and tag filters', () => {
    expect(
      searchTranscriptRecords([createRecord()], {
        ...query,
        createdFrom: '2026-07-01T00:00:00.000Z',
        speaker: 'MORGAN',
        tag: 'client',
      }).records,
    ).toHaveLength(1);
    expect(
      searchTranscriptRecords([createRecord()], {
        ...query,
        createdFrom: '2026-07-28T00:00:00.000Z',
      }).records,
    ).toHaveLength(0);
  });

  it('returns sorted unique speaker and tag choices from the full library', () => {
    const second = createRecord({
      id: '8a219ad8-2544-47dd-b984-a2369a105a9e',
      tags: ['client', 'Follow up'],
    });
    const result = searchTranscriptRecords([createRecord(), second], query);
    expect(result.availableSpeakers).toEqual(['Mórgan']);
    expect(result.availableTags).toEqual(['Client', 'Follow up', 'Roadmap']);
  });
});
