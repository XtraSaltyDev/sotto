import { describe, expect, it } from 'vitest';

import {
  buildSpeakerAnnotation,
  formatSpeakerAnnotation,
} from './speaker-annotation';
import type { TranscriptRecord } from '../transcription/transcript-types';
import { TRANSCRIPT_SCHEMA_VERSION } from '../transcription/transcript-types';

const MORGAN = '6d73be9d-c055-4dc2-93d6-d821fb4f95ec';
const SARAH = 'a75d6b1a-eaa3-43bf-8084-08e3b509c445';

const createRecord = (
  overrides: Partial<TranscriptRecord> = {},
): TranscriptRecord => ({
  schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
  id: '32ce6fee-8f3e-4f03-a266-46d6c00ef08c',
  title: 'Launch planning',
  tags: [],
  createdAt: '2026-07-29T18:00:00.000Z',
  completedAt: '2026-07-29T18:01:00.000Z',
  source: {
    type: 'recording',
    name: 'meeting.webm',
    mediaKind: 'audio',
    sizeBytes: 1_024,
  },
  durationMs: 20_000,
  language: 'en',
  engine: { name: 'whisper.cpp', model: 'large-v3-turbo', version: '1.9.1' },
  speakerAnalysis: {
    engine: { name: 'sherpa-onnx', model: 'eres2net', version: '1.13.4' },
    speakers: [
      { id: MORGAN, label: 'Morgan' },
      { id: SARAH, label: 'Sarah' },
    ],
  },
  text: 'One. Two. Three.',
  segments: [
    { startMs: 0, endMs: 5_000, text: 'One.', speakerId: MORGAN, words: [] },
    { startMs: 5_000, endMs: 12_000, text: 'Two.', speakerId: SARAH, words: [] },
    { startMs: 12_000, endMs: 20_000, text: 'Three.', speakerId: MORGAN, words: [] },
  ],
  ...overrides,
});

describe('buildSpeakerAnnotation', () => {
  it('emits the harness shape with one range per labelled segment', () => {
    expect(buildSpeakerAnnotation(createRecord())).toEqual({
      schemaVersion: 1,
      durationMs: 20_000,
      speakers: ['Morgan', 'Sarah'],
      ranges: [
        { startMs: 0, endMs: 5_000, speaker: 'Morgan' },
        { startMs: 5_000, endMs: 12_000, speaker: 'Sarah' },
        { startMs: 12_000, endMs: 20_000, speaker: 'Morgan' },
      ],
      words: [],
    });
  });

  it('omits unlabeled segments rather than inventing a speaker for them', () => {
    const record = createRecord();
    const annotation = buildSpeakerAnnotation({
      ...record,
      segments: record.segments.map((segment, index) =>
        index === 1 ? { ...segment, speakerId: null } : segment,
      ),
    });

    expect(annotation.ranges).toHaveLength(2);
    expect(annotation.ranges.every((range) => range.speaker === 'Morgan')).toBe(true);
    // Sarah carries no range, so she is not part of the reference.
    expect(annotation.speakers).toEqual(['Morgan']);
  });

  it('drops a speaker that no segment uses', () => {
    // A reference that counts unused labels measures flatter than the truth.
    const record = createRecord();
    const annotation = buildSpeakerAnnotation({
      ...record,
      segments: record.segments.map((segment) => ({
        ...segment,
        speakerId: MORGAN,
      })),
    });

    expect(annotation.speakers).toEqual(['Morgan']);
  });

  it('produces an empty reference when nothing was labelled', () => {
    const record = createRecord();
    expect(buildSpeakerAnnotation({
      ...record,
      speakerAnalysis: null,
      segments: record.segments.map((segment) => ({ ...segment, speakerId: null })),
    })).toMatchObject({ speakers: [], ranges: [] });
  });

  it('serializes as trailing-newline JSON the harness can read back', () => {
    const text = formatSpeakerAnnotation(createRecord());
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual(buildSpeakerAnnotation(createRecord()));
  });
});
