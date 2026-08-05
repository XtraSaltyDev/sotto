import type {
  AppUpdateProgress,
  CheckForAppUpdateResult,
  DownloadAppUpdateResult,
} from '../shared/contracts';
import type { AppUpdateNoticeState } from './UpdateNotice';

/**
 * The update notice's transition rules, kept apart from the effects that
 * observe the main process. Every rule here protects work the user already
 * started — a background poll or a late progress event must never replace a
 * download or a staged install with something staler.
 */

const IN_PROGRESS_PHASES: ReadonlySet<AppUpdateNoticeState['phase']> = new Set([
  'downloading',
  'preparing',
  'ready',
  'restarting',
]);

const PROGRESS_ADOPTING_PHASES: ReadonlySet<AppUpdateNoticeState['phase']> =
  new Set(['available', 'downloading', 'preparing']);

/**
 * A background poll found a release. It may only raise a fresh offer; it never
 * disturbs a notice the user is already acting on.
 */
export const updateStateFromBackgroundCheck = (
  current: AppUpdateNoticeState | null,
  available: { version: string; size: number },
): AppUpdateNoticeState =>
  current && current.phase !== 'available'
    ? current
    : { phase: 'available', version: available.version, size: available.size };

/**
 * An explicit menu check. Returns the popup decision alongside the state so
 * opening it stays a caller's action rather than a side effect performed
 * inside a state updater, which React may invoke more than once.
 */
export const updateStateFromManualCheck = (
  current: AppUpdateNoticeState | null,
  result: CheckForAppUpdateResult,
): { state: AppUpdateNoticeState | null; openPopup: boolean } => {
  if (current && IN_PROGRESS_PHASES.has(current.phase)) {
    return { state: current, openPopup: false };
  }
  if (result.outcome === 'update-available') {
    // An explicit check deserves an immediate, visible answer.
    return {
      state: {
        phase: 'available',
        version: result.update.version,
        size: result.update.size,
      },
      openPopup: true,
    };
  }
  return {
    state:
      result.outcome === 'up-to-date'
        ? { phase: 'up-to-date', version: result.version }
        : { phase: 'check-failed', reason: result.reason },
    openPopup: false,
  };
};

/**
 * Download progress is adopted only while this exact version is the one being
 * offered or fetched, so a stale event from an abandoned attempt cannot revive
 * a dismissed notice or overwrite a finished one.
 */
export const updateStateFromProgress = (
  current: AppUpdateNoticeState | null,
  progress: AppUpdateProgress,
): AppUpdateNoticeState | null => {
  if (
    !current ||
    current.phase === 'check-failed' ||
    current.version !== progress.version ||
    !PROGRESS_ADOPTING_PHASES.has(current.phase)
  ) {
    return current;
  }
  return progress.phase === 'preparing'
    ? { phase: 'preparing', version: progress.version }
    : {
        phase: 'downloading',
        version: progress.version,
        receivedBytes: progress.receivedBytes,
        totalBytes: progress.totalBytes,
      };
};

export const updateStateFromDownloadResult = (
  result: DownloadAppUpdateResult,
  requestedVersion: string,
): AppUpdateNoticeState => {
  if (result.outcome === 'staged') {
    return { phase: 'ready', version: result.version };
  }
  if (result.outcome === 'cancelled') {
    return { phase: 'cancelled', version: result.version };
  }
  if (result.outcome === 'downloaded') {
    return {
      phase: 'downloaded',
      fileName: result.fileName,
      version: result.version,
    };
  }
  return { phase: 'failed', reason: result.reason, version: requestedVersion };
};
