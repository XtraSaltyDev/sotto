import { describe, expect, it } from 'vitest';

import {
  updateStateFromBackgroundCheck,
  updateStateFromDownloadResult,
  updateStateFromManualCheck,
  updateStateFromProgress,
} from './app-update-state';
import type { AppUpdateNoticeState } from './UpdateNotice';

const AVAILABLE = { version: '0.2.0', publishedAt: null, size: 626_321_192 };

describe('updateStateFromBackgroundCheck', () => {
  it('raises an offer when nothing is showing', () => {
    expect(updateStateFromBackgroundCheck(null, AVAILABLE)).toEqual({
      phase: 'available',
      version: '0.2.0',
      size: 626_321_192,
    });
  });

  it('refreshes an offer the user has not acted on', () => {
    expect(updateStateFromBackgroundCheck(
      { phase: 'available', version: '0.1.9', size: 10 },
      AVAILABLE,
    )).toEqual({ phase: 'available', version: '0.2.0', size: 626_321_192 });
  });

  it.each<AppUpdateNoticeState>([
    { phase: 'downloading', version: '0.1.9', receivedBytes: 5, totalBytes: 10 },
    { phase: 'preparing', version: '0.1.9' },
    { phase: 'ready', version: '0.1.9' },
    { phase: 'restarting', version: '0.1.9' },
    { phase: 'downloaded', fileName: 'Sotto.dmg', version: '0.1.9' },
  ])('never disturbs work already underway ($phase)', (current) => {
    // A six-hourly poll must not interrupt a download the user started.
    expect(updateStateFromBackgroundCheck(current, AVAILABLE)).toBe(current);
  });
});

describe('updateStateFromManualCheck', () => {
  it('answers an explicit check by offering and opening the popup', () => {
    expect(updateStateFromManualCheck(null, {
      outcome: 'update-available',
      update: AVAILABLE,
    })).toEqual({
      state: { phase: 'available', version: '0.2.0', size: 626_321_192 },
      openPopup: true,
    });
  });

  it('reports an up-to-date result without opening the popup', () => {
    expect(updateStateFromManualCheck(null, {
      outcome: 'up-to-date',
      version: '0.1.21',
    })).toEqual({
      state: { phase: 'up-to-date', version: '0.1.21' },
      openPopup: false,
    });
  });

  it('reports a failed check', () => {
    expect(updateStateFromManualCheck(null, {
      outcome: 'unavailable',
      reason: 'The update server is unreachable.',
    })).toEqual({
      state: { phase: 'check-failed', reason: 'The update server is unreachable.' },
      openPopup: false,
    });
  });

  it.each<AppUpdateNoticeState>([
    { phase: 'downloading', version: '0.1.9', receivedBytes: 5, totalBytes: 10 },
    { phase: 'preparing', version: '0.1.9' },
    { phase: 'ready', version: '0.1.9' },
    { phase: 'restarting', version: '0.1.9' },
  ])('leaves work underway alone and stays quiet ($phase)', (current) => {
    expect(updateStateFromManualCheck(current, {
      outcome: 'update-available',
      update: AVAILABLE,
    })).toEqual({ state: current, openPopup: false });
  });
});

describe('updateStateFromProgress', () => {
  const offered: AppUpdateNoticeState = {
    phase: 'available',
    version: '0.2.0',
    size: 100,
  };

  it('adopts progress for the version being offered', () => {
    expect(updateStateFromProgress(offered, {
      phase: 'downloading',
      version: '0.2.0',
      receivedBytes: 40,
      totalBytes: 100,
    })).toEqual({
      phase: 'downloading',
      version: '0.2.0',
      receivedBytes: 40,
      totalBytes: 100,
    });
  });

  it('moves to preparing when the download finishes', () => {
    expect(updateStateFromProgress(offered, {
      phase: 'preparing',
      version: '0.2.0',
    })).toEqual({ phase: 'preparing', version: '0.2.0' });
  });

  it('ignores progress for a different version', () => {
    // A late event from an abandoned attempt must not revive it.
    expect(updateStateFromProgress(offered, {
      phase: 'downloading',
      version: '0.1.9',
      receivedBytes: 40,
      totalBytes: 100,
    })).toBe(offered);
  });

  it('adopts a newer version when a retry starts from a refreshed manifest', () => {
    const retrying: AppUpdateNoticeState = {
      phase: 'downloading',
      version: '0.2.0',
      receivedBytes: 0,
      totalBytes: 100,
    };

    expect(updateStateFromProgress(retrying, {
      phase: 'downloading',
      version: '0.2.1',
      receivedBytes: 0,
      totalBytes: 120,
    })).toEqual({
      phase: 'downloading',
      version: '0.2.1',
      receivedBytes: 0,
      totalBytes: 120,
    });
  });

  it('ignores progress when nothing is showing', () => {
    expect(updateStateFromProgress(null, {
      phase: 'downloading',
      version: '0.2.0',
      receivedBytes: 40,
      totalBytes: 100,
    })).toBeNull();
  });

  it.each<AppUpdateNoticeState>([
    { phase: 'ready', version: '0.2.0' },
    { phase: 'restarting', version: '0.2.0' },
    { phase: 'cancelled', version: '0.2.0' },
    { phase: 'downloaded', fileName: 'Sotto.dmg', version: '0.2.0' },
    { phase: 'failed', reason: 'disk full', version: '0.2.0' },
  ])('does not reopen a settled notice ($phase)', (current) => {
    expect(updateStateFromProgress(current, {
      phase: 'downloading',
      version: '0.2.0',
      receivedBytes: 40,
      totalBytes: 100,
    })).toBe(current);
  });
});

describe('updateStateFromDownloadResult', () => {
  it('maps each outcome, keeping the requested version when one is not returned', () => {
    expect(updateStateFromDownloadResult(
      { outcome: 'staged', version: '0.2.0' },
      '0.2.0',
    )).toEqual({ phase: 'ready', version: '0.2.0' });

    expect(updateStateFromDownloadResult(
      { outcome: 'cancelled', version: '0.2.0' },
      '0.2.0',
    )).toEqual({ phase: 'cancelled', version: '0.2.0' });

    expect(updateStateFromDownloadResult(
      {
      outcome: 'downloaded',
      fileName: 'Sotto-0.2.0.dmg',
      version: '0.2.0',
      },
      '0.2.0',
    )).toEqual({
      phase: 'downloaded',
      fileName: 'Sotto-0.2.0.dmg',
      version: '0.2.0',
    });

    expect(updateStateFromDownloadResult(
      { outcome: 'failed', reason: 'The download was interrupted.' },
      '0.2.0',
    )).toEqual({
      phase: 'failed',
      reason: 'The download was interrupted.',
      version: '0.2.0',
    });
  });
});
