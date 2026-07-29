import path from 'node:path';

import {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  protocol,
  session,
  shell,
  systemPreferences,
} from 'electron';
import started from 'electron-squirrel-startup';

import {
  IPC_CHANNELS,
  type LiveRecordingCapability,
} from './shared/contracts';

import { AppController } from './main/app-controller';
import { registerDesktopIpc } from './main/ipc/register-desktop-ipc';
import {
  configureMacDesktopAudioFallback,
  MACOS_SCREEN_RECORDING_SETTINGS_URLS,
  resolveLiveRecordingCapability,
} from './main/recording/desktop-audio-capture';
import { repairSottoRecordingPermissions } from './main/recording/recording-permission-reset';
import { resolveEngineRuntime } from './main/runtime/engine-runtime';
import { TranscriptRepository } from './main/storage/transcript-repository';
import { createPlaybackResponse } from './main/media/playback-response';

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

let mainWindow: BrowserWindow | null = null;
let controller: AppController | null = null;
let removeIpcHandlers: (() => void) | null = null;
let shutdownStarted = false;
let readyToQuit = false;
const DICTATION_ACCELERATOR = 'CommandOrControl+Shift+D';

if (started) app.quit();

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'sotto-media',
    privileges: {
      secure: true,
      standard: true,
      stream: true,
      supportFetchAPI: true,
    },
  },
]);

const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();

app.enableSandbox();

// Electron 39+ defaults to Core Audio Tap for macOS desktop loopback audio.
// Apply the documented Screen & System Audio Recording fallback after other
// Electron startup switches are configured, but before app.whenReady().
configureMacDesktopAudioFallback(process.platform, app.commandLine);

const isAllowedNavigation = (url: string): boolean => {
  try {
    const requested = new URL(url);
    const entry = new URL(MAIN_WINDOW_WEBPACK_ENTRY);
    return (
      requested.protocol === entry.protocol &&
      requested.host === entry.host &&
      requested.pathname === entry.pathname
    );
  } catch {
    return false;
  }
};

const liveRecordingCapability = (): LiveRecordingCapability => {
  const systemVersion = (
    process as NodeJS.Process & { getSystemVersion?: () => string }
  ).getSystemVersion?.() ?? '0';
  const screenAccessStatus =
    process.platform === 'darwin'
      ? systemPreferences.getMediaAccessStatus('screen')
      : 'unknown';
  return resolveLiveRecordingCapability(
    process.platform,
    systemVersion,
    screenAccessStatus,
  );
};

const configureDesktopAudioCapture = (): void => {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return;

  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    void desktopCapturer
      .getSources({
        fetchWindowIcons: false,
        // A non-zero thumbnail makes macOS request Screen & System Audio
        // Recording access before Chromium tries to open the display stream.
        // One pixel is sufficient and avoids retaining a useful screen image.
        thumbnailSize: { height: 1, width: 1 },
        types: ['screen'],
      })
      .then((sources) => {
        const source = sources[0];
        if (!source) {
          console.warn('Sotto could not find a macOS desktop capture source.');
          callback({});
          return;
        }

        callback({
          audio: request.audioRequested ? 'loopback' : undefined,
          video: request.videoRequested ? source : undefined,
        });
      })
      .catch((error: unknown) => {
        console.error('Sotto could not enumerate desktop capture sources.', error);
        callback({});
      });
  });
};

const isTrustedMediaRequester = (
  webContents: Electron.WebContents | null,
): boolean =>
  webContents !== null &&
  mainWindow !== null &&
  !mainWindow.isDestroyed() &&
  webContents === mainWindow.webContents &&
  isAllowedNavigation(webContents.getURL());

const createWindow = (): BrowserWindow => {
  const window = new BrowserWindow({
    title: 'Sotto',
    backgroundColor: '#f7f5f1',
    height: 800,
    minHeight: 680,
    minWidth: 920,
    show: false,
    width: 1240,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      sandbox: true,
      // MediaRecorder must continue emitting chunks while Sotto is
      // minimized during a Teams call.
      backgroundThrottling: false,
      webSecurity: true,
    },
  });

  mainWindow = window;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault();
  });
  window.once('ready-to-show', () => window.show());
  window.once('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  void window.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
  return window;
};

const requestDictationToggle = (): void => {
  const window = mainWindow ?? (controller ? createWindow() : null);
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();

  const sendShortcut = (): void => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.dictationShortcut);
    }
  };
  if (window.webContents.isLoadingMainFrame()) {
    window.webContents.once('did-finish-load', sendShortcut);
  } else {
    sendShortcut();
  }
};

const initialize = async (): Promise<void> => {
  configureDesktopAudioCapture();
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      const trusted =
        isTrustedMediaRequester(webContents) &&
        (permission === 'media' || String(permission) === 'display-capture');
      callback(trusted);
    },
  );
  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission) =>
      isTrustedMediaRequester(webContents) &&
      (permission === 'media' || String(permission) === 'display-capture'),
  );

  const runtimeStatus = await resolveEngineRuntime({
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  });
  const repository = new TranscriptRepository(
    path.join(app.getPath('userData'), 'transcripts'),
  );
  controller = new AppController(
    repository,
    runtimeStatus,
    path.join(app.getPath('userData'), 'jobs'),
    liveRecordingCapability,
  );
  await controller.initialize();

  session.defaultSession.protocol.handle('sotto-media', async (request) => {
    if (!controller) return new Response(null, { status: 503 });
    return createPlaybackResponse(request, (transcriptId) =>
      controller?.getPlaybackDescriptor(transcriptId) ?? Promise.resolve(null),
    );
  });

  const openRecordingSettings = async (): Promise<void> => {
    let lastError: unknown = new Error(
      'No macOS screen recording settings route was available.',
    );
    for (const url of MACOS_SCREEN_RECORDING_SETTINGS_URLS) {
      try {
        await shell.openExternal(url, { activate: true });
        return;
      } catch (error: unknown) {
        lastError = error;
      }
    }
    throw lastError;
  };

  removeIpcHandlers = registerDesktopIpc({
    controller,
    getMainWindow: () => mainWindow,
    openRecordingSettings,
    resetRecordingPermissions: async () => {
      await repairSottoRecordingPermissions({
        openSettings: openRecordingSettings,
      });
    },
  });
  createWindow();
  if (!globalShortcut.register(DICTATION_ACCELERATOR, requestDictationToggle)) {
    console.warn(
      `[sotto] The dictation shortcut ${DICTATION_ACCELERATOR} is already in use.`,
    );
  }
};

const shutdown = async (): Promise<void> => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  removeIpcHandlers?.();
  removeIpcHandlers = null;
  globalShortcut.unregister(DICTATION_ACCELERATOR);
  session.defaultSession.protocol.unhandle('sotto-media');
  await controller?.dispose();
};

if (hasInstanceLock && !started) {
  void app.whenReady().then(initialize).catch((error: unknown) => {
    console.error('Sotto failed to initialize its local runtime.', error);
    app.quit();
  });
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && controller) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (readyToQuit || !controller) return;
  event.preventDefault();
  void shutdown().finally(() => {
    readyToQuit = true;
    app.exit(0);
  });
});
