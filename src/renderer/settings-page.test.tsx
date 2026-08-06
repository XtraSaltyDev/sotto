import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { formatModelSize, modelDescription, SettingsPage } from './SettingsPage';

describe('SettingsPage', () => {
  it('renders selectable settings sections with Appearance selected first', () => {
    const markup = renderToStaticMarkup(<SettingsPage theme="dark" />);

    expect(markup).toContain('Make Sotto work your way');
    expect(markup.match(/role="tab"/g)).toHaveLength(4);
    expect(markup).toContain('Settings sections');
    expect(markup).toContain('Appearance');
    expect(markup).toContain('Transcription');
    expect(markup).toContain('Storage');
    expect(markup).toContain('Shortcuts');
    expect(markup).toContain('Choose how Sotto looks');
    expect(markup).toContain('aria-pressed="true"');
  });

  it('keeps the existing transcription controls in their own section', () => {
    const markup = renderToStaticMarkup(
      <SettingsPage initialSection="transcription" />,
    );

    expect(markup).toContain('Shape the words Sotto hears');
    expect(markup).toContain('Spoken language');
    expect(markup).toContain('Custom vocabulary');
    expect(markup).toContain('Save vocabulary');
  });

  it('separates local files and the global shortcut', () => {
    const storageMarkup = renderToStaticMarkup(
      <SettingsPage initialSection="storage" />,
    );
    const shortcutsMarkup = renderToStaticMarkup(
      <SettingsPage initialSection="shortcuts" />,
    );

    expect(storageMarkup).toContain('Open transcripts folder');
    expect(storageMarkup).toContain('Open models folder');
    expect(shortcutsMarkup).toContain('Start or stop dictation');
    expect(shortcutsMarkup).toContain('⌘⇧D');
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
