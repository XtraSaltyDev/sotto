import { describe, expect, it } from 'vitest';

import { TRANSCRIPT_SCHEMA_VERSION, type TranscriptRecord } from '../transcription/transcript-types';
import { buildMeetingSummary } from './meeting-summary';

const record = (segments: TranscriptRecord['segments']): TranscriptRecord => ({
  schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
  id: '32ce6fee-8f3e-4f03-a266-46d6c00ef08c',
  title: 'Planning meeting',
  createdAt: '2026-07-29T12:00:00.000Z',
  completedAt: '2026-07-29T12:30:00.000Z',
  source: { type: 'recording', name: 'meeting.webm', mediaKind: 'audio', sizeBytes: 42 },
  durationMs: 1_800_000,
  language: 'en',
  engine: { name: 'whisper.cpp', version: '1.9.1', model: 'small.en' },
  speakerAnalysis: null,
  text: segments.map((segment) => segment.text).join(' '),
  segments,
});

describe('buildMeetingSummary', () => {
  it('extracts timestamped key points, decisions, and action items locally', () => {
    const summary = buildMeetingSummary(record([
      {
        startMs: 1_000,
        endMs: 8_000,
        speakerId: null,
        words: [],
        text: 'The customer launch depends on completing the security review this week.',
      },
      {
        startMs: 10_000,
        endMs: 16_000,
        speakerId: null,
        words: [],
        text: 'We decided to move the launch to Tuesday.',
      },
      {
        startMs: 18_000,
        endMs: 25_000,
        speakerId: null,
        words: [],
        text: 'Morgan will send the revised schedule to the team.',
      },
    ]));

    expect(summary?.overview).toContain('launch');
    expect(summary?.decisions).toEqual([
      expect.objectContaining({ startMs: 10_000, text: expect.stringContaining('Tuesday') }),
    ]);
    expect(summary?.actionItems).toEqual([
      expect.objectContaining({ startMs: 18_000, text: expect.stringContaining('Morgan') }),
    ]);
    expect(summary?.keyPoints.length).toBeGreaterThan(0);
  });

  it('returns no summary when no spoken content exists', () => {
    expect(buildMeetingSummary(record([]))).toBeNull();
  });
});
