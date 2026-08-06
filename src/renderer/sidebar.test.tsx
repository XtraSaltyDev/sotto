import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { Sidebar } from './Sidebar';

describe('Sidebar appearance control', () => {
  it('renders directly selectable Light and Dark options', () => {
    const markup = renderToStaticMarkup(
      <Sidebar
        currentPage="transcripts"
        onNavigate={vi.fn()}
        onToggleTheme={vi.fn()}
        theme="dark"
      />,
    );

    expect(markup).toContain('Appearance');
    expect(markup).toContain('Choose appearance');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).not.toContain('Switch to light mode');
  });
});
