import { describe, expect, it, vi } from 'vitest';

import { LiveRecordingChunkQueue } from './live-recording-chunk-queue';

const buffer = (byte: number): ArrayBuffer => new Uint8Array([byte]).buffer;
const firstByte = (chunk: ArrayBuffer): number => new Uint8Array(chunk)[0];

describe('LiveRecordingChunkQueue', () => {
  it('writes chunks in the order they were captured, never concurrently', async () => {
    const order: number[] = [];
    let active = 0;
    let concurrent = 0;
    const queue = new LiveRecordingChunkQueue({
      write: async (chunk) => {
        active += 1;
        concurrent = Math.max(concurrent, active);
        await new Promise((resolve) => setTimeout(resolve, 5 - firstByte(chunk)));
        order.push(firstByte(chunk));
        active -= 1;
        return { rejected: null };
      },
      onFailure: vi.fn(),
    });

    // Deliberately descending delays: a racing implementation would reorder.
    queue.enqueue(async () => buffer(1));
    queue.enqueue(async () => buffer(2));
    queue.enqueue(async () => buffer(3));
    await queue.drain();

    expect(order).toEqual([1, 2, 3]);
    expect(concurrent).toBe(1);
  });

  it('reads each chunk inside its turn rather than all at once', async () => {
    const reads: number[] = [];
    const queue = new LiveRecordingChunkQueue({
      write: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { rejected: null };
      },
      onFailure: vi.fn(),
    });

    for (const index of [1, 2, 3]) {
      queue.enqueue(async () => {
        reads.push(index);
        return buffer(index);
      });
    }
    // Holding every chunk in memory at once is what this avoids.
    expect(reads).toEqual([]);
    await queue.drain();
    expect(reads).toEqual([1, 2, 3]);
  });

  it('latches a rejected write and stops the capture once', async () => {
    const onFailure = vi.fn();
    const write = vi.fn(async () => ({ rejected: 'The disk is full.' }));
    const queue = new LiveRecordingChunkQueue({ write, onFailure });

    queue.enqueue(async () => buffer(1));
    await queue.drain();

    expect(queue.failureReason).toBe('The disk is full.');
    expect(onFailure).toHaveBeenCalledExactlyOnceWith('The disk is full.');
  });

  it('drops later chunks once the capture has failed', async () => {
    const write = vi.fn(async () => ({ rejected: 'The disk is full.' }));
    const queue = new LiveRecordingChunkQueue({ write, onFailure: vi.fn() });

    queue.enqueue(async () => buffer(1));
    await queue.drain();
    queue.enqueue(async () => buffer(2));
    queue.enqueue(async () => buffer(3));
    await queue.drain();

    // Appending to a file already known to be broken only delays the error.
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('keeps the first reason when a write throws outright', async () => {
    const onFailure = vi.fn();
    const queue = new LiveRecordingChunkQueue({
      write: async () => {
        throw new Error('Sotto timed out while writing the live recording to disk.');
      },
      onFailure,
    });

    queue.enqueue(async () => buffer(1));
    await queue.drain();

    expect(queue.failureReason).toBe(
      'Sotto timed out while writing the live recording to disk.',
    );
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('describes a non-Error rejection without leaking its shape', async () => {
    const queue = new LiveRecordingChunkQueue({
      write: async () => {
        throw 'socket closed';
      },
      onFailure: vi.fn(),
    });

    queue.enqueue(async () => buffer(1));
    await queue.drain();

    expect(queue.failureReason).toBe('Sotto could not save the live recording.');
  });

  it('reports an encoder failure raised outside a write', async () => {
    const onFailure = vi.fn();
    const write = vi.fn(async () => ({ rejected: null }));
    const queue = new LiveRecordingChunkQueue({ write, onFailure });

    queue.reportFailure('Sotto could not encode the live recording.');
    queue.enqueue(async () => buffer(1));
    await queue.drain();

    expect(queue.failureReason).toBe('Sotto could not encode the live recording.');
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
  });

  it('stops the capture only once when writes and the encoder both fail', async () => {
    const onFailure = vi.fn();
    const queue = new LiveRecordingChunkQueue({
      write: async () => ({ rejected: 'The disk is full.' }),
      onFailure,
    });

    queue.enqueue(async () => buffer(1));
    await queue.drain();
    queue.reportFailure('Sotto could not encode the live recording.');

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(queue.failureReason).toBe('The disk is full.');
  });

  it('drains cleanly when nothing was ever queued', async () => {
    const queue = new LiveRecordingChunkQueue({
      write: vi.fn(async () => ({ rejected: null })),
      onFailure: vi.fn(),
    });

    await expect(queue.drain()).resolves.toBeUndefined();
    expect(queue.failureReason).toBeNull();
  });
});
