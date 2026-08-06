import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC_CHANNELS } from '../../shared/contracts';
import { MAX_LIVE_RECORDING_CHUNK_BYTES } from '../recording/live-recording-service';
import { registerDesktopIpc } from './register-desktop-ipc';

/**
 * Covers the IPC boundary itself rather than the work behind it: which senders
 * are trusted, which arguments are refused before reaching the controller, and
 * whether teardown actually unregisters what registration added. A regression
 * here is a vulnerability rather than a bug, so the sender checks are asserted
 * across every registered channel instead of a sampled few.
 */

interface FakeWebContents {
  mainFrame: object;
  send: ReturnType<typeof vi.fn>;
}

interface FakeWindow {
  webContents: FakeWebContents;
  isDestroyed: () => boolean;
}

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const removed: string[] = [];
const showOpenDialog = vi.fn(async () => ({ canceled: true, filePaths: [] }));
const showSaveDialog = vi.fn(async () => ({ canceled: true, filePath: undefined }));
const writeText = vi.fn();

vi.mock('electron', () => ({
  BrowserWindow: class {},
  clipboard: { writeText: (value: string) => writeText(value) },
  dialog: {
    showOpenDialog: (...args: unknown[]) => showOpenDialog(...(args as [])),
    showSaveDialog: (...args: unknown[]) => showSaveDialog(...(args as [])),
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => {
      removed.push(channel);
    },
  },
  Notification: Object.assign(
    class {
      show(): void {
        // Dictation fallback notices are not part of this boundary.
      }
    },
    { isSupported: () => false },
  ),
  systemPreferences: { isTrustedAccessibilityClient: () => true },
}));

const createWindow = (destroyed = false): FakeWindow => ({
  webContents: { mainFrame: {}, send: vi.fn() },
  isDestroyed: () => destroyed,
});

const TRANSCRIPT_ID = '32ce6fee-8f3e-4f03-a266-46d6c00ef08c';

/** A controller stub that fails loudly if the boundary lets a call through. */
const createController = () => ({
  getState: vi.fn(() => ({ transcripts: [] })),
  subscribe: vi.fn(() => vi.fn()),
  retranscribeTranscript: vi.fn(async () => ({ outcome: 'not-found' })),
  appendLiveRecordingChunk: vi.fn(async () => ({ outcome: 'appended' })),
  updateLiveRecordingHealth: vi.fn(),
  setLiveRecordingPaused: vi.fn(async () => true),
  addLiveRecordingMarker: vi.fn(async () => null),
  finishLiveRecording: vi.fn(async () => ({})),
  cancelLiveRecording: vi.fn(async () => false),
  retryRecording: vi.fn(async () => null),
  cancelTranscription: vi.fn(() => false),
  getTranscript: vi.fn(async () => null),
  updateTranscriptSegment: vi.fn(async () => ({ outcome: 'not-found' })),
  updateTranscriptMetadata: vi.fn(async () => ({ outcome: 'not-found' })),
  renameTranscriptSpeaker: vi.fn(async () => ({ outcome: 'not-found' })),
  mergeTranscriptSpeakers: vi.fn(async () => ({ outcome: 'not-found' })),
  searchTranscriptLibrary: vi.fn(async () => ({ transcripts: [], matches: [] })),
  previewLocalAiMeetingSummary: vi.fn(async () => ({ outcome: 'not-found' })),
  generateLocalAiMeetingSummary: vi.fn(async () => ({ outcome: 'not-found' })),
  cancelLocalAiMeetingSummary: vi.fn(),
  assignTranscriptSegmentSpeaker: vi.fn(async () => ({ outcome: 'not-found' })),
  assignTranscriptSegmentSpeakers: vi.fn(async () => ({ outcome: 'not-found' })),
  addTranscriptSpeaker: vi.fn(async () => ({ outcome: 'not-found' })),
  getSpeakerAnnotation: vi.fn(async () => null),
  isAnnotationEnabled: false,
});

type Harness = {
  activityWindow: FakeWindow;
  controller: ReturnType<typeof createController>;
  dispose: () => void;
  mainWindow: FakeWindow;
  requestRecordingPermissions: ReturnType<typeof vi.fn>;
};

type PermissionRepairOutcome = 'native-requested' | 'native-prompted';

const eventFrom = (window: FakeWindow) => ({
  sender: window.webContents,
  senderFrame: window.webContents.mainFrame,
});

