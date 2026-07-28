import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveWhisperSidecarTarget } from './sidecar-resolver';

describe('resolveWhisperSidecarTarget', () => {
  it('resolves the Apple Silicon sidecar contract', () => {
    expect(resolveWhisperSidecarTarget('darwin', 'arm64')).toEqual({
      executableName: 'whisper-cli',
      resourceDirectory: path.join('sidecars', 'darwin-arm64'),
    });
  });

  it('resolves the Windows x64 sidecar contract', () => {
    expect(resolveWhisperSidecarTarget('win32', 'x64')).toEqual({
      executableName: 'whisper-cli.exe',
      resourceDirectory: path.join('sidecars', 'win32-x64'),
    });
  });

  it('declines unsupported targets explicitly', () => {
    expect(resolveWhisperSidecarTarget('linux', 'x64')).toBeNull();
    expect(resolveWhisperSidecarTarget('win32', 'arm64')).toBeNull();
  });
});
