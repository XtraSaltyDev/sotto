import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { formatModelSize, modelDescription, SettingsPage } from './SettingsPage';

describe('SettingsPage', () => {
  it('renders the transcription, data, and shortcut sections', () => {
    const markup = renderToStaticMarkup(<SettingsPage />);

    expect(markup).toContain('Tune how Sotto works');
    expect(markup).toContain('Transcription');
    expect(markup).toContain('Spoken language');
    expect(markup).toContain('Open the transcripts folder');
    expect(markup).toContain('Open the models folder');
    expect(markup).toContain('Shortcuts');
  });

  it('describes models by capability and origin', () => {
    expect(
      modelDescription({ multilingual: true, source: 'user' }),
    ).toBe('Multilingual · added by you');
    expect(
      modelDescription({ multilingual: false, source: 'bundled' }),
    ).toBe('English only · included with Sotto');
    expect(formatModelSize(487_601_920)).toBe('465 MB');
  });
});