const setup = (
  overrides: {
    mainWindow?: FakeWindow | null;
    annotationEnabled?: boolean;
    requestRecordingPermissionsOutcome?: PermissionRepairOutcome;
  } = {},
): Harness => {
  const mainWindow = overrides.mainWindow === undefined
    ? createWindow()
    : overrides.mainWindow;
  const activityWindow = createWindow();
  const controller = createController();
  controller.isAnnotationEnabled = overrides.annotationEnabled === true;
  const requestRecordingPermissions = vi.fn(async () =>
    overrides.requestRecordingPermissionsOutcome ?? 'native-requested',
  );
  const dispose = registerDesktopIpc({
    controller: controller as never,
    localAiService: {
      getSummary: vi.fn(async () => ({ configured: false })),
      connect: vi.fn(async () => ({ outcome: 'rejected', reason: 'no' })),
      disconnect: vi.fn(async () => undefined),
    } as never,
    updateService: {
      checkForUpdate: vi.fn(async () => ({ outcome: 'up-to-date' })),
      download: vi.fn(async () => ({ outcome: 'failed', reason: 'no' })),
      cancel: vi.fn(),
      install: vi.fn(async () => ({ outcome: 'failed', reason: 'no' })),
    } as never,
    getMainWindow: () => (mainWindow as never) ?? null,
    getActivityWindow: () => activityWindow as never,
    collapseForActivity: vi.fn(),
    restoreMainWindow: vi.fn(),
    openRecordingSettings: vi.fn(async () => undefined),
    requestRecordingPermissions,
    revealDownloadedUpdate: vi.fn(),
    appSettings: {
      get: vi.fn(async () => ({}) as never),
      update: vi.fn(async () => ({ outcome: 'updated' as const })),
      revealTranscripts: vi.fn(async () => undefined),
      revealModels: vi.fn(async () => undefined),
    },
  });
  return {
    activityWindow,
    controller,
    dispose,
    mainWindow: mainWindow as FakeWindow,
    requestRecordingPermissions,
  };
};

