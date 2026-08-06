import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { recordingElapsedMs, withTimeout } from './app-format';

/**
 * withTimeout bounds every step that can stall: closing the encoder, flushing
 * the last recording chunk, finalizing a recording, and reading app state. A
 * bound that failed to fire would turn each of those into an indefinite wait
 * with nothing on screen to explain it.
 */

// The helper reaches for window timers; tests run without a DOM.
const originalWindow = (globalThis as { window?: unknown }).window;

beforeEach(() => {
  (globalThis as { window?: unknown }).window = {
    setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
    clearTimeout: (handle: unknown) => clearTimeout(handle as never),
  };
});

afterEach(() => {
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = originalWindow;
  vi.useRealTimers();
});

describe('withTimeout', () => {
  it('passes a value through when the work finishes in time', async () => {
    await expect(withTimeout(Promise.resolve('done'), 1_000, 'too slow'))
      .resolves.toBe('done');
  });

  it('rejects with the caller’s message when the work never settles', async () => {
    // A promise that never settles is exactly the stuck main process this
    // guards against.
    await expect(
      withTimeout(new Promise<never>(() => undefined), 10, 'Sotto could not read its local state.'),
    ).rejects.toThrow('Sotto could not read its local state.');
  });

  it('preserves the original failure rather than reporting a timeout', async () => {
    await expect(
      withTimeout(Promise.reject(new Error('disk is full')), 1_000, 'too slow'),
    ).rejects.toThrow('disk is full');
  });

  it('clears its timer once the work settles', async () => {
    const clearTimeoutSpy = vi.fn();
    (globalThis as { window?: unknown }).window = {
      setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
      clearTimeout: clearTimeoutSpy,
    };

    await withTimeout(Promise.resolve(1), 1_000, 'too slow');
    await withTimeout(Promise.reject(new Error('nope')), 1_000, 'too slow')
      .catch(() => undefined);

    // A leaked timer would keep the renderer awake after the work is done.
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(2);
  });

  it('does not reject after the work already succeeded', async () => {
    const settled: string[] = [];
    await withTimeout(Promise.resolve('first'), 5, 'too slow')
      .then((value) => settled.push(value));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(settled).toEqual(['first']);
  });
});

describe('recordingElapsedMs', () => {
  it('does not advance the meeting timer while recording is paused', () => {
    const recording = {
      id: '32ce6fee-8f3e-4f03-a266-46d6c00ef08c',
      kind: 'meeting' as const,
      sourceName: 'meeting.webm',
      startedAt: '2026-08-06T12:00:00.000Z',
      bytesWritten: 10,
      paused: true,
      pausedAt: '2026-08-06T12:00:05.000Z',
      pausedDurationMs: 0,
      markers: [],
    };

    expect(recordingElapsedMs(recording, Date.parse('2026-08-06T12:00:20.000Z')))
      .toBe(5_000);
  });

  it('subtracts completed pauses after resume', () => {
    const recording = {
      id: '32ce6fee-8f3e-4f03-a266-46d6c00ef08c',
      kind: 'meeting' as const,
      sourceName: 'meeting.webm',
      startedAt: '2026-08-06T12:00:00.000Z',
      bytesWritten: 10,
      paused: false,
      pausedAt: null,
      pausedDurationMs: 8_000,
      markers: [],
    };

    expect(recordingElapsedMs(recording, Date.parse('2026-08-06T12:00:20.000Z')))
      .toBe(12_000);
  });
});
