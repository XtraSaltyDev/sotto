import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  Menu,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  systemPreferences,
} from 'electron';
import started from 'electron-squirrel-startup';

import {
  IPC_CHANNELS,
  type ActivityMode,
  type AppState,
  type LiveRecordingCapability,
} from './shared/contracts';

import { AppController } from './main/app-controller';
import { buildMacAppMenuTemplate } from './main/app-menu';
import { registerDesktopIpc } from './main/ipc/register-desktop-ipc';
import {
  configureMacDesktopAudioFallback,
  MACOS_SCREEN_RECORDING_SETTINGS_URLS,
  resolveLiveRecordingCapability,
} from './main/recording/desktop-audio-capture';
import { requestMacScreenRecordingAccess } from './main/recording/macos-screen-recording-access';
import { resolveEngineRuntime } from './main/runtime/engine-runtime';
import { TranscriptRepository } from './main/storage/transcript-repository';
import { createPlaybackResponse } from './main/media/playback-response';
import { LocalAiConnectionService } from './main/local-ai/local-ai-connection';
import {
  shouldRestoreActivityWindow,
} from './main/activity-window-state';
import {
  DEFAULT_SOTTO_UPDATE_MANIFEST_URL,
  UpdateService,
  updatePlatformKey,
} from './main/updates/update-service';
import { loadUpdateConfiguration } from './main/updates/update-config.cjs';
import {
  consumePendingPermissionRepair,
  markPendingPermissionRepair,
} from './main/updates/post-update-permissions';
import {
  AppSettingsStore,
  listTranscriptionModels,
  resolveTranscriptionOptions,
} from './main/settings/app-settings';

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

let mainWindow: BrowserWindow | null = null;
let activityWindow: BrowserWindow | null = null;
let controller: AppController | null = null;
let removeIpcHandlers: (() => void) | null = null;
let shutdownStarted = false;
let readyToQuit = false;
let activityMode: ActivityMode | null = null;
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

const enumerateDesktopCaptureSources = () =>
  desktopCapturer.getSources({
    fetchWindowIcons: false,
    // A non-zero thumbnail makes macOS request Screen & System Audio
    // Recording access before Chromium tries to open the display stream.
    // One pixel is sufficient and avoids retaining a useful screen image.
    thumbnailSize: { height: 1, width: 1 },
    types: ['screen'],
  });

