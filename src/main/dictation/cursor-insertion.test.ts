import { describe, expect, it, vi } from 'vitest';

import type { ProcessResult } from '../process/process-runner';
import { insertTextAtCursor } from './cursor-insertion';

const result = (exitCode = 0): ProcessResult => ({
  exitCode,
  signal: null,
  stdout: '',
  stderr: '',
  stdoutTruncated: false,
  stderrTruncated: false,
});

describe('insertTextAtCursor', () => {
  it('copies text and sends a fixed macOS paste shortcut', async () => {
    const writeClipboardText = vi.fn();
    const processRunner = vi.fn(async () => result());

    await expect(
      insertTextAtCursor('  Hello from dictation.  ', {
        platform: 'darwin',
        writeClipboardText,
        isMacAccessibilityTrusted: () => true,
        processRunner,
      }),
    ).resolves.toEqual({ outcome: 'inserted' });

    expect(writeClipboardText).toHaveBeenCalledWith('Hello from dictation.');
    expect(processRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: '/usr/bin/osascript',
        args: [
          '-e',
          'tell application "System Events" to keystroke "v" using command down',
        ],
      }),
    );
  });

  it('copies without launching a process when macOS accessibility is unavailable', async () => {
    const processRunner = vi.fn(async () => result());

    await expect(
      insertTextAtCursor('Fallback text', {
        platform: 'darwin',
        writeClipboardText: vi.fn(),
        isMacAccessibilityTrusted: () => false,
        processRunner,
      }),
    ).resolves.toMatchObject({ outcome: 'copied' });
    expect(processRunner).not.toHaveBeenCalled();
  });

  it('uses the fixed hidden PowerShell paste command on Windows', async () => {
    const processRunner = vi.fn(async () => result());

    await expect(
      insertTextAtCursor('Windows dictation', {
        platform: 'win32',
        windowsRoot: 'C:\\Windows',
        writeClipboardText: vi.fn(),
        processRunner,
      }),
    ).resolves.toEqual({ outcome: 'inserted' });

    expect(processRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        executable:
          'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        args: expect.arrayContaining(['-WindowStyle', 'Hidden', '-Command']),
      }),
    );
  });

  it('keeps the text copied when the platform paste command fails', async () => {
    await expect(
      insertTextAtCursor('Still available', {
        platform: 'win32',
        windowsRoot: 'C:\\Windows',
        writeClipboardText: vi.fn(),
        processRunner: async () => result(1),
      }),
    ).resolves.toMatchObject({ outcome: 'copied' });
  });

  it('does not alter the clipboard for an empty transcript', async () => {
    const writeClipboardText = vi.fn();

    await expect(
      insertTextAtCursor('   ', {
        platform: 'darwin',
        writeClipboardText,
      }),
    ).resolves.toMatchObject({ outcome: 'failed' });
    expect(writeClipboardText).not.toHaveBeenCalled();
  });
});
