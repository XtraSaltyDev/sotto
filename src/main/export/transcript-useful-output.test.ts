import { describe, expect, it } from 'vitest';

import type { MeetingSummary } from '../../shared/contracts';
import {
  LEGACY_TRANSCRIPT_SCHEMA_VERSION,
  parseTranscriptRecord,
  TRANSCRIPT_SCHEMA_VERSION,
  type TranscriptRecord,
} from '../transcription/transcript-types';
import {
  createPortableTranscript,
  createSubtitleCues,
  formatMeetingMinutesText,
  formatSrtTimestamp,
  formatTranscriptAsSrt,
  formatTranscriptAsWebVtt,
  formatTranscriptCopyText,
  formatWebVttTimestamp,
  MAX_SUBTITLE_CUE_CHARACTERS,
  serializePortableTranscript,
} from './transcript-useful-output';

const SPEAKER_ID = '11111111-1111-4111-8111-111111111111';

const record = (overrides: Partial<TranscriptRecord> = {}): TranscriptRecord => ({
  schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
  id: '32ce6fee-8f3e-4f03-a266-46d6c00ef08c',
  title: 'Planning meeting',
  tags: ['Client', 'Launch'],
  createdAt: '2026-07-29T12:00:00.000Z',
  completedAt: '2026-07-29T12:30:00.000Z',
  source: {
    type: 'recording',
    name: 'planning.webm',
    mediaKind: 'audio',
    sizeBytes: 12_345,
  },
  durationMs: 12_000,
  language: 'en',
  engine: { name: 'whisper.cpp', model: 'small.en', version: '1.9.1' },
  speakerAnalysis: {
    engine: { name: 'sherpa-onnx', model: 'local', version: '1.13.4' },
    speakers: [{ id: SPEAKER_ID, label: 'Morgan & Team' }],
  },
  text: 'First line. Second line with punctuation.',
  segments: [
    {
      startMs: 1_234,
      endMs: 4_567,
      speakerId: SPEAKER_ID,
      text: 'First line.\nSecond line <with> punctuation & detail.',
      words: [
        { startMs: 1_234, endMs: 1_800, text: 'First' },
        { startMs: 1_800, endMs: 2_200, text: 'line.' },
      ],
    },
    {
      startMs: 5_000,
      endMs: 7_000,
      speakerId: null,
      text: 'No known speaker.',
      words: [],
    },
  ],
  ...overrides,
});

const summary: MeetingSummary = {
  overview: 'The team reviewed launch readiness.',
  keyPoints: [
    { text: 'Security review is nearly complete.', startMs: 1_234, speakerId: SPEAKER_ID },
  ],
  decisions: [
    { text: 'We decided to launch Tuesday.', startMs: 5_000, speakerId: null },
  ],
  actionItems: [
    { text: 'Morgan will send the plan.', startMs: 7_000, speakerId: SPEAKER_ID },
  ],
};

