import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  formatUpdateProgress,
  formatUpdateSize,
  shouldOfferUpdate,
  UpdateBadge,
  UpdateNotice,
  UpdatePopup,
  updateProgressPercent,
} from './UpdateNotice';

describe('UpdateNotice', () => {
  it('offers a download when a new version is available', () => {
    const markup = renderToStaticMarkup(
      <UpdateNotice
        onDismiss={vi.fn()}
        onDownload={vi.fn()}
        state={{ phase: 'available', version: '0.2.0', size: 626321192 }}
      />,
    );

    expect(markup).toContain('Sotto 0.2.0 is available');
    expect(markup).toContain('597 MB');
    expect(markup).toContain('>Update<');
    expect(markup).toContain('Not now');
    expect(markup).toContain('role="status"');
  });

  it('explains the install step after a completed download', () => {
    const markup = renderToStaticMarkup(
      <UpdateNotice
        onDismiss={vi.fn()}
        onDownload={vi.fn()}
        onRevealDownloaded={vi.fn()}
        state={{
          phase: 'downloaded',
          fileName: 'Sotto-0.2.0-arm64.dmg',
          version: '0.2.0',
        }}
      />,
    );

    expect(markup).toContain('Update ready to install');
    expect(markup).toContain('Sotto-0.2.0-arm64.dmg');
    expect(markup).toContain('in Downloads');
    expect(markup).toContain('Show in Finder');
    expect(markup).toContain('replace Sotto in Applications');
  });

  it('shows download progress and a cancel action', () => {
    const markup = renderToStaticMarkup(
      <UpdateNotice
        onCancel={vi.fn()}
        onDismiss={vi.fn()}
        onDownload={vi.fn()}
        state={{
          phase: 'downloading',
          receivedBytes: 50,
          totalBytes: 100,
          version: '0.2.0',
        }}
      />,
    );

    expect(markup).toContain('Downloading Sotto 0.2.0… 50%');
    expect(markup).toContain('>Cancel<');
  });

  it('shows archive verification before offering a restart', () => {
    const markup = renderToStaticMarkup(
      <UpdateNotice
        onDismiss={vi.fn()}
        onDownload={vi.fn()}
        state={{ phase: 'preparing', version: '0.2.0' }}
      />,
    );

    expect(markup).toContain('Verifying and preparing Sotto 0.2.0');
  });

  it('offers a retry after a canceled update', () => {
    const markup = renderToStaticMarkup(
      <UpdateNotice
        onDismiss={vi.fn()}
        onDownload={vi.fn()}
        state={{ phase: 'cancelled', version: '0.2.0' }}
      />,
    );

    expect(markup).toContain('Update canceled');
    expect(markup).toContain('No changes were made');
    expect(markup).toContain('>Try again<');
  });

  it('offers a retry after a failed download', () => {
    const markup = renderToStaticMarkup(
      <UpdateNotice
        onDismiss={vi.fn()}
        onDownload={vi.fn()}
        state={{ phase: 'failed', reason: 'The update download ended early.', version: '0.2.0' }}
      />,
    );

    expect(markup).toContain('Update download failed');
    expect(markup).toContain('The update download ended early.');
    expect(markup).toContain('Retry');
    expect(markup).toContain('update-notice--failed');
  });

  it('asks for a restart once an update is staged', () => {
    const markup = renderToStaticMarkup(
      <UpdateNotice
        onDismiss={vi.fn()}
        onDownload={vi.fn()}
        onInstall={vi.fn()}
        state={{ phase: 'ready', version: '0.2.0' }}
      />,
    );

    expect(markup).toContain('Restart to finish updating');
    expect(markup).toContain('Sotto 0.2.0 is ready');
    expect(markup).toContain('Restart now');
    expect(markup).toContain('Later');
  });

  it('shows install progress while restarting', () => {
    const markup = renderToStaticMarkup(
      <UpdateNotice
        onDismiss={vi.fn()}
        onDownload={vi.fn()}
        state={{ phase: 'restarting', version: '0.2.0' }}
      />,
    );

    expect(markup).toContain('Installing Sotto 0.2.0');
  });

  it('confirms the current version after a manual check', () => {
    const markup = renderToStaticMarkup(
      <UpdateNotice
        onDismiss={vi.fn()}
        onDownload={vi.fn()}
        state={{ phase: 'up-to-date', version: '0.1.10' }}
      />,
    );

    expect(markup).toContain('Sotto is up to date');
    expect(markup).toContain('0.1.10');
    expect(markup).toContain('Done');
  });

  it('reports an unreachable update server after a manual check', () => {
    const markup = renderToStaticMarkup(
      <UpdateNotice
        onDismiss={vi.fn()}
        onDownload={vi.fn()}
        state={{
          phase: 'check-failed',
          reason: 'The update server did not respond in time.',
        }}
      />,
    );

    expect(markup).toContain('Could not check for updates');
    expect(markup).toContain('The update server did not respond in time.');
    expect(markup).toContain('update-notice--failed');
  });

  it('suppresses only the dismissed version', () => {
    expect(shouldOfferUpdate('0.2.0', '0.2.0')).toBe(false);
    expect(shouldOfferUpdate('0.2.1', '0.2.0')).toBe(true);
    expect(shouldOfferUpdate('0.2.0', null)).toBe(true);
  });

  it('rounds artifact sizes to whole megabytes', () => {
    expect(formatUpdateSize(626321192)).toBe('597 MB');
    expect(formatUpdateSize(1024)).toBe('1 MB');
  });

  it('formats download progress safely', () => {
    expect(formatUpdateProgress(0, 100)).toBe('0%');
    expect(formatUpdateProgress(50, 100)).toBe('50%');
    expect(formatUpdateProgress(200, 100)).toBe('100%');
    expect(formatUpdateProgress(0, 0)).toBe('Starting…');
  });
});

