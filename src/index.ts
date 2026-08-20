import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  app,
  autoUpdater,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
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
import { DEFAULT_TRANSCRIPTION_MODEL } from './shared/default-transcription-model';

import { AppController } from './main/app-controller';
import { buildMacAppMenuTemplate } from './main/app-menu';
import { registerDesktopIpc } from './main/ipc/register-desktop-ipc';
import {
  configureMacDesktopAudioFallback,
  MACOS_SCREEN_RECORDING_SETTINGS_URLS,
  macOSUsesCoreAudioTap,
  resolveLiveRecordingCapability,
} from './main/recording/desktop-audio-capture';
import { requestMacScreenRecordingAccess } from './main/recording/macos-screen-recording-access';
import { DisplayCaptureAuthorization } from './main/recording/display-capture-authorization';
import { resolveEngineRuntime } from './main/runtime/engine-runtime';
import {
  ManagedModelProvisioner,
  pruneManagedModelRevisions,
} from './main/runtime/managed-model';
import { TranscriptRepository } from './main/storage/transcript-repository';
import { createPlaybackResponse } from './main/media/playback-response';
import { LocalAiConnectionService } from './main/local-ai/local-ai-connection';
import {
  shouldRestoreActivityWindow,
} from './main/activity-window-state';
import {
  activityWindowAlwaysOnTopLevel,
  activityWindowBounds,
} from './main/activity-window-position';
import {
  DEFAULT_SOTTO_UPDATE_MANIFEST_URL,
  UpdateService,
  updatePlatformKey,
} from './main/updates/update-service';
import { loadUpdateConfiguration } from './main/updates/update-config.cjs';
import { createTrustedUpdateFetcher } from './main/updates/update-tls';
import { SquirrelMacUpdateInstaller } from './main/updates/mac-update-installer';
import {
  AppSettingsStore,
  listTranscriptionModels,
  normalizeCustomVocabulary,
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
let activityDisplayId: number | null = null;
let removeActivityDisplayListeners: (() => void) | null = null;
let removeDisplayCaptureAuthorizationHandler: (() => void) | null = null;
const DICTATION_ACCELERATOR = 'CommandOrControl+Shift+D';
const ACTIVITY_WINDOW_SIZE = { height: 116, width: 520 } as const;
const displayCaptureAuthorization = new DisplayCaptureAuthorization();

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
// Keep the older Screen & System Audio Recording path only on macOS versions
// before Core Audio Tap was introduced.
const startupSystemVersion =
  process.platform === 'darwin'
    ? (
        process as NodeJS.Process & { getSystemVersion?: () => string }
      ).getSystemVersion?.() ?? '0'
    : '0';
configureMacDesktopAudioFallback(
  process.platform,
  startupSystemVersion,
  app.commandLine,
);

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
    // Sotto only needs the source identifier. The legacy path uses a one-pixel
    // thumbnail to trigger Screen & System Audio access; Core Audio Tap does
    // not need that extra screen-rendering work on macOS 14.2 and later.
    thumbnailSize:
      process.platform === 'darwin' && !macOSUsesCoreAudioTap(startupSystemVersion)
        ? { height: 1, width: 1 }
        : { height: 0, width: 0 },
    types: ['screen'],
  });

const configureDesktopAudioCapture = (): void => {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return;

  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const expectedFrame =
      mainWindow && !mainWindow.isDestroyed()
        ? mainWindow.webContents.mainFrame
        : null;
    if (!displayCaptureAuthorization.consume(request, expectedFrame)) {
      callback({});
      return;
    }
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
  const display =
    screen.getAllDisplays().find((candidate) => candidate.id === activityDisplayId) ??
    screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  activityDisplayId = display.id;
  window.setBounds(
    activityWindowBounds(display, ACTIVITY_WINDOW_SIZE, process.platform),
    false,
  );
};

const enforceActivityWindowLevel = (window: BrowserWindow): void => {
  if (window.isDestroyed() || activityMode === null) return;
  window.setAlwaysOnTop(
    true,
    activityWindowAlwaysOnTopLevel(process.platform),
  );
  window.moveTop();
};

