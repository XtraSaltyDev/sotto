import { describe, expect, it } from 'vitest';

import {
  CAPTURE_CHANNELS,
  CAPTURE_CHANNEL_COUNT,
  recordingChannelLayout,
} from './capture-channels';

describe('recordingChannelLayout', () => {
  it('separates the two sources when both carry audio', () => {
    expect(recordingChannelLayout({
      hasDesktopAudio: true,
      hasMicrophoneAudio: true,
    })).toBe('desktop-microphone');
  });

  it('stays mixed when the microphone was declined', () => {
    // Meeting audio only: one source spread across a stereo pair would just
    // halve its level once transcription downmixes to mono.
    expect(recordingChannelLayout({
      hasDesktopAudio: true,
      hasMicrophoneAudio: false,
    })).toBe('mixed');
  });

  it('stays mixed for a microphone-only capture such as dictation', () => {
    expect(recordingChannelLayout({
      hasDesktopAudio: false,
      hasMicrophoneAudio: true,
    })).toBe('mixed');
  });

  it('stays mixed when neither source carries audio', () => {
    expect(recordingChannelLayout({
      hasDesktopAudio: false,
      hasMicrophoneAudio: false,
    })).toBe('mixed');
  });
});

describe('CAPTURE_CHANNELS', () => {
  it('assigns each source a distinct channel within the declared count', () => {
    const channels = Object.values(CAPTURE_CHANNELS);
    expect(new Set(channels).size).toBe(channels.length);
    expect(channels.every((channel) => channel < CAPTURE_CHANNEL_COUNT)).toBe(true);
    // The layout is written into recordings, so these positions are a
    // persisted contract rather than an implementation detail.
    expect(CAPTURE_CHANNELS.desktop).toBe(0);
    expect(CAPTURE_CHANNELS.microphone).toBe(1);
  });
});
