import path from 'node:path';

import type { InsertDictationTextResult } from '../../shared/contracts';
import {
  runProcess,
  type ProcessResult,
  type RunProcessOptions,
} from '../process/process-runner';

const MACOS_PASTE_SCRIPT =
  'tell application "System Events" to keystroke "v" using command down';
const WINDOWS_PASTE_SCRIPT =
  "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')";
const PASTE_TIMEOUT_MS = 5_000;

export interface CursorInsertionOptions {
  platform?: NodeJS.Platform;
  windowsRoot?: string;
  writeClipboardText: (text: string) => void;
  isMacAccessibilityTrusted?: () => boolean;
  processRunner?: (
    options: RunProcessOptions,
  ) => Promise<ProcessResult>;
}

const copiedResult = (platform: NodeJS.Platform): InsertDictationTextResult => ({
  outcome: 'copied',
  reason:
    platform === 'darwin'
      ? 'Sotto copied the dictation. Allow Sotto in Privacy & Security → Accessibility, then press Command+V.'
      : platform === 'win32'
        ? 'Sotto copied the dictation, but Windows could not paste it. Press Ctrl+V.'
        : 'Sotto copied the dictation, but automatic insertion is not supported on this computer.',
});

const runPasteCommand = async (
  options: RunProcessOptions,
  processRunner: NonNullable<CursorInsertionOptions['processRunner']>,
): Promise<ProcessResult> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PASTE_TIMEOUT_MS);
  try {
    return await processRunner({ ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
};

/**
 * Copies trusted transcript text and asks the operating system to paste it into
 * the currently focused control. User text is never placed in a command line;
 * the native command only sends the fixed platform paste shortcut.
 */
export const insertTextAtCursor = async (
  text: string,
  options: CursorInsertionOptions,
): Promise<InsertDictationTextResult> => {
  const normalized = text.trim();
  if (!normalized) {
    return {
      outcome: 'failed',
      reason: 'No spoken text was available to insert.',
    };
  }

  try {
    options.writeClipboardText(normalized);
  } catch {
    return {
      outcome: 'failed',
      reason: 'Sotto could not copy the completed dictation.',
    };
  }

  const platform = options.platform ?? process.platform;
  const processRunner = options.processRunner ?? runProcess;
  try {
    if (platform === 'darwin') {
      if (!options.isMacAccessibilityTrusted?.()) {
        return copiedResult(platform);
      }
      const result = await runPasteCommand(
        {
          executable: '/usr/bin/osascript',
          args: ['-e', MACOS_PASTE_SCRIPT],
          maxDiagnosticBytes: 4 * 1_024,
        },
        processRunner,
      );
      return result.exitCode === 0
        ? { outcome: 'inserted' }
        : copiedResult(platform);
    }

    if (platform === 'win32') {
      const windowsRoot = options.windowsRoot ?? process.env.SystemRoot;
      if (!windowsRoot || !path.win32.isAbsolute(windowsRoot)) {
        return copiedResult(platform);
      }
      const result = await runPasteCommand(
        {
          executable: path.win32.join(
            windowsRoot,
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'powershell.exe',
          ),
          args: [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-WindowStyle',
            'Hidden',
            '-Command',
            WINDOWS_PASTE_SCRIPT,
          ],
          maxDiagnosticBytes: 4 * 1_024,
        },
        processRunner,
      );
      return result.exitCode === 0
        ? { outcome: 'inserted' }
        : copiedResult(platform);
    }
  } catch {
    return copiedResult(platform);
  }

  return copiedResult(platform);
};