const showActivityWindow = (): void => {
  const window = activityWindow;
  if (!window || window.isDestroyed() || activityMode === null) return;
  positionActivityWindow(window);
  enforceActivityWindowLevel(window);
  if (!window.webContents.isLoadingMainFrame()) {
    window.showInactive();
    enforceActivityWindowLevel(window);
  }
};

const createActivityWindow = (): BrowserWindow => {
  const window = new BrowserWindow({
    title: 'Sotto activity',
    acceptFirstMouse: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    frame: false,
    fullscreenable: false,
    hasShadow: false,
    height: ACTIVITY_WINDOW_SIZE.height,
    hiddenInMissionControl: true,
    maximizable: false,
    minimizable: false,
    movable: true,
    resizable: false,
    show: false,
    skipTaskbar: true,
    transparent: true,
    width: ACTIVITY_WINDOW_SIZE.width,
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
  if (process.platform === 'darwin') {
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  enforceActivityWindowLevel(window);
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault();
  });
  window.on('close', (event) => {
    if (activityMode !== null && !readyToQuit) event.preventDefault();
  });
  window.on('show', () => enforceActivityWindowLevel(window));
  window.on('blur', () => enforceActivityWindowLevel(window));
  window.on('always-on-top-changed', (_event, isAlwaysOnTop) => {
    if (!isAlwaysOnTop && activityMode !== null) {
      queueMicrotask(() => enforceActivityWindowLevel(window));
    }
  });
  window.once('ready-to-show', showActivityWindow);
  window.once('closed', () => {
    if (activityWindow === window) activityWindow = null;
  });
  void window.loadURL(`${MAIN_WINDOW_WEBPACK_ENTRY}?window=activity`);
  return window;
};

const collapseForActivity = (mode: ActivityMode): void => {
  if (activityMode === null) {
    const display =
      mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()
        ? screen.getDisplayMatching(mainWindow.getBounds())
        : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    activityDisplayId = display.id;
  }
  activityMode = mode;

  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  const window = activityWindow ?? createActivityWindow();
  showActivityWindow();
  if (window.isMinimized()) window.restore();
};

const restoreMainWindow = (): void => {
  activityMode = null;
  activityDisplayId = null;
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
  const authorizeDisplayCapture = (event: Electron.IpcMainEvent): void => {
    const trusted = isTrustedMediaRequester(event.sender) &&
      event.senderFrame === event.sender.mainFrame;
    if (trusted) {
      displayCaptureAuthorization.authorize(event.senderFrame);
    } else {
      displayCaptureAuthorization.clear();
    }
    event.returnValue = trusted;
  };
  ipcMain.on(IPC_CHANNELS.authorizeDisplayCapture, authorizeDisplayCapture);
  removeDisplayCaptureAuthorizationHandler = () => {
    displayCaptureAuthorization.clear();
    ipcMain.removeListener(
      IPC_CHANNELS.authorizeDisplayCapture,
      authorizeDisplayCapture,
    );
  };
  const repositionActivityWindow = (): void => {
    if (activityMode !== null && activityWindow && !activityWindow.isDestroyed()) {
      showActivityWindow();
    }
  };
  screen.on('display-added', repositionActivityWindow);
  screen.on('display-removed', repositionActivityWindow);
  screen.on('display-metrics-changed', repositionActivityWindow);
  removeActivityDisplayListeners = () => {
    screen.off('display-added', repositionActivityWindow);
    screen.off('display-removed', repositionActivityWindow);
    screen.off('display-metrics-changed', repositionActivityWindow);
  };
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

  const userModelsDirectory = path.join(app.getPath('userData'), 'models');
  const managedModelsDirectory = path.join(
    app.getPath('userData'),
    'managed-models',
    DEFAULT_TRANSCRIPTION_MODEL.revision,
  );
  await mkdir(userModelsDirectory, { recursive: true }).catch(() => undefined);
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
  const updateCaPath = app.isPackaged
    ? path.join(process.resourcesPath, 'ca.crt')
    : process.env.SOTTO_UPDATE_CA_FILE ?? null;
  const updateCa = updateCaPath
    ? await readFile(updateCaPath).catch((error: unknown) => {
        console.warn(
          '[sotto] The configured update CA could not be loaded; system trust will be used.',
          error,
        );
        return undefined;
      })
    : undefined;
  const modelProvisioner = app.isPackaged
    ? new ManagedModelProvisioner({
        managedModelsDirectory,
        modelUrl: updateConfiguration?.modelUrl,
        tlsCa: updateCa,
        fetcher: updateCa ? createTrustedUpdateFetcher(updateCa) : undefined,
    })
    : null;
  const repository = new TranscriptRepository(
    path.join(app.getPath('userData'), 'transcripts'),
  );
  const settingsStore = new AppSettingsStore(
    path.join(app.getPath('userData'), 'settings.json'),
  );
  await settingsStore.load();
  const defaultModelsDirectory = app.isPackaged
    ? managedModelsDirectory
    : path.join(
        process.cwd(),
        '.build',
        'runtime',
        `${process.platform}-${process.arch}`,
        'model-artifact',
      );
  const initialModels = await listTranscriptionModels(
    defaultModelsDirectory,
    userModelsDirectory,
  );
  const initialResolved = resolveTranscriptionOptions(
    settingsStore.get(),
    initialModels,
    path.join(defaultModelsDirectory, DEFAULT_TRANSCRIPTION_MODEL.fileName),
  );
  const initialUserModelPath = initialModels.some(
    (model) => model.path === initialResolved.modelPath && model.source === 'user',
  )
    ? initialResolved.modelPath
    : undefined;
  let runtimeStatus = await resolveEngineRuntime({
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    managedModelPath: initialUserModelPath,
  });
  const resolveTranscription = async () => {
    const models = await listTranscriptionModels(
      defaultModelsDirectory,
      userModelsDirectory,
    );
    const resolved = resolveTranscriptionOptions(
      settingsStore.get(),
      models,
      runtimeStatus.ready
        ? runtimeStatus.runtime.modelPath
        : path.join(defaultModelsDirectory, DEFAULT_TRANSCRIPTION_MODEL.fileName),
    );
    return {
      modelPath: resolved.modelPath,
      language: resolved.language,
      customVocabulary: [...settingsStore.get().customVocabulary],
    };
  };

  controller = new AppController(
    repository,
    runtimeStatus,
    path.join(app.getPath('userData'), 'jobs'),
    liveRecordingCapability,
    resolveTranscription,
    modelProvisioner?.getStatus() ??
      (runtimeStatus.ready
        ? { state: 'ready', message: 'The private local transcription model is ready.' }
        : { state: 'required', message: 'Model setup is required before transcription can start.' }),
  );
  // Speaker annotation edits transcripts to build evaluation ground truth. It
  // belongs to development only, so a packaged Sotto never turns it on and its
  // IPC channels refuse regardless of what a renderer asks for.
  if (!app.isPackaged) {
    controller.enableAnnotation();
  }
  await controller.initialize();
  if (modelProvisioner) {
    modelProvisioner.subscribe((status) => {
      controller?.setModelProvisioning(status);
      if (status.state !== 'ready') return;
      void modelProvisioner
        .provision()
        .then(async (modelPath) => {
          runtimeStatus = await resolveEngineRuntime({
            appPath: app.getAppPath(),
            isPackaged: true,
            resourcesPath: process.resourcesPath,
            managedModelPath: modelPath,
          });
          await controller?.setRuntimeStatus(runtimeStatus);
          await pruneManagedModelRevisions({
            managedModelsRoot: path.join(app.getPath('userData'), 'managed-models'),
            currentRevision: DEFAULT_TRANSCRIPTION_MODEL.revision,
            activeModelPaths: [modelPath],
          });
        })
        .catch((error: unknown) => {
          console.warn('[sotto] The verified model could not activate the local engine.', error);
          controller?.setModelProvisioning({
            state: 'failed',
            message: 'The verified model was downloaded but the local engine could not activate it. Retry Sotto model setup.',
          });
        });
    });
  }
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
  const packageCommit = app.isPackaged
    ? await readFile(path.join(process.resourcesPath, 'sotto-build.json'), 'utf8')
        .then((raw) => {
          const receipt = JSON.parse(raw) as { commit?: unknown };
          return typeof receipt.commit === 'string' &&
            /^[0-9a-f]{40}$/u.test(receipt.commit)
            ? receipt.commit
            : undefined;
        })
        .catch(() => undefined)
    : undefined;
  const updateService = new UpdateService({
    manifestUrl:
      updateConfiguration?.manifestUrl ?? DEFAULT_SOTTO_UPDATE_MANIFEST_URL,
    trustedManifestKeys:
      updateConfiguration?.trustedManifestKeys ?? {},
    currentVersion: app.getVersion(),
    currentCommit: packageCommit,
    platformKey: updatePlatformKey(process.platform, process.arch),
    downloadsDirectory: app.getPath('downloads'),
    stagingDirectory: path.join(app.getPath('userData'), 'updates'),
    installedAppPath,
    macUpdateInstaller:
      installedAppPath && process.platform === 'darwin'
        ? new SquirrelMacUpdateInstaller(autoUpdater)
        : undefined,
    tlsCa: updateCa,
    fetcher: updateCa ? createTrustedUpdateFetcher(updateCa) : undefined,
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
    'native-requested' | 'native-prompted'
  > => {
    // Keep Apple's approval prompt in front of the app that requested it.
    // Do not open System Settings from the same action: on macOS the native
    // request can return before the user dismisses its prompt, which would
    // leave Settings covering the prompt and make the repair ambiguous.
    app.focus({ steal: true });
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
    const granted = await requestMacScreenRecordingAccess({
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    });
    if (!granted) {
      return 'native-prompted';
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
    modelProvisioner: modelProvisioner ?? undefined,
    getAppVersion: () => app.getVersion(),
    getMainWindow: () => mainWindow,
    getActivityWindow: () => activityWindow,
    collapseForActivity,
    restoreMainWindow,
    onControllerStateChanged: handleControllerStateChanged,
    openRecordingSettings,
    revealDownloadedUpdate: (filePath) => shell.showItemInFolder(filePath),
    requestRecordingPermissions: repairRecordingPermissions,
    appSettings: {
      get: async () => {
        const models = await listTranscriptionModels(
          defaultModelsDirectory,
          userModelsDirectory,
        );
        const settings = settingsStore.get();
        const resolved = await resolveTranscription();
        const resolvedModel = models.find(
          (model) => model.path === resolved.modelPath,
        );
        return {
          transcriptionModelId: resolvedModel?.id ?? DEFAULT_TRANSCRIPTION_MODEL.id,
          transcriptionLanguage: settings.transcriptionLanguage,
          customVocabulary: [...settings.customVocabulary],
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
            defaultModelsDirectory,
            userModelsDirectory,
          );
          if (!models.some((model) => model.id === input.transcriptionModelId)) {
            return {
              outcome: 'rejected' as const,
              reason: 'Choose a model that is available on this computer.',
            };
          }
        }
        if (input.customVocabulary !== undefined) {
          // The settings store applies the same normalization when it writes;
          // validate here so the renderer gets a useful rejection instead of
          // silently losing a malformed term list.
          try {
            normalizeCustomVocabulary(input.customVocabulary);
          } catch (error) {
            return {
              outcome: 'rejected' as const,
              reason: error instanceof Error ? error.message : 'Enter valid vocabulary.',
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
  if (modelProvisioner) void modelProvisioner.provision().catch(() => undefined);
  if (!globalShortcut.register(DICTATION_ACCELERATOR, requestDictationToggle)) {
    console.warn(
      `[sotto] The dictation shortcut ${DICTATION_ACCELERATOR} is already in use.`,
    );
  }

};

const shutdown = async (): Promise<void> => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  activityMode = null;
  activityDisplayId = null;
  removeActivityDisplayListeners?.();
  removeActivityDisplayListeners = null;
  if (activityWindow && !activityWindow.isDestroyed()) {
    activityWindow.destroy();
  }
  activityWindow = null;
  removeIpcHandlers?.();
  removeIpcHandlers = null;
  removeDisplayCaptureAuthorizationHandler?.();
  removeDisplayCaptureAuthorizationHandler = null;
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