const invoke = (channel: string, event: unknown, ...args: unknown[]): unknown => {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}.`);
  return handler(event, ...args);
};

beforeEach(() => {
  handlers.clear();
  removed.length = 0;
  vi.clearAllMocks();
});

describe('registerDesktopIpc sender trust', () => {
  it('refuses every registered channel when the sender is not a Sotto window', async () => {
    setup();
    const stranger = createWindow();
    expect(handlers.size).toBeGreaterThan(30);

    const accepted: string[] = [];
    for (const channel of handlers.keys()) {
      try {
        await invoke(channel, eventFrom(stranger));
        accepted.push(channel);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('untrusted')) {
          accepted.push(channel);
        }
      }
    }

    expect(accepted).toEqual([]);
  });

  it('refuses a sender whose frame is not the window main frame', async () => {
    const { mainWindow } = setup();
    // A subframe reaching ipcRenderer must not be treated as the renderer.
    const subframeEvent = {
      sender: mainWindow.webContents,
      senderFrame: { name: 'child' },
    };

    for (const channel of handlers.keys()) {
      await expect(
        Promise.resolve().then(() => invoke(channel, subframeEvent)),
      ).rejects.toThrow('untrusted');
    }
  });

  it('refuses every channel once the main window is destroyed', async () => {
    const destroyed = createWindow(true);
    setup({ mainWindow: destroyed });

    for (const channel of handlers.keys()) {
      await expect(
        Promise.resolve().then(() => invoke(channel, eventFrom(destroyed))),
      ).rejects.toThrow('untrusted');
    }
  });

  it('accepts the trusted main window', async () => {
    const { controller, mainWindow } = setup();

    await invoke(IPC_CHANNELS.getAppState, eventFrom(mainWindow));

    expect(controller.getState).toHaveBeenCalledTimes(1);
  });

  it('lets the activity window read state and request its own actions only', async () => {
    const { activityWindow, controller } = setup();
    const event = eventFrom(activityWindow);

    await invoke(IPC_CHANNELS.getAppState, event);
    expect(controller.getState).toHaveBeenCalledTimes(1);
    expect(() =>
      invoke(IPC_CHANNELS.requestActivityAction, event, 'stop-recording'),
    ).not.toThrow();

    // The activity overlay is a narrower surface: it must not reach transcripts.
    await expect(
      Promise.resolve().then(() =>
        invoke(IPC_CHANNELS.getTranscript, event, TRANSCRIPT_ID),
      ),
    ).rejects.toThrow('untrusted');
    await expect(
      Promise.resolve().then(() =>
        invoke(IPC_CHANNELS.deleteTranscript, event, TRANSCRIPT_ID),
      ),
    ).rejects.toThrow('untrusted');
    expect(controller.getTranscript).not.toHaveBeenCalled();
  });
});

describe('registerDesktopIpc recording permission repair', () => {
  it('keeps a pending native prompt separate from explicit settings', async () => {
    const { mainWindow, requestRecordingPermissions } = setup({
      requestRecordingPermissionsOutcome: 'native-prompted',
    });

    await expect(
      invoke(
        IPC_CHANNELS.requestRecordingPermissions,
        eventFrom(mainWindow),
      ),
    ).resolves.toEqual({ outcome: 'prompted' });
    expect(requestRecordingPermissions).toHaveBeenCalledOnce();
  });
});

describe('registerDesktopIpc live capture health', () => {
  it('forwards only valid health updates from the trusted main renderer', async () => {
    const { controller, mainWindow } = setup();
    const health = {
      recordingId: TRANSCRIPT_ID,
      kind: 'meeting',
      desktop: { permission: 'granted', track: 'ready', signal: 'detected' },
      microphone: { permission: 'granted', track: 'ready', signal: 'silent' },
    } as const;

    await invoke(
      IPC_CHANNELS.updateLiveRecordingHealth,
      eventFrom(mainWindow),
      health,
    );
    await invoke(
      IPC_CHANNELS.updateLiveRecordingHealth,
      eventFrom(mainWindow),
      { ...health, microphone: { ...health.microphone, signal: 'bogus' } },
    );

    expect(controller.updateLiveRecordingHealth).toHaveBeenCalledOnce();
    expect(controller.updateLiveRecordingHealth).toHaveBeenCalledWith(health);
  });

  it('forwards a clear update while the trusted renderer is stopping capture', async () => {
    const { controller, mainWindow } = setup();

    await invoke(
      IPC_CHANNELS.updateLiveRecordingHealth,
      eventFrom(mainWindow),
      null,
    );

    expect(controller.updateLiveRecordingHealth).toHaveBeenCalledWith(null);
  });
});
describe('registerDesktopIpc argument validation', () => {
  it('refuses transcript identifiers that are not UUIDs', async () => {
    const { controller, mainWindow } = setup();
    const event = eventFrom(mainWindow);

    for (const id of [
      '../../etc/passwd',
      'not-a-uuid',
      `${TRANSCRIPT_ID}/../other`,
      42,
      null,
      { id: TRANSCRIPT_ID },
    ]) {
      await expect(invoke(IPC_CHANNELS.getTranscript, event, id))
        .resolves.toBeNull();
      await expect(invoke(IPC_CHANNELS.previewLocalAiMeetingSummary, event, id))
        .resolves.toEqual({ outcome: 'not-found' });
    }

    expect(controller.getTranscript).not.toHaveBeenCalled();
    expect(controller.previewLocalAiMeetingSummary).not.toHaveBeenCalled();
  });

  it('refuses an expected speaker count outside the supported range', async () => {
    const { controller, mainWindow } = setup();
    const event = eventFrom(mainWindow);

    for (const count of [0, 13, -1, 2.5, '4', Number.NaN]) {
      await expect(
        invoke(IPC_CHANNELS.retranscribeTranscript, event, TRANSCRIPT_ID, count),
      ).resolves.toMatchObject({ outcome: 'rejected' });
    }
    expect(controller.retranscribeTranscript).not.toHaveBeenCalled();

    // Auto and the supported bounds still reach the controller.
    for (const count of [null, undefined, 1, 12]) {
      await invoke(IPC_CHANNELS.retranscribeTranscript, event, TRANSCRIPT_ID, count);
    }
    expect(controller.retranscribeTranscript).toHaveBeenCalledTimes(4);
  });

  it('refuses a live recording chunk that is not bounded binary data', async () => {
    const { controller, mainWindow } = setup();
    const event = eventFrom(mainWindow);

    for (const chunk of [
      'not binary',
      null,
      { length: 10 },
      new Uint8Array(MAX_LIVE_RECORDING_CHUNK_BYTES + 1),
    ]) {
      await expect(
        invoke(IPC_CHANNELS.appendLiveRecordingChunk, event, TRANSCRIPT_ID, chunk),
      ).resolves.toMatchObject({ outcome: 'rejected' });
    }
    expect(controller.appendLiveRecordingChunk).not.toHaveBeenCalled();

    await invoke(
      IPC_CHANNELS.appendLiveRecordingChunk,
      event,
      TRANSCRIPT_ID,
      new Uint8Array(MAX_LIVE_RECORDING_CHUNK_BYTES),
    );
    expect(controller.appendLiveRecordingChunk).toHaveBeenCalledTimes(1);
  });

  it('refuses a Local AI send that does not carry a reviewed approval', async () => {
    const { controller, mainWindow } = setup();
    const event = eventFrom(mainWindow);

    for (const approval of [undefined, '', 'yes', 'A'.repeat(64), { ok: true }]) {
      await expect(
        invoke(
          IPC_CHANNELS.generateLocalAiMeetingSummary,
          event,
          TRANSCRIPT_ID,
          approval,
        ),
      ).resolves.toMatchObject({ outcome: 'rejected' });
    }

    expect(controller.generateLocalAiMeetingSummary).not.toHaveBeenCalled();
  });

  it('refuses activity modes and actions outside the supported set', async () => {
    const { mainWindow } = setup();
    const event = eventFrom(mainWindow);

    for (const mode of ['screenshot', '', null, 42]) {
      expect(() => invoke(IPC_CHANNELS.collapseForActivity, event, mode)).toThrow();
    }
    for (const action of ['delete-everything', '', null]) {
      expect(() =>
        invoke(IPC_CHANNELS.requestActivityAction, event, action),
      ).toThrow();
    }
  });
});

describe('registerDesktopIpc speaker annotation gate', () => {
  const ANNOTATION_CHANNELS = [
    IPC_CHANNELS.assignTranscriptSegmentSpeaker,
    IPC_CHANNELS.assignTranscriptSegmentSpeakers,
    IPC_CHANNELS.addTranscriptSpeaker,
    IPC_CHANNELS.exportSpeakerAnnotation,
  ];

  it('refuses every annotation channel when annotation is not enabled', async () => {
    const { controller, mainWindow } = setup();
    const event = eventFrom(mainWindow);
    // Packaged builds never call enableAnnotation, so the controller reports
    // false and the boundary must refuse regardless of the arguments.
    expect(controller.isAnnotationEnabled).toBe(false);

    for (const channel of ANNOTATION_CHANNELS) {
      await expect(invoke(channel, event, TRANSCRIPT_ID, 0, null))
        .resolves.toMatchObject({ outcome: 'rejected' });
    }

    expect(controller.assignTranscriptSegmentSpeaker).not.toHaveBeenCalled();
    expect(controller.assignTranscriptSegmentSpeakers).not.toHaveBeenCalled();
    expect(controller.addTranscriptSpeaker).not.toHaveBeenCalled();
    expect(controller.getSpeakerAnnotation).not.toHaveBeenCalled();
  });

  it('reaches the controller once annotation is enabled', async () => {
    const { controller, mainWindow } = setup({ annotationEnabled: true });
    const event = eventFrom(mainWindow);

    await invoke(IPC_CHANNELS.assignTranscriptSegmentSpeaker, event, TRANSCRIPT_ID, 0, null);
    await invoke(IPC_CHANNELS.addTranscriptSpeaker, event, TRANSCRIPT_ID, 'Morgan');

    expect(controller.assignTranscriptSegmentSpeaker).toHaveBeenCalledWith(
      TRANSCRIPT_ID,
      0,
      null,
    );
    expect(controller.addTranscriptSpeaker).toHaveBeenCalledWith(
      TRANSCRIPT_ID,
      'Morgan',
    );
  });

  it('refuses a bulk assignment whose indexes are not bounded integers', async () => {
    const { controller, mainWindow } = setup({ annotationEnabled: true });
    const event = eventFrom(mainWindow);

    for (const indexes of ['all', null, [0, -1], [0, 1.5], [0, 'two'], [{}]]) {
      await expect(
        invoke(
          IPC_CHANNELS.assignTranscriptSegmentSpeakers,
          event,
          TRANSCRIPT_ID,
          indexes,
          null,
        ),
      ).resolves.toEqual({ outcome: 'not-found' });
    }
    expect(controller.assignTranscriptSegmentSpeakers).not.toHaveBeenCalled();

    await invoke(
      IPC_CHANNELS.assignTranscriptSegmentSpeakers,
      event,
      TRANSCRIPT_ID,
      [0, 3, 7],
      null,
    );
    expect(controller.assignTranscriptSegmentSpeakers).toHaveBeenCalledWith(
      TRANSCRIPT_ID,
      [0, 3, 7],
      null,
    );
  });

  it('still validates its arguments when annotation is enabled', async () => {
    const { controller, mainWindow } = setup({ annotationEnabled: true });
    const event = eventFrom(mainWindow);

    await expect(
      invoke(IPC_CHANNELS.assignTranscriptSegmentSpeaker, event, 'not-a-uuid', 0, null),
    ).resolves.toEqual({ outcome: 'not-found' });
    await expect(
      invoke(IPC_CHANNELS.assignTranscriptSegmentSpeaker, event, TRANSCRIPT_ID, -1, null),
    ).resolves.toEqual({ outcome: 'not-found' });
    await expect(
      invoke(IPC_CHANNELS.assignTranscriptSegmentSpeaker, event, TRANSCRIPT_ID, 0, 'nope'),
    ).resolves.toEqual({ outcome: 'not-found' });
    await expect(
      invoke(IPC_CHANNELS.addTranscriptSpeaker, event, TRANSCRIPT_ID, '   '),
    ).resolves.toMatchObject({ outcome: 'rejected' });

    expect(controller.assignTranscriptSegmentSpeaker).not.toHaveBeenCalled();
    expect(controller.addTranscriptSpeaker).not.toHaveBeenCalled();
  });
});

describe('registerDesktopIpc speaker merge', () => {
  it('allows a validated merge in the normal packaged-safe transcript path', async () => {
    const { controller, mainWindow } = setup();
    const event = eventFrom(mainWindow);
    const source = '6d73be9d-c055-4dc2-93d6-d821fb4f95ec';
    const target = 'a75d6b1a-eaa3-43bf-8084-08e3b509c445';

    await invoke(
      IPC_CHANNELS.mergeTranscriptSpeakers,
      event,
      TRANSCRIPT_ID,
      source,
      target,
    );

    expect(controller.mergeTranscriptSpeakers).toHaveBeenCalledWith(
      TRANSCRIPT_ID,
      source,
      target,
    );
  });

  it('refuses invalid speaker ids before storage', async () => {
    const { controller, mainWindow } = setup();
    await expect(
      invoke(
        IPC_CHANNELS.mergeTranscriptSpeakers,
        eventFrom(mainWindow),
        TRANSCRIPT_ID,
        'source',
        'target',
      ),
    ).resolves.toEqual({ outcome: 'not-found' });
    expect(controller.mergeTranscriptSpeakers).not.toHaveBeenCalled();
  });
});

describe('registerDesktopIpc teardown', () => {
  it('removes every channel it registered', () => {
    const { dispose } = setup();
    const registered = [...handlers.keys()];

    dispose();

    // A hand-maintained removal list drifts; this is what catches that.
    expect([...removed].sort()).toEqual([...registered].sort());
  });

  it('stops forwarding controller state after teardown', () => {
    const unsubscribe = vi.fn();
    handlers.clear();
    const controller = createController();
    controller.subscribe = vi.fn(() => unsubscribe);
    const mainWindow = createWindow();
    const dispose = registerDesktopIpc({
      controller: controller as never,
      localAiService: {} as never,
      updateService: {} as never,
      getMainWindow: () => mainWindow as never,
      getActivityWindow: () => null,
      collapseForActivity: vi.fn(),
      restoreMainWindow: vi.fn(),
      openRecordingSettings: vi.fn(async () => undefined),
      requestRecordingPermissions: vi.fn(async () => 'native-requested' as const),
      revealDownloadedUpdate: vi.fn(),
      appSettings: {
        get: vi.fn(async () => ({}) as never),
        update: vi.fn(async () => ({ outcome: 'updated' as const })),
        revealTranscripts: vi.fn(async () => undefined),
        revealModels: vi.fn(async () => undefined),
      },
    });

    dispose();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
