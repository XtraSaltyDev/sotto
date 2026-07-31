export const THEME_STORAGE_KEY = 'sotto.theme';

export type AppTheme = 'light' | 'dark';

export const appThemeFromPreference = (
  storedTheme: string | null,
  prefersDark: boolean,
): AppTheme => {
  if (storedTheme === 'light' || storedTheme === 'dark') return storedTheme;
  return prefersDark ? 'dark' : 'light';
};

export const nextAppTheme = (theme: AppTheme): AppTheme =>
  theme === 'dark' ? 'light' : 'dark';
