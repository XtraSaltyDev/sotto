import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { TranscriptOutputMenus } from './App';

describe('TranscriptOutputMenus', () => {
  it('renders compact native keyboard controls with labeled export and copy actions', () => {
    const markup = renderToStaticMarkup(
      <TranscriptOutputMenus
        hasRecording
        onCopy={vi.fn()}
        onExport={vi.fn()}
        onExportRecording={vi.fn()}
      />,
    );

    expect(markup.match(/<details/g)).toHaveLength(2);
    expect(markup).toContain('<summary');
    expect(markup).toContain('Open transcript export options');
    expect(markup).toContain('Open meeting copy options');
    expect(markup).toContain('Meeting minutes (DOCX)');
    expect(markup).toContain('Subtitles (SRT)');
    expect(markup).toContain('Subtitles (WebVTT)');
    expect(markup).toContain('Portable transcript data (JSON)');
    expect(markup).toContain('Complete meeting minutes');
    expect(markup).toContain('Original recording');
    expect(markup.match(/type="button"/g)).toHaveLength(12);
  });

  it('omits the recording export when no retained original exists', () => {
    const markup = renderToStaticMarkup(
      <TranscriptOutputMenus
        hasRecording={false}
        onCopy={vi.fn()}
        onExport={vi.fn()}
        onExportRecording={vi.fn()}
      />,
    );

    expect(markup).not.toContain('Original recording');
    expect(markup.match(/type="button"/g)).toHaveLength(11);
  });
});