describe('UpdateBadge', () => {
  it('shows a compact badge with a hover label while an update is available', () => {
    const markup = renderToStaticMarkup(
      <UpdateBadge
        onOpen={vi.fn()}
        state={{ phase: 'available', version: '0.2.0', size: 626321192 }}
      />,
    );

    expect(markup).toContain('update-badge');
    expect(markup).toContain('aria-label="Sotto update: Update"');
    expect(markup).toContain('<span class="update-badge__label">Update</span>');
  });

  it('switches the badge to Restart once the update is staged', () => {
    const markup = renderToStaticMarkup(
      <UpdateBadge onOpen={vi.fn()} state={{ phase: 'ready', version: '0.2.0' }} />,
    );

    expect(markup).toContain('update-badge--ready');
    expect(markup).toContain('Restart');
  });

  it('renders nothing for manual-check outcomes', () => {
    expect(
      renderToStaticMarkup(
        <UpdateBadge
          onOpen={vi.fn()}
          state={{ phase: 'up-to-date', version: '0.2.0' }}
        />,
      ),
    ).toBe('');
  });
});

describe('UpdatePopup', () => {
  const handlers = {
    onCancel: vi.fn(),
    onClose: vi.fn(),
    onDismiss: vi.fn(),
    onDownload: vi.fn(),
    onInstall: vi.fn(),
    onRevealDownloaded: vi.fn(),
  };

  it('shows a determinate progress bar while downloading', () => {
    const markup = renderToStaticMarkup(
      <UpdatePopup
        {...handlers}
        state={{
          phase: 'downloading',
          version: '0.2.0',
          receivedBytes: 313160596,
          totalBytes: 626321192,
        }}
      />,
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuenow="50"');
    expect(markup).toContain('width:50%');
    expect(markup).toContain('50% of 597 MB');
    expect(markup).toContain('Cancel');
  });

  it('offers Restart now when the update is staged', () => {
    const markup = renderToStaticMarkup(
      <UpdatePopup {...handlers} state={{ phase: 'ready', version: '0.2.0' }} />,
    );

    expect(markup).toContain('Restart to finish updating');
    expect(markup).toContain('Restart now');
    expect(markup).toContain('Later');
  });

  it('offers a retry after a failure', () => {
    const markup = renderToStaticMarkup(
      <UpdatePopup
        {...handlers}
        state={{
          phase: 'failed',
          reason: 'The update download ended early.',
          version: '0.2.0',
        }}
      />,
    );

    expect(markup).toContain('Update failed');
    expect(markup).toContain('Retry');
  });

  it('keeps the manual DMG available after download', () => {
    const markup = renderToStaticMarkup(
      <UpdatePopup
        {...handlers}
        state={{
          phase: 'downloaded',
          fileName: 'Sotto-0.1.29-arm64.dmg',
          version: '0.1.29',
        }}
      />,
    );

    expect(markup).toContain('Show in Finder');
    expect(markup).toContain('open the DMG');
    expect(markup).toContain('replace Sotto in Applications');
  });

  it('clamps progress percentages and reports unknown totals as null', () => {
    expect(updateProgressPercent(50, 100)).toBe(50);
    expect(updateProgressPercent(200, 100)).toBe(100);
    expect(updateProgressPercent(10, 0)).toBeNull();
  });
});
