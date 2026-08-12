import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { ModelProvisioningNotice } from './ModelProvisioningNotice';

describe('ModelProvisioningNotice', () => {
  it('shows byte progress and local-only privacy copy while downloading', () => {
    const markup = renderToStaticMarkup(
      <ModelProvisioningNotice
        status={{
          state: 'downloading',
          message: 'downloading',
          receivedBytes: 500,
          totalBytes: 1024 * 1024 * 1024,
        }}
        onCancel={vi.fn()}
        onImport={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(markup).toContain('Downloading 0 KB of 1.00 GB…');
    expect(markup).toContain('downloaded to this computer');
    expect(markup).toContain('does not upload them');
    expect(markup).toContain('aria-valuenow="500"');
    expect(markup).toContain('>Cancel</button>');
  });

  it('offers retry and offline import for a failed setup', () => {
    const onRetry = vi.fn();
    const onImport = vi.fn();
    const markup = renderToStaticMarkup(
      <ModelProvisioningNotice
        status={{ state: 'failed', message: 'checksum mismatch' }}
        onCancel={vi.fn()}
        onImport={onImport}
        onRetry={onRetry}
      />,
    );

    expect(markup).toContain('>Retry download</button>');
    expect(markup).toContain('>Import matching model</button>');
    expect(onRetry).not.toHaveBeenCalled();
    expect(onImport).not.toHaveBeenCalled();
  });

  it('offers cancellation only during an active download', () => {
    const onCancel = vi.fn();
    const markup = renderToStaticMarkup(
      <ModelProvisioningNotice
        status={{ state: 'downloading', message: 'downloading', receivedBytes: 1, totalBytes: 2 }}
        onCancel={onCancel}
        onImport={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(markup).toContain('>Cancel</button>');
    expect(markup).not.toContain('>Retry download</button>');
    expect(onCancel).not.toHaveBeenCalled();
  });
});
