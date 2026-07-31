import { describe, expect, it } from 'vitest';

import { appThemeFromPreference, nextAppTheme } from './theme';

describe('app theme preference', () => {
  it('honors a saved light or dark preference', () => {
    expect(appThemeFromPreference('light', true)).toBe('light');
    expect(appThemeFromPreference('dark', false)).toBe('dark');
  });

  it('uses the operating system preference when no theme is saved', () => {
    expect(appThemeFromPreference(null, true)).toBe('dark');
    expect(appThemeFromPreference('unknown', false)).toBe('light');
  });

  it('toggles between light and dark mode', () => {
    expect(nextAppTheme('light')).toBe('dark');
    expect(nextAppTheme('dark')).toBe('light');
  });
});
