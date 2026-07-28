import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ProcessAbortedError,
  runProcess,
  sanitizeProcessEnvironment,
} from './process-runner';

describe('sanitizeProcessEnvironment', () => {
  it('removes loader injection and inherited Node runtime flags', () => {
    expect(
      sanitizeProcessEnvironment({
        DYLD_INSERT_LIBRARIES: '/tmp/injected.dylib',
        dyld_library_path: '/tmp/libraries',
        LD_PRELOAD: '/tmp/injected.so',
        Node_Options: '--require=/tmp/injected.js',
        PATH: '/usr/bin',
        SOTTO_LOCALE: 'en',
      }),
    ).toEqual({
      PATH: '/usr/bin',
      SOTTO_LOCALE: 'en',
    });
  });
});

describe('runProcess', () => {
  it('requires an absolute executable path', async () => {
    await expect(
      runProcess({ executable: path.basename(process.execPath) }),
    ).rejects.toThrow('absolute path');
  });

  it('resolves non-zero exits and captures both output streams', async () => {
    const result = await runProcess({
      executable: process.execPath,
      args: [
        '-e',
        "process.stdout.write('output'); process.stderr.write('diagnostic'); process.exit(7)",
      ],
    });

    expect(result).toMatchObject({
      exitCode: 7,
      signal: null,
      stdout: 'output',
      stderr: 'diagnostic',
      stdoutTruncated: false,
      stderrTruncated: false,
    });
  });

  it('retains bounded diagnostic tails', async () => {
    const result = await runProcess({
      executable: process.execPath,
      args: ['-e', "process.stderr.write('0123456789')"],
      maxDiagnosticBytes: 4,
    });

    expect(result.stderr).toBe('6789');
    expect(result.stderrTruncated).toBe(true);
  });

  it('streams output while retaining diagnostics', async () => {
    const chunks: string[] = [];
    const result = await runProcess({
      executable: process.execPath,
      args: ['-e', "process.stdout.write('streamed')"],
      onStdout: (chunk) => chunks.push(chunk.toString('utf8')),
    });

    expect(chunks.join('')).toBe('streamed');
    expect(result.stdout).toBe('streamed');
  });

  it('stops and rejects when an output consumer fails', async () => {
    const callbackError = new Error('parser failed');
    const execution = runProcess({
      executable: process.execPath,
      args: ['-e', "process.stdout.write('streamed')"],
      onStdout: () => {
        throw callbackError;
      },
    });

    await expect(execution).rejects.toBe(callbackError);
  });

  it('distinguishes AbortSignal cancellation', async () => {
    const controller = new AbortController();
    const execution = runProcess({
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1_000)'],
      signal: controller.signal,
    });

    controller.abort();

    await expect(execution).rejects.toBeInstanceOf(ProcessAbortedError);
  });
});
