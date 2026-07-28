import { describe, expect, it, vi } from 'vitest';

import {
  createWhisperProgressParser,
  parseWhisperProgressLine,
} from './whisper-progress';

describe('parseWhisperProgressLine', () => {
  it.each([
    ['whisper_print_progress_callback: progress =   0%', 0],
    ['whisper_print_progress_callback: progress =  55%\r', 55],
    ['whisper_print_progress_callback: progress = 100%', 100],
  ])('parses an upstream progress line: %s', (line, expected) => {
    expect(parseWhisperProgressLine(line)).toBe(expected);
  });

  it.each([
    'prefix whisper_print_progress_callback: progress = 50%',
    'whisper_print_progress_callback: progress = 50% trailing',
    '[00:00:00.000 --> 00:00:01.000] progress = 50%',
    'whisper_print_progress_callback: progress = 101%',
  ])('rejects unanchored or invalid output: %s', (line) => {
    expect(parseWhisperProgressLine(line)).toBeNull();
  });
});

describe('createWhisperProgressParser', () => {
  it('recognizes stderr progress split across chunks', () => {
    const onProgress = vi.fn();
    const parser = createWhisperProgressParser(onProgress);

    parser.push(Buffer.from('whisper_print_progress_call'));
    parser.push(Buffer.from('back: progress =  25%\nother log\n'));
    parser.push(Buffer.from('whisper_print_progress_callback: progress = 100%\n'));

    expect(onProgress.mock.calls).toEqual([[25], [100]]);
  });

  it('flushes a final progress line without a trailing newline', () => {
    const onProgress = vi.fn();
    const parser = createWhisperProgressParser(onProgress);

    parser.push('whisper_print_progress_callback: progress = 100%');
    parser.end();

    expect(onProgress).toHaveBeenCalledOnce();
    expect(onProgress).toHaveBeenCalledWith(100);
  });
});
