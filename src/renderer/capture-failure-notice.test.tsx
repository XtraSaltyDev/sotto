import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { CaptureFailureNotice, isFailureNoticeMessage } from './App';

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

  it('does not style successful output feedback as a failure', () => {
    expect(isFailureNoticeMessage('Complete meeting minutes copied.')).toBe(false);
    expect(isFailureNoticeMessage('Sotto could not copy that meeting output.')).toBe(true);
  });
});
