import { describe, expect, it, vi } from 'vitest';

import { buildMacAppMenuTemplate } from './app-menu';

describe('buildMacAppMenuTemplate', () => {
  it('puts Check for Updates in the app menu alongside the standard roles', () => {
    const onCheckForUpdates = vi.fn();
    const template = buildMacAppMenuTemplate('Sotto', onCheckForUpdates);

    const appMenu = template[0];
    expect(appMenu.label).toBe('Sotto');
    const items = appMenu.submenu as { label?: string; role?: string; click?: () => void }[];
    const checkItem = items.find((item) => item.label === 'Check for Updates…');
    expect(checkItem).toBeDefined();
    checkItem?.click?.();
    expect(onCheckForUpdates).toHaveBeenCalledTimes(1);

    expect(items[0]?.role).toBe('about');
    expect(items.at(-1)?.role).toBe('quit');
    expect(template.map((menu) => menu.role)).toEqual([
      undefined,
      'fileMenu',
      'editMenu',
      'viewMenu',
      'windowMenu',
    ]);
  });
});
