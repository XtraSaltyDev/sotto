import { describe, expect, it } from 'vitest';

import {
  MAX_SEGMENT_TEXT_CHARACTERS,
  MAX_TRANSCRIPT_OFFSET_MS,
  MAX_TRANSCRIPT_SEGMENTS,
  MAX_TRANSCRIPT_TEXT_CHARACTERS,
} from './transcript-types';
import {
  normalizeWhisperOutput,
  parseWhisperOutputJson,
  WhisperOutputValidationError,
} from './whisper-output';

const whisperOutput = {
  params: {
    language: 'auto',
    model: '/private/models/ggml-base.en.bin',
  },
  result: { language: 'EN' },
  transcription: [
    {
      offsets: { from: 0, to: 1_250 },
      text: '  Welcome   to Sotto. ',
      timestamps: { from: '00:00:00,000', to: '00:00:01,250' },
    },
    {
      offsets: { from: 1_250, to: 2_500 },
      text: '\nThis stays on your computer.\n',
      timestamps: { from: '00:00:01,250', to: '00:00:02,500' },
    },
  ],
};

describe('normalizeWhisperOutput', () => {
  it('normalizes the official whisper.cpp JSON segment shape', () => {
    expect(normalizeWhisperOutput(whisperOutput)).toEqual({
      durationMs: 2_500,
      language: 'en',
      text: 'Welcome to Sotto. This stays on your computer.',
      segments: [
        { startMs: 0, endMs: 1_250, text: 'Welcome to Sotto.' },
        {
          startMs: 1_250,
          endMs: 2_500,
          text: 'This stays on your computer.',
        },
      ],
      words: [],
    });
  });

  it('parses JSON without retaining model paths or unrelated engine output', () => {
    const normalized = parseWhisperOutputJson(JSON.stringify(whisperOutput));

    expect(normalized).not.toHaveProperty('params');
    expect(JSON.stringify(normalized)).not.toContain('/private/models');
  });

  it('accepts a valid empty transcription', () => {
    expect(
      normalizeWhisperOutput({ result: { language: null }, transcription: [] }),
    ).toEqual({ durationMs: 0, language: null, text: '', segments: [], words: [] });
  });

  it('keeps bounded lexical token timings from full JSON and drops control tokens', () => {
    const output = normalizeWhisperOutput({
      result: { language: 'en' },
      transcription: [
        {
          offsets: { from: 0, to: 1_000 },
          text: ' Hello!',
          tokens: [
            { id: 50_363, text: '[_BEG_]', offsets: { from: 0, to: 0 } },
            { id: 18_435, text: ' Hello', offsets: { from: 100, to: 700 } },
            { id: 0, text: '!', offsets: { from: 700, to: 900 } },
          ],
        },
      ],
    });

    expect(output.words).toEqual([
      { startMs: 100, endMs: 700, text: ' Hello', segmentIndex: 0 },
      { startMs: 700, endMs: 900, text: '!', segmentIndex: 0 },
    ]);
  });

  it.each([
    {
      label: 'too many segments',
      value: {
        transcription: Array.from({ length: MAX_TRANSCRIPT_SEGMENTS + 1 }),
      },
    },
    {
      label: 'oversized segment text',
      value: {
        transcription: [
          {
            offsets: { from: 0, to: 1 },
            text: 'x'.repeat(MAX_SEGMENT_TEXT_CHARACTERS + 1),
          },
        ],
      },
    },
    {
      label: 'offset above the seven-day limit',
      value: {
        transcription: [
          {
            offsets: { from: 0, to: MAX_TRANSCRIPT_OFFSET_MS + 1 },
            text: 'too long',
          },
        ],
      },
    },
    {
      label: 'overlapping segments',
      value: {
        transcription: [
          { offsets: { from: 0, to: 2_000 }, text: 'first' },
          { offsets: { from: 1_000, to: 3_000 }, text: 'second' },
        ],
      },
    },
  ])('rejects $label', ({ value }) => {
    expect(() => normalizeWhisperOutput(value)).toThrow(
      WhisperOutputValidationError,
    );
  });

  it('bounds the combined normalized transcript text', () => {
    const segmentText = 'x'.repeat(MAX_SEGMENT_TEXT_CHARACTERS);
    const segmentCount = Math.floor(
      MAX_TRANSCRIPT_TEXT_CHARACTERS / MAX_SEGMENT_TEXT_CHARACTERS,
    );
    const transcription = Array.from({ length: segmentCount + 1 }, (_, index) => ({
      offsets: { from: index, to: index + 1 },
      text: segmentText,
    }));

    expect(() => normalizeWhisperOutput({ transcription })).toThrow(
      WhisperOutputValidationError,
    );
  });

  it('reports malformed JSON as a validation error', () => {
    expect(() => parseWhisperOutputJson('{not-json')).toThrowError(
      'Whisper output is not valid JSON.',
    );
  });
});
