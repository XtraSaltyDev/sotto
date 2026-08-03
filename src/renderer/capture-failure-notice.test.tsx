import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { CaptureFailureNotice, HomeNotice } from './notices';

describe('capture failure notice', () => {
  it('announces a failed Windows capture and offers dismissal', () => {
    const markup = renderToStaticMarkup(
      <CaptureFailureNotice
        message="Sotto could not start Windows system-audio capture. No recording was started."
        onDismiss={vi.fn()}
        platform="Win32"
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Windows audio capture did not start');
    expect(markup).toContain('Dismiss');
  });

  it('announces retained recordings as a status, not an assertive alert', () => {
    const markup = renderToStaticMarkup(
      <CaptureFailureNotice
        message="Sotto could not finish saving the recording, but the closed audio was kept for automatic recovery after restart."
        platform="Win32"
      />,
    );

    expect(markup).toContain('role="status"');
    expect(markup).not.toContain('role="alert"');
    expect(markup).toContain('Your recording was kept');
  });

  it('does not style informational notices as failures', () => {
    const info = renderToStaticMarkup(
      <HomeNotice notice={{ kind: 'info', text: 'Complete meeting minutes copied.' }} />,
    );
    expect(info).toContain('home-status');
    expect(info).not.toContain('capture-notice');

    const error = renderToStaticMarkup(
      <HomeNotice
        notice={{ kind: 'error', text: 'Sotto could not copy that meeting output.' }}
        onDismiss={vi.fn()}
      />,
    );
    expect(error).toContain('capture-notice');
    expect(error).toContain('role="alert"');
  });
});
