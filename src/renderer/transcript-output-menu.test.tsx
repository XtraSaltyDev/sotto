import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { TranscriptOutputMenus } from './TranscriptView';

describe('TranscriptOutputMenus', () => {
  it('consolidates copy and downloads into one keyboard-friendly Share menu', () => {
    const markup = renderToStaticMarkup(
      <TranscriptOutputMenus
        hasRecording
        onCopy={vi.fn()}
        onExport={vi.fn()}
        onExportRecording={vi.fn()}
      />,
    );

    expect(markup.match(/<details/g)).toHaveLength(1);
    expect(markup).toContain('<summary');
    expect(markup).toContain('Open sharing options');
    expect(markup).toContain('<span>Share</span>');
    expect(markup).toContain('aria-label="Copy summary content"');
    expect(markup).toContain('aria-label="Download meeting files"');
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
