import { describe, expect, it } from 'vitest';

import { TRANSCRIPT_SCHEMA_VERSION, type TranscriptRecord } from '../transcription/transcript-types';
import { buildMeetingSummary } from './meeting-summary';

const record = (segments: TranscriptRecord['segments']): TranscriptRecord => ({
  schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
  id: '32ce6fee-8f3e-4f03-a266-46d6c00ef08c',
  title: 'Planning meeting',
  tags: [],
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

  it('reassembles sentences split by noisy speaker boundaries', () => {
    const summary = buildMeetingSummary(record([
      {
        startMs: 1_000,
        endMs: 2_000,
        speakerId: null,
        words: [],
        text: 'We decided to move',
      },
      {
        startMs: 2_000,
        endMs: 3_000,
        speakerId: null,
        words: [],
        text: 'the customer launch to Tuesday.',
      },
      {
        startMs: 4_000,
        endMs: 5_000,
        speakerId: null,
        words: [],
        text: 'Morgan will send',
      },
      {
        startMs: 5_000,
        endMs: 6_000,
        speakerId: null,
        words: [],
        text: 'the revised schedule tomorrow.',
      },
    ]));

    expect(summary?.decisions).toEqual([
      expect.objectContaining({
        startMs: 1_000,
        text: 'We decided to move the customer launch to Tuesday.',
      }),
    ]);
    expect(summary?.actionItems).toEqual([
      expect.objectContaining({
        startMs: 4_000,
        text: 'Morgan will send the revised schedule tomorrow.',
      }),
    ]);
  });

  it('does not promote vague fragments into decisions or action items', () => {
    const summary = buildMeetingSummary(record([
      {
        startMs: 1_000,
        endMs: 2_000,
        speakerId: null,
        words: [],
        text: '- Agreed.',
      },
      {
        startMs: 3_000,
        endMs: 4_000,
        speakerId: null,
        words: [],
        text: 'having the need to see who came off shift.',
      },
      {
        startMs: 5_000,
        endMs: 6_000,
        speakerId: null,
        words: [],
        text: 'You just need to change how you do things.',
      },
    ]));

    expect(summary?.decisions).toEqual([]);
    expect(summary?.actionItems).toEqual([]);
  });

  it('recognizes contracted ownership and avoids filler-heavy key points', () => {
    const summary = buildMeetingSummary(record([
      {
        startMs: 1_000,
        endMs: 2_000,
        speakerId: null,
        words: [],
        text: "I just like, well, this is one thing too, but a lot of these projects I just like, it's not even like, I just don't even have to think about it in the sense of carving out time for it.",
      },
      {
        startMs: 3_000,
        endMs: 4_000,
        speakerId: null,
        words: [],
        text: "I'll send the revised launch schedule to the team tomorrow.",
      },
    ]));

    expect(summary?.keyPoints).toEqual([
      expect.objectContaining({ startMs: 3_000 }),
    ]);
    expect(summary?.actionItems).toEqual([
      expect.objectContaining({
        startMs: 3_000,
        text: "I'll send the revised launch schedule to the team tomorrow.",
      }),
    ]);
  });

  it('ranks repeated meeting topics above unrelated opening chatter', () => {
    const summary = buildMeetingSummary(record([
      {
        startMs: 1_000,
        endMs: 2_000,
        speakerId: null,
        words: [],
        text: 'The mountain restaurant served an unforgettable breakfast beside the river.',
      },
      {
        startMs: 3_000,
        endMs: 4_000,
        speakerId: null,
        words: [],
        text: 'The launch needs a security review before the customer rollout.',
      },
      {
        startMs: 5_000,
        endMs: 6_000,
        speakerId: null,
        words: [],
        text: 'We decided to finish the security review before launch.',
      },
      {
        startMs: 7_000,
        endMs: 8_000,
        speakerId: null,
        words: [],
        text: 'Morgan will send the launch checklist after the security review.',
      },
    ]));

    expect(summary?.keyPoints.map((item) => item.startMs)).not.toContain(1_000);
    expect(summary?.overview).not.toContain('mountain restaurant');
  });
});
