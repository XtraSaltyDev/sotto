import { describe, expect, it, vi } from 'vitest';

import {
  CaptureResources,
  type ClosableAudioContext,
  type ReleasableStream,
} from './capture-resources';

const createStream = (trackCount = 2) => {
  const tracks = Array.from({ length: trackCount }, () => ({ stop: vi.fn() }));
  return { stream: { getTracks: () => tracks } as ReleasableStream, tracks };
};

const createContext = (state = 'running') => {
  const close = vi.fn(async () => undefined);
  return {
    close,
    context: { get state() { return state; }, close } as ClosableAudioContext,
  };
};

describe('CaptureResources', () => {
  it('stops every track on both streams and closes the audio graph', async () => {
    const desktop = createStream();
    const microphone = createStream();
    const audio = createContext();
    const resources = new CaptureResources();
    resources.claimDesktopStream(desktop.stream);
    resources.claimMicrophoneStream(microphone.stream);
    resources.claimAudioContext(audio.context);

    await resources.release();

    for (const track of [...desktop.tracks, ...microphone.tracks]) {
      expect(track.stop).toHaveBeenCalledTimes(1);
    }
    expect(audio.close).toHaveBeenCalledTimes(1);
  });

  it('releases only once, so the error path and normal path can both call it', async () => {
    const desktop = createStream();
    const audio = createContext();
    const resources = new CaptureResources();
    resources.claimDesktopStream(desktop.stream);
    resources.claimAudioContext(audio.context);

    await resources.release();
    await resources.release();

    expect(desktop.tracks[0].stop).toHaveBeenCalledTimes(1);
    expect(audio.close).toHaveBeenCalledTimes(1);
  });

  it('does not close an audio context that is already closed', async () => {
    const audio = createContext('closed');
    const resources = new CaptureResources();
    resources.claimAudioContext(audio.context);

    await resources.release();

    expect(audio.close).not.toHaveBeenCalled();
  });

  it('stops tracks even when closing the audio graph fails', async () => {
    const desktop = createStream();
    const resources = new CaptureResources();
    resources.claimDesktopStream(desktop.stream);
    resources.claimAudioContext({
      state: 'running',
      close: async () => {
        throw new Error('the audio device went away');
      },
    });

    // A stream left running keeps the screen-share indicator lit.
    await expect(resources.release()).rejects.toThrow('audio device');
    expect(desktop.tracks[0].stop).toHaveBeenCalledTimes(1);
  });

  it('releases what it holds when a capture failed part way through', async () => {
    const microphone = createStream();
    const resources = new CaptureResources();
    // Desktop capture succeeded is not a precondition for cleaning up the mic.
    resources.claimMicrophoneStream(microphone.stream);

    await expect(resources.release()).resolves.toBeUndefined();
    expect(microphone.tracks[0].stop).toHaveBeenCalledTimes(1);
  });

  it('forgets the recorder on release so a stopped capture is not reused', async () => {
    const resources = new CaptureResources();
    resources.claimRecorder({ state: 'recording' });
    expect(resources.activeRecorder).toEqual({ state: 'recording' });

    await resources.release();

    expect(resources.activeRecorder).toBeNull();
  });

  it('reports whether a desktop stream was claimed', async () => {
    const resources = new CaptureResources();
    expect(resources.hasDesktopStream).toBe(false);
    resources.claimDesktopStream(createStream().stream);
    expect(resources.hasDesktopStream).toBe(true);
    await resources.release();
    expect(resources.hasDesktopStream).toBe(false);
  });

  it('does nothing when it holds nothing', async () => {
    await expect(new CaptureResources().release()).resolves.toBeUndefined();
  });
});
