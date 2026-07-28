import { describe, expect, it, vi } from 'vitest';

import type { ProcessResult } from '../process/process-runner';
import {
  parseFfmpegMediaProbe,
  probeMedia,
} from './media-probe';

const successfulResult = (stderr: string): ProcessResult => ({
  exitCode: 0,
  signal: null,
  stdout: '',
  stderr,
  stdoutTruncated: false,
  stderrTruncated: false,
});

const probeOutput = `Input #0, matroska,webm, from '/recordings/meeting.webm':
  Metadata:
    ENCODER         : Chrome
  Duration: 01:02:03.500, start: 0.000000, bitrate: 192 kb/s
  Stream #0:0(eng): Video: vp9, yuv420p, 1920x1080
  Stream #0:1(eng): Audio: opus, 48000 Hz, stereo, fltp
`;

describe('parseFfmpegMediaProbe', () => {
  it('extracts duration and the first audio stream from video metadata', () => {
    expect(parseFfmpegMediaProbe(probeOutput)).toEqual({
      durationSeconds: 3723.5,
      audio: {
        codec: 'opus',
        sampleRateHz: 48000,
        channelLayout: 'stereo',
      },
    });
  });

  it('supports audio with an unknown container duration', () => {
    expect(
      parseFfmpegMediaProbe(
        '  Duration: N/A, start: 0.000000\r\n' +
          '  Stream #0:0: Audio: pcm_s16le, 16000 Hz, mono, s16\r\n',
      ),
    ).toEqual({
      durationSeconds: null,
      audio: {
        codec: 'pcm_s16le',
        sampleRateHz: 16000,
        channelLayout: 'mono',
      },
    });
  });

  it('returns null when no audio stream is present', () => {
    expect(
      parseFfmpegMediaProbe(
        '  Stream #0:0: Video: h264, yuv420p, 1920x1080\n',
      ),
    ).toBeNull();
  });
});

describe('probeMedia', () => {
  it('runs a bounded one-frame audio probe', async () => {
    const processRunner = vi.fn().mockResolvedValue(successfulResult(probeOutput));

    const result = await probeMedia({
      ffmpegPath: '/runtime/ffmpeg',
      inputPath: '/recordings/meeting.webm',
      processRunner,
    });

    expect(result.audio.codec).toBe('opus');
    expect(processRunner).toHaveBeenCalledWith({
      executable: '/runtime/ffmpeg',
      args: [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'info',
        '-i',
        '/recordings/meeting.webm',
        '-map',
        '0:a:0',
        '-frames:a',
        '1',
        '-f',
        'wav',
        'pipe:1',
      ],
      maxDiagnosticBytes: 256 * 1024,
      signal: undefined,
    });
  });

  it('returns a typed failure for an unreadable input', async () => {
    const processRunner = vi.fn().mockResolvedValue({
      ...successfulResult('Invalid data found when processing input'),
      exitCode: 1,
    });

    await expect(
      probeMedia({
        ffmpegPath: '/runtime/ffmpeg',
        inputPath: '/recordings/broken.mp4',
        processRunner,
      }),
    ).rejects.toMatchObject({
      code: 'probe-failed',
      diagnostics: 'Invalid data found when processing input',
    });
  });

  it('distinguishes media with no audio stream', async () => {
    const diagnostics =
      "Stream map '0:a:0' matches no streams.\n" +
      'To ignore this, add a trailing question mark to the map.';
    const processRunner = vi.fn().mockResolvedValue({
      ...successfulResult(diagnostics),
      exitCode: 1,
    });

    await expect(
      probeMedia({
        ffmpegPath: '/runtime/ffmpeg',
        inputPath: '/recordings/silent-video.mp4',
        processRunner,
      }),
    ).rejects.toMatchObject({ code: 'no-audio-stream' });
  });
});