describe('subtitle exports', () => {
  it('formats normalized SRT and WebVTT timestamps beyond one hour', () => {
    expect(formatSrtTimestamp(3_661_007)).toBe('01:01:01,007');
    expect(formatWebVttTimestamp(3_661_007)).toBe('01:01:01.007');
    expect(formatSrtTimestamp(-8)).toBe('00:00:00,000');
  });

  it('writes sequential SRT cues with saved speakers and normalized multiline text', () => {
    expect(formatTranscriptAsSrt(record())).toBe(
      '1\n' +
      '00:00:01,234 --> 00:00:04,567\n' +
      'Morgan & Team: First line. Second line <with> punctuation & detail.\n\n' +
      '2\n' +
      '00:00:05,000 --> 00:00:07,000\n' +
      'Unclear: No known speaker.\n',
    );
  });

  it('writes a valid WEBVTT header and escapes cue-text markup', () => {
    const output = formatTranscriptAsWebVtt(record());
    expect(output.startsWith(
      'WEBVTT\n\n1\n00:00:01.234 --> 00:00:04.567\n',
    )).toBe(true);
    expect(output).toContain(
      'Morgan &amp; Team: First line. Second line &lt;with&gt; punctuation &amp; detail.',
    );
    expect(output).not.toContain('\r');
    expect(formatTranscriptAsWebVtt(record({ segments: [] }))).toBe('WEBVTT\n\n');
  });

  it('orders, repairs, and splits malformed or very long cues deterministically', () => {
    const malformed = record({
      segments: [
        {
          startMs: 2_000,
          endMs: 1_000,
          speakerId: null,
          text: 'later',
          words: [],
        },
        {
          startMs: 100,
          endMs: 200,
          speakerId: null,
          text: 'word '.repeat(150),
          words: [],
        },
      ],
    });
    const cues = createSubtitleCues(malformed);
    expect(cues.length).toBeGreaterThan(2);
    expect(cues[0].startMs).toBe(100);
    expect(cues.every((cue) => cue.endMs > cue.startMs)).toBe(true);
    expect(cues.every((cue, index) => index === 0 || cue.startMs >= cues[index - 1].endMs))
      .toBe(true);
    expect(cues.every((cue) => cue.text.length <= MAX_SUBTITLE_CUE_CHARACTERS + 9))
      .toBe(true);
  });

  it('exports schema-v1 segment timing without requiring word timing', () => {
    const legacy = parseTranscriptRecord({
      schemaVersion: LEGACY_TRANSCRIPT_SCHEMA_VERSION,
      id: record().id,
      title: 'Legacy transcript',
      createdAt: record().createdAt,
      completedAt: record().completedAt,
      source: record().source,
      durationMs: 4_000,
      language: 'en',
      engine: record().engine,
      text: 'Legacy timing works.',
      segments: [{ startMs: 250, endMs: 2_500, text: 'Legacy timing works.' }],
    });
    expect(legacy.segments[0].words).toEqual([]);
    expect(formatTranscriptAsSrt(legacy)).toContain(
      '00:00:00,250 --> 00:00:02,500\nLegacy timing works.',
    );
  });
});

describe('portable transcript JSON', () => {
  it('has a stable versioned shape with word timing, speakers, and the local summary', () => {
    const portable = createPortableTranscript(record(), summary);
    expect(portable).toMatchObject({
      format: 'sotto-portable-transcript',
      formatVersion: 1,
      transcript: {
        title: 'Planning meeting',
        source: { type: 'recording', name: 'planning.webm', mediaKind: 'audio' },
        speakers: [{ id: SPEAKER_ID, label: 'Morgan & Team' }],
        meetingSummary: summary,
      },
    });
    expect(portable.transcript.segments[0]).toMatchObject({
      speakerId: SPEAKER_ID,
    });
    expect(portable.transcript.segments[0].words[0]).toEqual({
      startMs: 1_234,
      endMs: 1_800,
      text: 'First',
    });
    expect(serializePortableTranscript(record(), summary)).toBe(
      serializePortableTranscript(record(), summary),
    );
  });

  it('excludes paths, private URLs, temporary state, and storage-only metadata', () => {
    const json = serializePortableTranscript(record({
      recordingId: '22222222-2222-4222-8222-222222222222',
    }), summary);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const serializedKeys = JSON.stringify(parsed);
    expect(serializedKeys).not.toContain('recordingId');
    expect(serializedKeys).not.toContain('sizeBytes');
    expect(serializedKeys).not.toContain('playback');
    expect(serializedKeys).not.toContain('sotto-media://');
    expect(serializedKeys).not.toContain('/Users/');
    expect(serializedKeys).not.toContain('temporary');
  });
});

describe('meeting-minutes and copy text', () => {
  it('formats complete minutes with title, date, every section, labels, and timestamps', () => {
    const text = formatMeetingMinutesText(record(), summary);
    expect(text).toContain('Planning meeting\nDate: 2026-07-29T12:30:00.000Z');
    expect(text).toContain('OVERVIEW\nThe team reviewed launch readiness.');
    expect(text).toContain(
      'KEY POINTS\n- [00:00:01] Morgan & Team: Security review is nearly complete.',
    );
    expect(text).toContain('DECISIONS\n- [00:00:05] We decided to launch Tuesday.');
    expect(text).toContain('ACTION ITEMS');
  });

  it('creates clean reusable text for each copy target and honest empty states', () => {
    expect(formatTranscriptCopyText(record(), summary, 'overview')).toBe(
      summary.overview,
    );
    expect(formatTranscriptCopyText(record(), summary, 'key-points')).toBe(
      '- [00:00:01] Morgan & Team: Security review is nearly complete.',
    );
    expect(formatTranscriptCopyText(record(), summary, 'meeting-minutes')).toContain(
      'DECISIONS',
    );
    expect(formatTranscriptCopyText(record(), null, 'action-items')).toBe(
      'No action items were found.',
    );
  });
});
