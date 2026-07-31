import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  formatUpdateProgress,
  formatUpdateSize,
  shouldOfferUpdate,
  UpdateNotice,
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
        state={{
          phase: 'downloaded',
          fileName: 'Sotto-0.2.0-arm64.dmg',
          version: '0.2.0',
        }}
      />,
    );

    expect(markup).toContain('Update ready to install');
    expect(markup).toContain('Sotto-0.2.0-arm64.dmg');
    expect(markup).toContain('Downloads folder');
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
