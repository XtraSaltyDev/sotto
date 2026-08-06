import { describe, expect, it } from 'vitest';

import {
  TRANSCRIPT_SCHEMA_VERSION,
  type TranscriptRecord,
} from '../transcription/transcript-types';
import { fingerprintTranscriptForLocalAi } from '../local-ai/local-ai-meeting-summary';
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
    const result = searchTranscriptRecords([createRecord()], {
      ...query,
      text: 'Morgan Tuesday',
    });
    expect(result.records).toHaveLength(1);
    expect(result.matches).toEqual([
      {
        transcriptId: createRecord().id,
        field: 'transcript',
        text: 'We decided to move the launch to Tuesday.',
      },
      { transcriptId: createRecord().id, field: 'speaker', text: 'Mórgan' },
    ]);
    expect(
      searchTranscriptRecords([createRecord()], {
        ...query,
        text: 'Morgan Thursday',
      }).records,
    ).toHaveLength(0);
  });

  it('returns bounded excerpts from summary content as well as transcript content', () => {
    const record = createRecord({
      text: 'A different transcript sentence.',
      segments: [
        {
          startMs: 0,
          endMs: 4_000,
          text: 'A different transcript sentence.',
          speakerId: null,
          words: [],
        },
      ],
    });
    record.localAiMeetingSummary = {
      inputFingerprint: fingerprintTranscriptForLocalAi(record),
      model: 'test-model',
      generatedAt: '2026-07-27T12:11:00.000Z',
      summary: {
        overview: 'Approved Tuesday launch after customer review.',
        keyPoints: [],
        decisions: [],
        actionItems: [],
      },
    };
    const result = searchTranscriptRecords([record], {
      ...query,
      text: 'approved customer',
    });

    expect(result.records).toHaveLength(1);
    expect(result.matches).toEqual([
      {
        transcriptId: record.id,
        field: 'summary',
        text: 'Approved Tuesday launch after customer review.',
      },
    ]);
  });

  it('limits match excerpts to three per transcript', () => {
    const record = createRecord({
      title: 'Launch planning',
      text: 'Launch transcript.',
      tags: ['Launch'],
      segments: [
        {
          startMs: 0,
          endMs: 1_000,
          text: 'Launch segment one.',
          speakerId: null,
          words: [],
        },
        {
          startMs: 1_000,
          endMs: 2_000,
          text: 'Launch segment two.',
          speakerId: null,
          words: [],
        },
      ],
    });

    expect(
      searchTranscriptRecords([record], { ...query, text: 'launch' }).matches,
    ).toHaveLength(3);
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