const configureDesktopAudioCapture = (): void => {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return;

  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    void enumerateDesktopCaptureSources()
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

const createWindow = (showWhenReady = true): BrowserWindow => {
  const window = new BrowserWindow({
    title: 'Sotto',
    backgroundColor: '#f7f5f1',
    height: 800,
    minHeight: 600,
    minWidth: 720,
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
  window.on('close', (event) => {
    if (activityMode !== null && !readyToQuit) {
      event.preventDefault();
      window.hide();
    }
  });
  if (showWhenReady) {
    window.once('ready-to-show', () => window.show());
  }
  window.once('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  void window.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
  return window;
};

const positionActivityWindow = (window: BrowserWindow): void => {
  const workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const [width, height] = window.getSize();
  const margin = 20;
  window.setPosition(
    Math.max(workArea.x + margin, workArea.x + workArea.width - width - margin),
    workArea.y + margin,
  );
  if (height > workArea.height - margin * 2) {
    window.setSize(width, Math.max(100, workArea.height - margin * 2));
  }
};

const showActivityWindow = (): void => {
  const window = activityWindow;
  if (!window || window.isDestroyed() || activityMode === null) return;
  positionActivityWindow(window);
  if (!window.webContents.isLoadingMainFrame()) window.showInactive();
};

const createActivityWindow = (): BrowserWindow => {
  const window = new BrowserWindow({
    title: 'Sotto activity',
    backgroundColor: '#fffefb',
    frame: false,
    height: 142,
    minimizable: false,
    movable: true,
    resizable: false,
    show: false,
    skipTaskbar: true,
    width: 420,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      sandbox: true,
      backgroundThrottling: false,
      webSecurity: true,
    },
  });

  activityWindow = window;
  window.setAlwaysOnTop(true, 'floating');
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault();
  });
  window.on('close', (event) => {
    if (activityMode !== null && !readyToQuit) event.preventDefault();
  });
  window.once('ready-to-show', showActivityWindow);
  window.once('closed', () => {
    if (activityWindow === window) activityWindow = null;
  });
  void window.loadURL(`${MAIN_WINDOW_WEBPACK_ENTRY}?window=activity`);
  return window;
};

const collapseForActivity = (mode: ActivityMode): void => {
  activityMode = mode;

  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  const window = activityWindow ?? createActivityWindow();
  showActivityWindow();
  if (window.isMinimized()) window.restore();
};

const restoreMainWindow = (): void => {
  activityMode = null;
  if (activityWindow && !activityWindow.isDestroyed()) activityWindow.hide();

  const window = mainWindow ?? (controller ? createWindow(false) : null);
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
};

const handleControllerStateChanged = (state: AppState): void => {
  const mode = activityMode;
  if (!mode || !shouldRestoreActivityWindow(mode, state)) return;
  restoreMainWindow();
};

const requestDictationToggle = (): void => {
  const window = mainWindow ?? (controller ? createWindow(false) : null);
  if (!window || window.isDestroyed()) return;

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
  const settingsStore = new AppSettingsStore(
    path.join(app.getPath('userData'), 'settings.json'),
  );
  await settingsStore.load();
  const userModelsDirectory = path.join(app.getPath('userData'), 'models');
  await mkdir(userModelsDirectory, { recursive: true }).catch(() => undefined);
  const bundledModelsDirectory = runtimeStatus.ready
    ? path.dirname(runtimeStatus.runtime.modelPath)
    : path.join(process.resourcesPath, 'models');
  const resolveTranscription = async () => {
    const models = await listTranscriptionModels(
      bundledModelsDirectory,
      userModelsDirectory,
    );
    const resolved = resolveTranscriptionOptions(
      settingsStore.get(),
      models,
      runtimeStatus.ready
        ? runtimeStatus.runtime.modelPath
        : path.join(bundledModelsDirectory, 'ggml-small.en.bin'),
    );
    return { modelPath: resolved.modelPath, language: resolved.language };
  };

  controller = new AppController(
    repository,
    runtimeStatus,
    path.join(app.getPath('userData'), 'jobs'),
    liveRecordingCapability,
    resolveTranscription,
  );
  await controller.initialize();
  const localAiService = new LocalAiConnectionService({
    filePath: path.join(app.getPath('userData'), 'local-ai', 'connection.json'),
    credentialCipher: {
      encrypt: (value) => {
        if (!safeStorage.isEncryptionAvailable()) {
          throw new Error('Secure API-key storage is not available on this computer.');
        }
        return safeStorage.encryptString(value).toString('base64');
      },
      decrypt: (value) => {
        if (!safeStorage.isEncryptionAvailable()) {
          throw new Error('The saved API key cannot be unlocked on this computer.');
        }
        return safeStorage.decryptString(Buffer.from(value, 'base64'));
      },
    },
  });

  // The installed bundle is replaceable only for a packaged macOS build
  // running from a normal .app location (never from a read-only DMG).
  const bundlePath = path.resolve(process.execPath, '..', '..', '..');
  const installedAppPath =
    app.isPackaged &&
    process.platform === 'darwin' &&
    bundlePath.endsWith('.app') &&
    !bundlePath.startsWith('/Volumes/')
      ? bundlePath
      : null;
  const updateConfigurationPath = app.isPackaged
    ? path.join(process.resourcesPath, 'sotto-update-config.json')
    : process.env.SOTTO_UPDATE_CONFIG_FILE ?? null;
  const updateConfiguration = await loadUpdateConfiguration(
    updateConfigurationPath,
  ).catch((error: unknown) => {
    console.warn(
      '[sotto] Secure updates are disabled because the embedded update configuration is invalid.',
      error,
    );
    return null;
  });
  const updateService = new UpdateService({
    manifestUrl:
      updateConfiguration?.manifestUrl ?? DEFAULT_SOTTO_UPDATE_MANIFEST_URL,
    trustedManifestKeys:
      updateConfiguration?.trustedManifestKeys ?? {},
    currentVersion: app.getVersion(),
    platformKey: updatePlatformKey(process.platform, process.arch),
    downloadsDirectory: app.getPath('downloads'),
    stagingDirectory: path.join(app.getPath('userData'), 'updates'),
    installedAppPath,
    onProgress: (progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.appUpdateProgress, progress);
      }
    },
  });

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

  const repairRecordingPermissions = async (): Promise<
    'native-requested' | 'settings-opened'
  > => {
    const granted = await requestMacScreenRecordingAccess({
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    });
    if (!granted) {
      await openRecordingSettings();
      return 'settings-opened';
    }

    setTimeout(() => {
      app.relaunch({ args: process.argv.slice(1) });
      app.quit();
    }, 500);
    return 'native-requested';
  };

  removeIpcHandlers = registerDesktopIpc({
    controller,
    localAiService,
    updateService,
    getMainWindow: () => mainWindow,
    getActivityWindow: () => activityWindow,
    collapseForActivity,
    restoreMainWindow,
    onControllerStateChanged: handleControllerStateChanged,
    openRecordingSettings,
    revealDownloadedUpdate: (filePath) => shell.showItemInFolder(filePath),
    relaunchForUpdate: () => {
      // The swapped-in bundle is a new ad-hoc-signed app to macOS, so the
      // next launch must re-request recording access on its own.
      void markPendingPermissionRepair(app.getPath('userData')).catch(
        (error: unknown) => {
          console.warn(
            '[sotto] Could not record the pending permission repair.',
            error,
          );
        },
      );
      // Give the renderer a beat to receive the install result before the
      // process exits and the swapped-in version starts.
      setTimeout(() => {
        app.relaunch();
        app.quit();
      }, 400);
    },
    requestRecordingPermissions: repairRecordingPermissions,
    appSettings: {
      get: async () => {
        const models = await listTranscriptionModels(
          bundledModelsDirectory,
          userModelsDirectory,
        );
        const settings = settingsStore.get();
        const resolved = await resolveTranscription();
        const resolvedModel = models.find(
          (model) => model.path === resolved.modelPath,
        );
        return {
          transcriptionModelId: resolvedModel?.id ?? 'small.en',
          transcriptionLanguage: settings.transcriptionLanguage,
          availableModels: models.map((model) => ({
            id: model.id,
            multilingual: model.multilingual,
            sizeBytes: model.sizeBytes,
            source: model.source,
          })),
          userModelsDirectory,
          dictationShortcut:
            process.platform === 'darwin' ? '⌘⇧D' : 'Ctrl+Shift+D',
        };
      },
      update: async (input) => {
        if (input.transcriptionModelId !== undefined) {
          const models = await listTranscriptionModels(
            bundledModelsDirectory,
            userModelsDirectory,
          );
          if (!models.some((model) => model.id === input.transcriptionModelId)) {
            return {
              outcome: 'rejected' as const,
              reason: 'Choose a model that is available on this computer.',
            };
          }
        }
        await settingsStore.update(input);
        return { outcome: 'updated' as const };
      },
      revealTranscripts: async () => {
        await shell.openPath(path.join(app.getPath('userData'), 'transcripts'));
      },
      revealModels: async () => {
        await shell.openPath(userModelsDirectory);
      },
    },
  });
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        buildMacAppMenuTemplate(app.name, () => {
          void updateService.checkForUpdates().then((result) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.show();
              mainWindow.webContents.send(
                IPC_CHANNELS.manualUpdateCheck,
                result,
              );
            }
          });
        }),
      ),
    );
  }
  // Sweep rollback bundles and staging leftovers from completed updates
  // after launch settles; a failed sweep never affects the next update.
  setTimeout(() => {
    void updateService.cleanupStaleUpdateArtifacts();
  }, 20_000);

  createWindow();
  if (!globalShortcut.register(DICTATION_ACCELERATOR, requestDictationToggle)) {
    console.warn(
      `[sotto] The dictation shortcut ${DICTATION_ACCELERATOR} is already in use.`,
    );
  }

  // First launch after an in-place update: run the recording-permission
  // repair without waiting for a click. The marker is consumed before the
  // repair so the attempt cannot loop across the relaunch the repair
  // itself performs; the OS approval prompt stays the only user step.
  if (process.platform === 'darwin') {
    void consumePendingPermissionRepair(app.getPath('userData'))
      .then((pending) => {
        if (!pending) return;
        if (liveRecordingCapability().state !== 'permission-required') return;
        setTimeout(() => {
          repairRecordingPermissions().catch((error: unknown) => {
            console.warn(
              '[sotto] Automatic post-update permission repair failed.',
              error,
            );
          });
        }, 1_500);
      })
      .catch((error: unknown) => {
        console.warn(
          '[sotto] Could not check for a pending permission repair.',
          error,
        );
      });
  }
};

const shutdown = async (): Promise<void> => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  activityMode = null;
  if (activityWindow && !activityWindow.isDestroyed()) {
    activityWindow.destroy();
  }
  activityWindow = null;
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
  if (activityMode !== null) {
    showActivityWindow();
    return;
  }
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.on('activate', () => {
  if (activityMode !== null) {
    showActivityWindow();
    return;
  }
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
