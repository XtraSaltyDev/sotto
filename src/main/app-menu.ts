import type { MenuItemConstructorOptions } from 'electron';

/**
 * The macOS application menu. Everything is a standard role except the
 * explicit "Check for Updates…" item under the app menu; other platforms
 * keep Electron's default menu.
 */
export const buildMacAppMenuTemplate = (
  appName: string,
  onCheckForUpdates: () => void,
): MenuItemConstructorOptions[] => [
  {
    label: appName,
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      { label: 'Check for Updates…', click: onCheckForUpdates },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  },
  { role: 'fileMenu' },
  { role: 'editMenu' },
  { role: 'viewMenu' },
  { role: 'windowMenu' },
];
