import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useLayoutEffect,
} from 'react';

import type {
  AppUpdateProgress,
  AppState,
  ExpectedSpeakerCount,
  LocalAiConnectionSummary,
  RecordingKind,
  StartLiveRecordingResult,
  TranscriptDetail,
  TranscriptCopyKind,
  TranscriptExportFormat,
  TranscriptSummary,
} from '../shared/contracts';
import { isExpectedSpeakerCount } from '../shared/contracts';
import { liveRecordingStartErrorMessage } from './live-recording-errors';
import { releaseAbandonedLiveRecordingStart } from './live-recording-start-cleanup';
import { isIndeterminateTranscriptionProgress } from './transcription-progress';
import {
  AudioFileIcon,
  CancelIcon,
  FolderIcon,
  MicrophoneIcon,
  SpinnerIcon,
} from './icons';
import { ActivityOverlay } from './ActivityOverlay';
import { LocalAiSettings } from './LocalAiSettings';
import { SettingsPage } from './SettingsPage';
import {
  DISMISSED_UPDATE_VERSION_KEY,
  shouldOfferUpdate,
  UpdateBadge,
  UpdateNotice,
  UpdatePopup,
  type AppUpdateNoticeState,
} from './UpdateNotice';
import {
  transcriptCopySuccessMessage,
  transcriptExportFailureLabel,
} from './transcript-output-actions';
import {
  nextAppTheme,
  THEME_STORAGE_KEY,
  type AppTheme,
} from './theme';
import {
  dictationShortcutLabel,
  EXPECTED_SPEAKER_OPTIONS,
  formatDuration,
  initialAppTheme,
  isRunningJob,
  jobLabel,
  recordingLabel,
  recordingMimeType,
  withTimeout,
} from './app-format';
import { CaptureFailureNotice, HomeNotice, type AppNotice } from './notices';
import {
  MeetingLibrary,
  type TranscriptLibraryViewState,
} from './MeetingLibrary';
import { TranscriptView } from './TranscriptView';
import { Sidebar, type AppPage } from './Sidebar';

const MainApp = ({
  theme,
  onToggleTheme,
}: {
  theme: AppTheme;
  onToggleTheme: () => void;
}) => {
  const [currentPage, setCurrentPage] = useState<AppPage>('transcripts');
  const [appState, setAppState] = useState<AppState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptDetail | null>(null);
  const [isLoadingTranscript, setIsLoadingTranscript] = useState(false);
  const [notice, setNotice] = useState<AppNotice | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [isStartingRecording, setIsStartingRecording] = useState(false);
  const [isStoppingRecording, setIsStoppingRecording] = useState(false);
  const [isRepairingPermissions, setIsRepairingPermissions] = useState(false);
  const [localAiConnection, setLocalAiConnection] =
    useState<LocalAiConnectionSummary | null>(null);
  const [localAiGenerating, setLocalAiGenerating] = useState(false);
  const [localAiError, setLocalAiError] = useState<string | null>(null);
  const [expectedSpeakerCount, setExpectedSpeakerCount] =
    useState<ExpectedSpeakerCount>(null);
  const [recordingActionId, setRecordingActionId] = useState<string | null>(null);
  const [recordingTick, setRecordingTick] = useState(() => Date.now());
  const [isNewTranscriptionOpen, setIsNewTranscriptionOpen] = useState(false);
  const [dismissedStorageMessage, setDismissedStorageMessage] =
    useState<string | null>(null);
  const [dismissedStartupNotices, setDismissedStartupNotices] = useState<
    ReadonlySet<string>
  >(new Set());
  const [appUpdate, setAppUpdate] = useState<AppUpdateNoticeState | null>(null);
  const [isUpdatePopupOpen, setIsUpdatePopupOpen] = useState(false);
  const [libraryViewState, setLibraryViewState] =
    useState<TranscriptLibraryViewState>({
      query: '',
      dateRange: 'all',
      speaker: '',
      tag: '',
    });
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingStopPromiseRef = useRef<Promise<void> | null>(null);
  const recordingChunkQueueRef = useRef<Promise<void>>(Promise.resolve());
  const recordingChunkErrorRef = useRef<string | null>(null);
  const recordingIdRef = useRef<string | null>(null);
  const recordingExpectedSpeakerCountRef =
    useRef<ExpectedSpeakerCount>(null);
  const pendingDictationInsertionRef = useRef<string | null>(null);
  const returnFocusTranscriptIdRef = useRef<string | null>(null);
  const stoppingRecordingRef = useRef(false);
  const initializedNewTranscriptionRef = useRef(false);
  const desktopStreamRef = useRef<MediaStream | null>(null);
  const microphoneStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

  const showError = useCallback(
    (text: string) => setNotice({ kind: 'error', text }),
    [],
  );
  const showInfo = useCallback(
    (text: string) => setNotice({ kind: 'info', text }),
    [],
  );

  const refresh = useCallback(async () => {
    if (!window.sotto) {
      showError('Sotto must run in its desktop window.');
      return;
    }

    try {
      setAppState(await window.sotto.getAppState());
    } catch {
      showError('Sotto could not load its local state.');
    }
  }, [showError]);

  useEffect(() => {
    void refresh();
    if (!window.sotto) return undefined;

    return window.sotto.onAppStateChanged((nextState) => setAppState(nextState));
  }, [refresh]);

  useEffect(() => {
    if (!appState || initializedNewTranscriptionRef.current) return;
    initializedNewTranscriptionRef.current = true;
    if (appState.recordings.length === 0 && appState.transcripts.length === 0) {
      setIsNewTranscriptionOpen(true);
    }
  }, [appState]);

  useEffect(() => {
    if (!window.sotto?.checkForAppUpdate) return undefined;
    let cancelled = false;
    const check = async () => {
      try {
        const result = await window.sotto.checkForAppUpdate();
        if (cancelled || result.outcome !== 'update-available') return;
        const dismissed = window.localStorage.getItem(
          DISMISSED_UPDATE_VERSION_KEY,
        );
        if (!shouldOfferUpdate(result.update.version, dismissed)) return;
        setAppUpdate((current) =>
          current && current.phase !== 'available'
            ? current
            : {
                phase: 'available',
                version: result.update.version,
                size: result.update.size,
              },
        );
      } catch {
        // A quiet network is normal away from the Spark host; never nag.
      }
    };
    const initialCheck = window.setTimeout(() => void check(), 3_000);
    const recurringCheck = window.setInterval(
      () => void check(),
      6 * 60 * 60 * 1_000,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(initialCheck);
      window.clearInterval(recurringCheck);
    };
  }, []);

  useEffect(() => {
    if (!window.sotto?.onManualUpdateCheck) return undefined;
    return window.sotto.onManualUpdateCheck((result) => {
      setAppUpdate((current) => {
        // Never clobber a download or staged install the user already started.
        if (
          current?.phase === 'downloading' ||
          current?.phase === 'preparing' ||
          current?.phase === 'ready' ||
          current?.phase === 'restarting'
        ) {
          return current;
        }
        if (result.outcome === 'update-available') {
          // An explicit menu check deserves an immediate, visible answer.
          setIsUpdatePopupOpen(true);
          return {
            phase: 'available',
            version: result.update.version,
            size: result.update.size,
          };
        }
        if (result.outcome === 'up-to-date') {
          return { phase: 'up-to-date', version: result.version };
        }
        return { phase: 'check-failed', reason: result.reason };
      });
    });
  }, []);

  useEffect(() => {
    if (!window.sotto?.onAppUpdateProgress) return undefined;
    return window.sotto.onAppUpdateProgress((progress: AppUpdateProgress) => {
      setAppUpdate((current) => {
        if (
          !current ||
          current.phase === 'check-failed' ||
          current.version !== progress.version ||
          (current.phase !== 'available' &&
            current.phase !== 'downloading' &&
            current.phase !== 'preparing')
        ) {
          return current;
        }
        return progress.phase === 'preparing'
          ? { phase: 'preparing', version: progress.version }
          : {
              phase: 'downloading',
              version: progress.version,
              receivedBytes: progress.receivedBytes,
              totalBytes: progress.totalBytes,
            };
      });
    });
  }, []);

  const downloadAppUpdate = async (version: string, totalBytes = 0) => {
    setAppUpdate({
      phase: 'downloading',
      version,
      receivedBytes: 0,
      totalBytes,
    });
    try {
      const result = await window.sotto.downloadAppUpdate();
      setAppUpdate(
        result.outcome === 'staged'
          ? { phase: 'ready', version: result.version }
          : result.outcome === 'cancelled'
            ? { phase: 'cancelled', version: result.version }
            : result.outcome === 'downloaded'
              ? {
                  phase: 'downloaded',
                  fileName: result.fileName,
                  version: result.version,
                }
              : { phase: 'failed', reason: result.reason, version },
      );
    } catch {
      setAppUpdate({
        phase: 'failed',
        reason: 'Sotto could not download the update.',
        version,
      });
    }
  };

  const cancelAppUpdate = async (version: string) => {
    await window.sotto.cancelAppUpdate();
    setAppUpdate({ phase: 'cancelled', version });
  };

  const installAppUpdate = async (version: string) => {
    setAppUpdate({ phase: 'restarting', version });
    try {
      const result = await window.sotto.installAppUpdate();
      if (result.outcome === 'failed') {
        setAppUpdate({ phase: 'failed', reason: result.reason, version });
      }
      // On success the app relaunches; there is nothing left to render.
    } catch {
      setAppUpdate({
        phase: 'failed',
        reason: 'Sotto could not install the update.',
        version,
      });
    }
  };

  const dismissAppUpdate = () => {
    if (
      appUpdate &&
      (appUpdate.phase === 'available' ||
        appUpdate.phase === 'failed' ||
        appUpdate.phase === 'cancelled')
    ) {
      window.localStorage.setItem(
        DISMISSED_UPDATE_VERSION_KEY,
        appUpdate.version,
      );
    }
    setIsUpdatePopupOpen(false);
    setAppUpdate(null);
  };

  const startAppUpdate = () => {
    if (!appUpdate) return;
    if (appUpdate.phase === 'available') {
      void downloadAppUpdate(appUpdate.version, appUpdate.size);
    } else if (
      appUpdate.phase === 'failed' ||
      appUpdate.phase === 'cancelled'
    ) {
      void downloadAppUpdate(appUpdate.version);
    }
  };

  // The badge starts the update immediately and shows progress; the popup
  // opens without starting anything when the flow is already underway.
  const openUpdatePopup = () => {
    setIsUpdatePopupOpen(true);
    if (appUpdate?.phase === 'available') {
      void downloadAppUpdate(appUpdate.version, appUpdate.size);
    }
  };

  const updateBadge = appUpdate ? (
    <UpdateBadge onOpen={openUpdatePopup} state={appUpdate} />
  ) : null;

  const updatePopup = isUpdatePopupOpen &&
    appUpdate &&
    appUpdate.phase !== 'up-to-date' &&
    appUpdate.phase !== 'check-failed' ? (
    <UpdatePopup
      onCancel={() => {
        if (appUpdate.phase === 'downloading') {
          void cancelAppUpdate(appUpdate.version);
        }
      }}
      onClose={() => setIsUpdatePopupOpen(false)}
      onDismiss={dismissAppUpdate}
      onDownload={startAppUpdate}
      onInstall={() => {
        if (appUpdate.phase === 'ready') {
          void installAppUpdate(appUpdate.version);
        }
      }}
      state={appUpdate}
    />
  ) : null;

  // The sidebar footer card now serves only manual-check outcomes; every
  // other update phase lives in the brand badge and its popup.
  const updateNotice = appUpdate &&
    (appUpdate.phase === 'up-to-date' || appUpdate.phase === 'check-failed') ? (
    <UpdateNotice
      onDismiss={dismissAppUpdate}
      onDownload={startAppUpdate}
      state={appUpdate}
    />
  ) : null;

  useEffect(() => {
    if (!appState?.recording.active) return undefined;
    setRecordingTick(Date.now());
    const timer = window.setInterval(() => setRecordingTick(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [appState?.recording.active]);

  useEffect(() => {
    const job = appState?.activeJob;
    const pendingRecordingId = pendingDictationInsertionRef.current;
    if (
      !window.sotto ||
      !job ||
      !pendingRecordingId ||
      job.recordingId !== pendingRecordingId ||
      !['completed', 'failed', 'cancelled'].includes(job.stage)
    ) {
      return;
    }

    pendingDictationInsertionRef.current = null;
    const restoreActivityWindow = (): void => {
      void window.sotto?.restoreMainWindow().catch(() => undefined);
    };
    if (job.stage !== 'completed' || !job.transcriptId) {
      restoreActivityWindow();
      return;
    }

    void window.sotto
      .insertDictationText(job.transcriptId)
      .then((result) => {
        if (result.outcome === 'inserted') {
          showInfo('Dictation inserted at the cursor.');
        } else if (result.outcome === 'copied' || result.outcome === 'failed') {
          showError(result.reason);
        } else {
          showError('The dictation transcript could not be found for insertion.');
        }
      })
      .catch(() => {
        showError('Sotto could not insert the dictation. Open Sotto to copy the saved transcript.');
      })
      .finally(restoreActivityWindow);
  }, [
    appState?.activeJob?.recordingId,
    appState?.activeJob?.stage,
    appState?.activeJob?.transcriptId,
    showError,
    showInfo,
  ]);

  useEffect(() => {
    if (!selectedId || !window.sotto) {
      setTranscript(null);
      setLocalAiConnection(null);
      setLocalAiError(null);
      return undefined;
    }

    let cancelled = false;
    setNotice(null);
    setIsLoadingTranscript(true);
    window.sotto
      .getTranscript(selectedId)
      .then((detail) => {
        if (!cancelled) setTranscript(detail);
      })
      .catch(() => {
        if (!cancelled) showError('Sotto could not open that transcript.');
      })
      .finally(() => {
        if (!cancelled) setIsLoadingTranscript(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId || currentPage !== 'transcripts' || !window.sotto) {
      return undefined;
    }
    let cancelled = false;
    setLocalAiConnection(null);
    window.sotto
      .getLocalAiConnection()
      .then((connection) => {
        if (!cancelled) setLocalAiConnection(connection);
      })
      .catch(() => {
        if (!cancelled) {
          setLocalAiConnection({
            configured: false,
            baseUrl: '',
            selectedModel: null,
            availableModels: [],
            hasApiKey: false,
            verifiedAt: null,
          });
          setLocalAiError('Sotto could not check the Local AI connection.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [currentPage, selectedId]);

  useEffect(() => {
    const transcriptId = returnFocusTranscriptIdRef.current;
    if (selectedId || !transcriptId) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const target = document.querySelector<HTMLButtonElement>(
        `[data-transcript-id="${transcriptId}"]`,
      );
      if (target) {
        target.focus();
        returnFocusTranscriptIdRef.current = null;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [appState?.transcripts, selectedId]);

  const openTranscript = useCallback((transcriptId: string) => {
    returnFocusTranscriptIdRef.current = transcriptId;
    setSelectedId(transcriptId);
  }, []);

  const running = isRunningJob(appState?.activeJob ?? null);
  const activeRecording = appState?.recording.active ?? null;
  const storageMessage = appState?.recording.storageMessage ?? null;
  const visibleStorageMessage =
    storageMessage && storageMessage !== dismissedStorageMessage
      ? storageMessage
      : null;
  const captureMustStayOpen = Boolean(
    activeRecording ||
    running ||
    visibleStorageMessage ||
    isSelecting ||
    isStartingRecording ||
    isStoppingRecording,
  );
  const showNewTranscription =
    isNewTranscriptionOpen || captureMustStayOpen;
  const recordingCapabilityState = appState?.recording.capability.state;
  const needsRecordingSetup = recordingCapabilityState === 'setup-required';
  const recordingElapsed = activeRecording
    ? Math.max(0, recordingTick - new Date(activeRecording.startedAt).getTime())
    : 0;
  // Importing stays available while a transcription runs: extra files
  // join the sequential import queue.
  const canImport =
    appState?.engine.state === 'ready' &&
    !activeRecording &&
    !isStartingRecording &&
    !isStoppingRecording &&
    !isSelecting;
  const canRecord =
    appState?.engine.state === 'ready' &&
    (recordingCapabilityState === 'ready' || needsRecordingSetup) &&
    !running &&
    !activeRecording &&
    !isStartingRecording &&
    !isStoppingRecording &&
    !isSelecting;
  const canDictate =
    appState?.engine.state === 'ready' &&
    !running &&
    !activeRecording &&
    !isStartingRecording &&
    !isStoppingRecording &&
    !isSelecting;
  const progress = useMemo(
    () => Math.round(Math.min(1, Math.max(0, appState?.activeJob?.progress ?? 0)) * 100),
    [appState?.activeJob?.progress],
  );
  const progressIsIndeterminate = isIndeterminateTranscriptionProgress(
    appState?.activeJob ?? null,
  );

  const cleanupCapture = async () => {
    mediaRecorderRef.current = null;
    desktopStreamRef.current?.getTracks().forEach((track) => track.stop());
    microphoneStreamRef.current?.getTracks().forEach((track) => track.stop());
    desktopStreamRef.current = null;
    microphoneStreamRef.current = null;
    const context = audioContextRef.current;
    audioContextRef.current = null;
    if (context && context.state !== 'closed') await context.close();
  };

  const handleStopLiveRecording = async () => {
    const recorder = mediaRecorderRef.current;
    const recordingId = recordingIdRef.current;
    if (
      !window.sotto ||
      !recorder ||
      !recordingId ||
      stoppingRecordingRef.current
    ) {
      return;
    }

    const isDictation = pendingDictationInsertionRef.current === recordingId;
    stoppingRecordingRef.current = true;
    setIsStoppingRecording(true);
    try {
      if (recorder.state !== 'inactive') recorder.stop();
      await withTimeout(
        recordingStopPromiseRef.current ?? Promise.resolve(),
        10_000,
        'Sotto timed out while closing the local audio encoder.',
      );
      await withTimeout(
        recordingChunkQueueRef.current,
        20_000,
        'Sotto timed out while saving the final recording data.',
      );
      if (recordingChunkErrorRef.current) {
        throw new Error(recordingChunkErrorRef.current);
      }

      await cleanupCapture();
      const result = await withTimeout(
        window.sotto.finishLiveRecording(
          recordingId,
          recordingExpectedSpeakerCountRef.current,
        ),
        25_000,
        'Sotto timed out while finalizing the recording. Restart Sotto to check for a recovered saved recording.',
      );
      if (
        result.outcome === 'started' &&
        isDictation &&
        pendingDictationInsertionRef.current === recordingId
      ) {
        // The controller briefly publishes an empty active-job state while it
        // hands the finished recording to the transcription service. Reassert
        // the collapsed mode so the target app keeps focus through insertion.
        await window.sotto.collapseForActivity('dictation').catch(() => undefined);
      }
      if (result.outcome !== 'started' && pendingDictationInsertionRef.current === recordingId) {
        pendingDictationInsertionRef.current = null;
      }
      if (result.outcome === 'rejected') showError(result.reason);
      if (result.outcome === 'not-found') {
        showError('That live recording was already closed.');
      }
      if (result.outcome !== 'started' && isDictation) {
        await window.sotto.restoreMainWindow().catch(() => undefined);
      }
    } catch (error) {
      if (pendingDictationInsertionRef.current === recordingId) {
        pendingDictationInsertionRef.current = null;
      }
      await withTimeout(
        window.sotto.cancelLiveRecording(recordingId),
        5_000,
        'Sotto timed out while clearing the incomplete recording.',
      ).catch(() => undefined);
      await cleanupCapture();
      showError(
        error instanceof Error
          ? error.message
          : 'Sotto could not finish the live recording.',
      );
      if (isDictation) {
        await window.sotto.restoreMainWindow().catch(() => undefined);
      }
    } finally {
      recordingIdRef.current = null;
      recordingExpectedSpeakerCountRef.current = null;
      recordingStopPromiseRef.current = null;
      recordingChunkQueueRef.current = Promise.resolve();
      recordingChunkErrorRef.current = null;
      stoppingRecordingRef.current = false;
      setIsStoppingRecording(false);
    }
  };

  const handleStartRecording = async (kind: RecordingKind) => {
    if (
      !window.sotto ||
      (kind === 'meeting' ? !canRecord : !canDictate)
    ) return;
    setNotice(null);
    setIsStartingRecording(true);

    let recordingId: string | null = null;
    let desktopCapture: Promise<MediaStream> | null = null;
    let desktopStreamClaimed = false;
    let startRecording: Promise<StartLiveRecordingResult> | null = null;
    let startResultHandled = false;
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('This build cannot request microphone capture.');
      }

      if (kind === 'meeting') {
        if (!navigator.mediaDevices.getDisplayMedia) {
          throw new Error('This build cannot request desktop audio capture.');
        }
        // Start the display request synchronously from the button gesture. An
        // IPC round-trip before getDisplayMedia can consume the browser's
        // transient user activation and make the OS prompt fail.
        desktopCapture = navigator.mediaDevices.getDisplayMedia({
          audio: true,
          video: { frameRate: 1, height: 240, width: 320 },
        });
      }
      startRecording = window.sotto.startLiveRecording(kind);
      const started = await withTimeout(
        startRecording,
        20_000,
        'Sotto timed out while opening the private recording file.',
      );
      startResultHandled = true;
      if (started.outcome === 'rejected') {
        showError(started.reason);
        return;
      }
      recordingId = started.recording.id;
      recordingIdRef.current = recordingId;
      recordingExpectedSpeakerCountRef.current =
        kind === 'dictation' ? 1 : expectedSpeakerCount;
      if (kind === 'dictation') {
        pendingDictationInsertionRef.current = recordingId;
      }

      let desktopStream: MediaStream | null = null;
      if (desktopCapture) {
        desktopStream = await desktopCapture;
        desktopStreamRef.current = desktopStream;
        desktopStreamClaimed = true;
        if (desktopStream.getAudioTracks().length === 0) {
          throw new Error(
            'Sotto did not receive Teams audio. Allow screen and system-audio capture, then try again.',
          );
        }
      }

      let microphoneStream: MediaStream | null = null;
      try {
        microphoneStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false,
        });
        microphoneStreamRef.current = microphoneStream;
      } catch {
        if (kind === 'dictation') {
          throw new Error(
            'Microphone access is required for dictation. Allow it in system settings, then try again.',
          );
        }
        showError('Microphone access was not granted. Sotto will record Teams audio only for this meeting.');
      }

      const context = new AudioContext();
      audioContextRef.current = context;
      await context.resume();
      const destination = context.createMediaStreamDestination();
      if (desktopStream?.getAudioTracks().length) {
        context.createMediaStreamSource(desktopStream).connect(destination);
      }
      if (microphoneStream?.getAudioTracks().length) {
        context.createMediaStreamSource(microphoneStream).connect(destination);
      }

      if (typeof MediaRecorder === 'undefined') {
        throw new Error('This build cannot encode a live recording.');
      }
      const mimeType = recordingMimeType();
      const recorder = mimeType
        ? new MediaRecorder(destination.stream, {
            audioBitsPerSecond: 96_000,
            mimeType,
          })
        : new MediaRecorder(destination.stream, { audioBitsPerSecond: 96_000 });

      recordingChunkQueueRef.current = Promise.resolve();
      recordingChunkErrorRef.current = null;
      recorder.ondataavailable = (event) => {
        if (
          !event.data.size ||
          !window.sotto ||
          !recordingId ||
          recordingChunkErrorRef.current
        ) {
          return;
        }
        const currentId = recordingId;
        const sendChunk = recordingChunkQueueRef.current.then(async () => {
          const result = await withTimeout(
            window.sotto.appendLiveRecordingChunk(
              currentId,
              await event.data.arrayBuffer(),
            ),
            20_000,
            'Sotto timed out while writing the live recording to disk.',
          );
          if (result.outcome === 'rejected') throw new Error(result.reason);
        });
        recordingChunkQueueRef.current = sendChunk.catch((error: unknown) => {
          recordingChunkErrorRef.current =
            error instanceof Error
              ? error.message
              : 'Sotto could not save the live recording.';
          if (recorder.state === 'recording') recorder.stop();
          queueMicrotask(() => void handleStopLiveRecording());
        });
      };
      recorder.onerror = () => {
        recordingChunkErrorRef.current = 'Sotto could not encode the live recording.';
        if (recorder.state === 'recording') recorder.stop();
        queueMicrotask(() => void handleStopLiveRecording());
      };
      recordingStopPromiseRef.current = new Promise<void>((resolve, reject) => {
        recorder.addEventListener('stop', () => resolve(), { once: true });
        recorder.addEventListener(
          'error',
          () => reject(new Error('Sotto could not encode the live recording.')),
          { once: true },
        );
      });

      desktopStream?.getTracks().forEach((track) => {
        track.addEventListener('ended', () => {
          if (mediaRecorderRef.current?.state === 'recording') {
            void handleStopLiveRecording();
          }
        });
      });
      mediaRecorderRef.current = recorder;
      recorder.start(1_000);
      await window.sotto
        .collapseForActivity(
          kind === 'dictation' ? 'dictation' : 'meeting-recording',
        )
        .catch(() => undefined);
    } catch (error) {
      if (recordingId && window.sotto) {
        await withTimeout(
          window.sotto.cancelLiveRecording(recordingId),
          5_000,
          'Sotto timed out while clearing the incomplete recording.',
        ).catch(() => undefined);
      }
      await cleanupCapture();
      recordingIdRef.current = null;
      recordingExpectedSpeakerCountRef.current = null;
      if (pendingDictationInsertionRef.current === recordingId) {
        pendingDictationInsertionRef.current = null;
      }
      showError(
        kind === 'dictation' && error instanceof Error
          ? error.message
          : liveRecordingStartErrorMessage(error, navigator.platform),
      );
    } finally {
      void releaseAbandonedLiveRecordingStart({
        cancelRecording: (lateRecordingId) =>
          withTimeout(
            window.sotto.cancelLiveRecording(lateRecordingId),
            5_000,
            'Sotto timed out while clearing the incomplete recording.',
          ),
        desktopCapture,
        desktopStreamClaimed,
        startRecording,
        startResultHandled,
      });
      setIsStartingRecording(false);
    }
  };

  useEffect(() => {
    if (!window.sotto) return undefined;
    return window.sotto.onDictationShortcut(() => {
      if (activeRecording?.kind === 'dictation') {
        void handleStopLiveRecording();
      } else if (activeRecording) {
        showError('Finish the live meeting recording before starting dictation.');
      } else if (canDictate) {
        void handleStartRecording('dictation');
      } else if (running) {
        showError('Wait for the current transcription to finish before starting dictation.');
      } else if (appState?.engine.state !== 'ready') {
        showError(
          appState?.engine.message ??
          'The local transcription engine must be ready before starting dictation.',
        );
      } else {
        showError('Sotto is busy. Finish the current action before starting dictation.');
      }
    });
  }, [activeRecording, appState?.engine.message, appState?.engine.state, canDictate, running]);

  const handleOpenRecordingSettings = async () => {
    if (!window.sotto) return;
    setNotice(null);
    const result = await window.sotto.openRecordingSettings();
    if (result.outcome === 'failed') showError(result.reason);
  };

  const handleRepairRecordingPermissions = async () => {
    if (!window.sotto || isRepairingPermissions) return;
    setNotice(null);
    setIsRepairingPermissions(true);
    try {
      const result = await window.sotto.requestRecordingPermissions();
      if (result.outcome === 'failed') {
        showError(result.reason);
        setIsRepairingPermissions(false);
      } else if (result.outcome === 'settings-opened') {
        showError('macOS did not show its approval prompt. Your existing entry was left untouched; System Settings is open as a fallback.');
        setIsRepairingPermissions(false);
      } else {
        showInfo('Access was approved. Sotto is reopening…');
      }
    } catch {
      showError('Sotto could not request macOS recording permission.');
      setIsRepairingPermissions(false);
    }
  };

  const handleImport = async () => {
    if (!window.sotto || !canImport) return;
    setNotice(null);
    setIsSelecting(true);

    try {
      const result = await window.sotto.importMedia(expectedSpeakerCount);
      if (result.outcome === 'started') {
        if (result.queuedCount) {
          showInfo(
            `Transcription started. ${result.queuedCount} more recording${result.queuedCount === 1 ? '' : 's'} will follow automatically.`,
          );
        }
        await window.sotto.collapseForActivity('transcribing').catch(() => undefined);
      }
      if (result.outcome === 'queued') {
        showInfo(
          `${result.queuedCount} recording${result.queuedCount === 1 ? '' : 's'} added to the transcription queue.`,
        );
      }
      if (result.outcome === 'rejected') showError(result.reason);
    } catch {
      showError('Sotto could not open the recording picker. Please try again.');
    } finally {
      setIsSelecting(false);
    }
  };

  const handleCancel = async () => {
    const jobId = appState?.activeJob?.id;
    if (window.sotto && jobId) await window.sotto.cancelTranscription(jobId);
  };

  useEffect(() => {
    if (!window.sotto?.onActivityAction) return undefined;
    return window.sotto.onActivityAction((action) => {
      if (action === 'stop-recording') {
        void handleStopLiveRecording();
      } else {
        void handleCancel();
      }
    });
  }, [appState?.activeJob?.id, handleCancel]);

  const handleExport = async (format: TranscriptExportFormat) => {
    if (!window.sotto || !selectedId) return;
    setNotice(null);
    try {
      const result = await window.sotto.exportTranscript(selectedId, format);
      if (result.outcome === 'failed') showError(result.reason);
      if (result.outcome === 'not-found') {
        showError('That transcript is no longer available.');
      }
      if (result.outcome === 'saved') {
        showInfo(`${result.fileName} was saved.`);
      }
    } catch {
      showError(
        `Sotto could not export ${transcriptExportFailureLabel(format)}.`,
      );
    }
  };

  const handleCopyOutput = async (kind: TranscriptCopyKind) => {
    if (!window.sotto || !selectedId) return;
    setNotice(null);
    try {
      const result = await window.sotto.copyTranscriptOutput(selectedId, kind);
      if (result.outcome === 'copied') {
        showInfo(transcriptCopySuccessMessage(kind));
      } else if (result.outcome === 'not-found') {
        showError('That transcript is no longer available.');
      } else {
        showError(result.reason);
      }
    } catch {
      showError('Sotto could not copy that meeting output.');
    }
  };

  const handleGenerateLocalAiSummary = async () => {
    if (!window.sotto || !selectedId || localAiGenerating) return;
    setLocalAiError(null);
    setLocalAiGenerating(true);
    try {
      const result = await window.sotto.generateLocalAiMeetingSummary(selectedId);
      if (result.outcome === 'generated') {
        setTranscript((current) => current
          ? {
              ...current,
              localAiMeetingSummary: result.localAiMeetingSummary,
            }
          : current);
      } else if (result.outcome === 'not-found') {
        setLocalAiError('That transcript is no longer available.');
      } else {
        setLocalAiError(result.reason);
      }
    } catch {
      setLocalAiError('Sotto could not improve this summary with Local AI.');
    } finally {
      setLocalAiGenerating(false);
    }
  };

  // Segment and speaker edits change the transcript fingerprint, which
  // discards any generated Local AI summary. Never let minutes of local
  // model work vanish from a one-word correction without asking.
  const confirmLocalAiSummaryDiscard = (): boolean =>
    !transcript?.localAiMeetingSummary ||
    window.confirm(
      'Saving this edit will discard the Local AI summary for this meeting. You can generate it again afterwards. Continue?',
    );

  const handleRenameSpeaker = async (
    speakerId: string,
    label: string,
  ): Promise<string | null> => {
    if (!window.sotto || !selectedId) return 'Sotto could not rename that speaker.';
    if (!confirmLocalAiSummaryDiscard()) return null;
    const result = await window.sotto.renameTranscriptSpeaker(
      selectedId,
      speakerId,
      label,
    );
    if (result.outcome === 'rejected') return result.reason;
    if (result.outcome === 'not-found') return 'That speaker is no longer available.';

    setTranscript((current) =>
      current?.speakerAnalysis
        ? {
            ...current,
            localAiMeetingSummary: null,
            speakerAnalysis: {
              ...current.speakerAnalysis,
              speakers: current.speakerAnalysis.speakers.map((speaker) =>
                speaker.id === result.speaker.id ? result.speaker : speaker,
              ),
            },
          }
        : current,
    );
    return null;
  };

  const handleUpdateMetadata = async (metadata: {
    title?: string;
    tags?: string[];
  }): Promise<string | null> => {
    if (!window.sotto || !selectedId) {
      return 'Sotto could not save that transcript information.';
    }
    const result = await window.sotto.updateTranscriptMetadata(
      selectedId,
      metadata,
    );
    if (result.outcome === 'rejected') return result.reason;
    if (result.outcome === 'not-found') {
      return 'That transcript is no longer available.';
    }
    setTranscript((current) =>
      current
        ? {
            ...current,
            title: result.title,
            tags: result.tags,
          }
        : current,
    );
    return null;
  };

  const handleUpdateSegment = async (
    segmentIndex: number,
    text: string,
  ): Promise<string | null> => {
    if (!window.sotto || !selectedId) {
      return 'Sotto could not save that transcript correction.';
    }
    if (!confirmLocalAiSummaryDiscard()) return null;
    const result = await window.sotto.updateTranscriptSegment(
      selectedId,
      segmentIndex,
      text,
    );
    if (result.outcome === 'rejected') return result.reason;
    if (result.outcome === 'not-found') {
      return 'That transcript segment is no longer available.';
    }

    setTranscript((current) => current
      ? {
          ...current,
          meetingSummary: result.meetingSummary,
          localAiMeetingSummary: result.localAiMeetingSummary,
          preview: result.preview,
          text: result.text,
          segments: current.segments.map((segment, index) =>
            index === segmentIndex ? result.segment : segment,
          ),
        }
      : current);
    return null;
  };

  const handleDelete = async () => {
    if (!window.sotto || !selectedId) return;
    const recordingNote = transcript?.recordingId
      ? ' The original recording will stay saved.'
      : transcript?.playback.state === 'available'
        ? ' Its retained playback audio will also be deleted.'
        : '';
    if (
      !window.confirm(
        `Delete this local transcript?${recordingNote} This cannot be undone.`,
      )
    ) {
      return;
    }

    const result = await window.sotto.deleteTranscript(selectedId);
    if (result.outcome === 'deleted') {
      returnFocusTranscriptIdRef.current = null;
      setSelectedId(null);
      setTranscript(null);
    }
  };

  const deleteTranscriptFromLibrary = async (
    transcriptSummary: TranscriptSummary,
  ) => {
    if (!window.sotto) return;
    const linkedRecording = appState?.recordings.some(
      (recording) => recording.transcriptId === transcriptSummary.id,
    );
    const recordingNote = linkedRecording
      ? ' The original recording will stay saved and can be transcribed again.'
      : '';
    if (
      !window.confirm(
        `Delete “${transcriptSummary.title}”?${recordingNote} This cannot be undone.`,
      )
    ) {
      return;
    }

    setNotice(null);
    try {
      const result = await window.sotto.deleteTranscript(transcriptSummary.id);
      if (result.outcome === 'not-found') {
        showError('That transcript is no longer available.');
      }
    } catch {
      showError('Sotto could not delete that transcript.');
    }
  };

  const handleRetranscribe = async () => {
    if (!window.sotto || !selectedId) return;
    if (
      !window.confirm(
        'Transcribe this meeting again with the current model and language? The transcript text, speakers, and summaries will be replaced; the title and tags are kept.',
      )
    ) {
      return;
    }
    setNotice(null);
    try {
      const result = await window.sotto.retranscribeTranscript(selectedId);
      if (result.outcome === 'started') {
        setSelectedId(null);
        showInfo(
          'Re-transcription started with the current model and language.',
        );
      } else if (result.outcome === 'not-found') {
        showError('That transcript is no longer available.');
      } else {
        showError(result.reason);
      }
    } catch {
      showError('Sotto could not start transcribing this meeting again.');
    }
  };

  const handleDeletePlayback = async () => {
    if (!window.sotto || !selectedId || transcript?.playback.state !== 'available') {
      return;
    }
    const description =
      transcript.playback.kind === 'live-recording'
        ? 'saved live recording'
        : 'retained playback audio';
    if (
      !window.confirm(
        `Delete this ${description}? The transcript will stay saved. This cannot be undone.`,
      )
    ) {
      return;
    }
    setNotice(null);
    const result = await window.sotto.deletePlayback(selectedId);
    if (result.outcome === 'rejected') {
      showError(result.reason);
    } else if (result.outcome === 'not-found') {
      showError('That playback audio is no longer available.');
      setTranscript((current) => current
        ? { ...current, playback: { state: 'unavailable', reason: 'missing' } }
        : current);
    } else {
      setTranscript((current) => current
        ? {
            ...current,
            recordingId:
              current.playback.state === 'available' &&
              current.playback.kind === 'live-recording'
                ? undefined
                : current.recordingId,
            playback: { state: 'unavailable', reason: 'missing' },
          }
        : current);
    }
  };

  const retryRecording = async (recordingId: string) => {
    if (!window.sotto || recordingActionId) return;
    setNotice(null);
    setRecordingActionId(recordingId);
    try {
      const result = await window.sotto.retryRecording(
        recordingId,
        expectedSpeakerCount,
      );
      if (result.outcome === 'started') {
        await window.sotto.collapseForActivity('transcribing').catch(() => undefined);
      }
      if (result.outcome === 'rejected') showError(result.reason);
      if (result.outcome === 'not-found') {
        showError('That saved recording is no longer available.');
      }
    } catch {
      showError('Sotto could not retry transcription for that recording.');
    } finally {
      setRecordingActionId(null);
    }
  };

  const exportRecording = async (recordingId: string) => {
    if (!window.sotto || recordingActionId) return;
    setNotice(null);
    setRecordingActionId(recordingId);
    try {
      const result = await window.sotto.exportRecording(recordingId);
      if (result.outcome === 'failed') showError(result.reason);
      if (result.outcome === 'not-found') {
        showError('That saved recording is no longer available.');
      }
    } catch {
      showError('Sotto could not open the recording export dialog.');
    } finally {
      setRecordingActionId(null);
    }
  };

  const deleteRecording = async (recordingId: string) => {
    if (!window.sotto || recordingActionId) return;
    if (
      !window.confirm(
        'Delete this saved original recording? Any transcript will be kept. This cannot be undone.',
      )
    ) {
      return;
    }

    setNotice(null);
    setRecordingActionId(recordingId);
    try {
      const result = await window.sotto.deleteRecording(recordingId);
      if (result.outcome === 'rejected') showError(result.reason);
      if (result.outcome === 'not-found') {
        showError('That saved recording is no longer available.');
      }
      if (result.outcome === 'deleted') {
        setTranscript((current) =>
          current?.recordingId === recordingId
            ? { ...current, recordingId: undefined }
            : current,
        );
      }
    } catch {
      showError('Sotto could not delete that saved recording.');
    } finally {
      setRecordingActionId(null);
    }
  };

  if (currentPage === 'local-ai') {
    return (
      <div className="app-shell">
        <Sidebar
          currentPage={currentPage}
          onNavigate={setCurrentPage}
          onToggleTheme={onToggleTheme}
          theme={theme}
          updateBadge={updateBadge}
          updateNotice={updateNotice}
        />
        {updatePopup}
        <LocalAiSettings />
      </div>
    );
  }

  if (currentPage === 'settings') {
    return (
      <div className="app-shell">
        <Sidebar
          currentPage={currentPage}
          onNavigate={setCurrentPage}
          onToggleTheme={onToggleTheme}
          theme={theme}
          updateBadge={updateBadge}
          updateNotice={updateNotice}
        />
        {updatePopup}
        <SettingsPage />
      </div>
    );
  }

  if (selectedId) {
    return (
      <div className="app-shell">
        <Sidebar
          currentPage={currentPage}
          onNavigate={setCurrentPage}
          onToggleTheme={onToggleTheme}
          theme={theme}
          updateBadge={updateBadge}
          updateNotice={updateNotice}
        />
        {updatePopup}
        <TranscriptView
          localAiConnection={localAiConnection}
          localAiError={localAiError}
          localAiGenerating={localAiGenerating}
          loading={isLoadingTranscript}
          message={notice?.text ?? null}
          onBack={() => {
            setNotice(null);
            setSelectedId(null);
          }}
          onDelete={() => void handleDelete()}
          onDeletePlayback={() => void handleDeletePlayback()}
          onRetranscribe={() => void handleRetranscribe()}
          onCopy={(kind) => void handleCopyOutput(kind)}
          onExport={(format) => void handleExport(format)}
          onExportRecording={() => {
            if (transcript?.recordingId) void exportRecording(transcript.recordingId);
          }}
          onGenerateLocalAiSummary={() => void handleGenerateLocalAiSummary()}
          onOpenLocalAi={() => setCurrentPage('local-ai')}
          onRenameSpeaker={handleRenameSpeaker}
          onUpdateMetadata={handleUpdateMetadata}
          onUpdateSegment={handleUpdateSegment}
          transcript={transcript}
        />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Sidebar
        currentPage={currentPage}
        onNavigate={setCurrentPage}
        onToggleTheme={onToggleTheme}
        theme={theme}
        updateBadge={updateBadge}
        updateNotice={updateNotice}
      />
      {updatePopup}
      <main className={`workspace${showNewTranscription ? '' : ' workspace--library-home'}`}>
        <header className="topbar">
          <h1>Transcripts</h1>
          {captureMustStayOpen ? (
            <span className="new-transcription-status">In progress</span>
          ) : (
            <button
              aria-controls="new-transcription"
              aria-expanded={showNewTranscription}
              className="new-transcription-toggle"
              onClick={() => setIsNewTranscriptionOpen((current) => !current)}
              type="button"
            >
              <span aria-hidden="true">{showNewTranscription ? '×' : '+'}</span>
              {showNewTranscription ? 'Done' : 'New transcription'}
            </button>
          )}
        </header>
        {(appState?.startupNotices ?? [])
          .filter((startupNotice) => !dismissedStartupNotices.has(startupNotice))
          .map((startupNotice) => (
            <div className="home-message" key={startupNotice}>
              <CaptureFailureNotice
                message={startupNotice}
                onDismiss={() =>
                  setDismissedStartupNotices(
                    (current) => new Set(current).add(startupNotice),
                  )
                }
                platform={navigator.platform}
              />
            </div>
          ))}
        {!showNewTranscription && notice ? (
          <div className="home-message">
            <HomeNotice notice={notice} onDismiss={() => setNotice(null)} />
          </div>
        ) : null}
        {showNewTranscription ? (
        <section
          className="new-transcription"
          id="new-transcription"
          aria-labelledby="new-transcription-title"
        >
          <div className="new-transcription__heading">
            <div>
              <p className="eyebrow">Private and on-device</p>
              <h2 id="new-transcription-title">New transcription</h2>
            </div>
            <p>Import a file, record a meeting, or dictate into any app. Sotto processes everything on this device.</p>
          </div>

          <div className="import-panel" aria-live="polite">
            <div
              className={`import-panel__lead${appState?.activeJob ? ' import-panel__lead--has-job' : ''}`}
            >
              <AudioFileIcon className="import-panel__icon" />
            {activeRecording ? (
              <div className="recording-card" aria-live="polite">
                <div className="recording-card__heading">
                  <span><strong>{recordingLabel(activeRecording)}</strong><small>{activeRecording.sourceName}</small></span>
                  <span className="recording-card__dot" aria-label="Recording" />
                </div>
                <div className="recording-card__timer">{formatDuration(recordingElapsed)}</div>
                <p>
                  {activeRecording.kind === 'dictation'
                    ? 'Microphone audio is kept on this device and transcribed when you stop.'
                    : 'Teams/system audio and microphone are kept on this device.'}
                </p>
                <button className="text-button" disabled={isStoppingRecording} onClick={() => void handleStopLiveRecording()} type="button">
                  <CancelIcon /> {isStoppingRecording ? 'Stopping and preparing transcript…' : 'Stop recording'}
                </button>
              </div>
            ) : appState?.activeJob ? (
              <div className={`job-card job-card--${appState.activeJob.stage}`}>
                <div className="job-card__heading">
                  <span><strong>{jobLabel(appState.activeJob)}</strong><small>{appState.activeJob.sourceName}</small></span>
                  <span>{progressIsIndeterminate ? 'Working…' : `${progress}%`}</span>
                </div>
                <div
                  className={`progress-track${progressIsIndeterminate ? ' progress-track--indeterminate' : ''}`}
                  aria-label="Transcription progress"
                  aria-valuemax={100}
                  aria-valuemin={0}
                  aria-valuenow={progressIsIndeterminate ? undefined : progress}
                  role="progressbar"
                >
                  <span style={progressIsIndeterminate ? undefined : { width: `${progress}%` }} />
                </div>
                <p>{appState.activeJob.message}</p>
                {running ? (
                  <button className="text-button" onClick={() => void handleCancel()} type="button"><CancelIcon /> Cancel</button>
                ) : appState.activeJob.recordingId &&
                  ['failed', 'cancelled'].includes(appState.activeJob.stage) ? (
                  <button
                    className="text-button"
                    disabled={recordingActionId === appState.activeJob.recordingId}
                    onClick={() =>
                      void retryRecording(appState.activeJob?.recordingId as string)
                    }
                    type="button"
                  >
                    {recordingActionId === appState.activeJob.recordingId ? (
                      <SpinnerIcon className="spinner" />
                    ) : (
                      <MicrophoneIcon />
                    )}{' '}
                    Retry transcription
                  </button>
                ) : null}
              </div>
            ) : (
              <div className="import-panel__prompt">
                <strong>Choose a source</strong>
                <span>Audio and transcripts remain private on this device.</span>
              </div>
            )}
            {!activeRecording && !running ? (
              <label className="speaker-count-control">
                <span>
                  <strong>Expected speakers</strong>
                  <small>A known count prevents extra speaker labels.</small>
                </span>
                <select
                  disabled={isSelecting || isStartingRecording || isStoppingRecording}
                  onChange={(event) => {
                    const nextValue =
                      event.target.value === 'auto'
                        ? null
                        : Number(event.target.value);
                    if (isExpectedSpeakerCount(nextValue)) {
                      setExpectedSpeakerCount(nextValue);
                    }
                  }}
                  value={expectedSpeakerCount ?? 'auto'}
                >
                  <option value="auto">Auto</option>
                  {EXPECTED_SPEAKER_OPTIONS.map((count) => (
                    <option key={count} value={count}>
                      {count}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            </div>

            <div className="capture-actions">
            <button className="button button--primary" disabled={!canImport} onClick={() => void handleImport()} type="button">
              {isSelecting ? <SpinnerIcon className="spinner" /> : <FolderIcon />}
              <span>{isSelecting ? 'Opening…' : running ? 'Add to Queue' : 'Import Recordings'}</span>
            </button>
            <button
              className={`button button--record${activeRecording?.kind === 'meeting' ? ' button--recording' : ''}`}
              disabled={activeRecording?.kind === 'meeting' ? isStoppingRecording : !canRecord}
              onClick={() => void (activeRecording?.kind === 'meeting' ? handleStopLiveRecording() : handleStartRecording('meeting'))}
              type="button"
            >
              {isStartingRecording || isStoppingRecording ? <SpinnerIcon className="spinner" /> : <MicrophoneIcon />}
              <span>{isStartingRecording ? 'Opening capture…' : activeRecording?.kind === 'meeting' ? 'Stop recording' : needsRecordingSetup ? 'Set up live recording' : 'Record live meeting'}</span>
              <span className="button__status">{activeRecording?.kind === 'meeting' ? formatDuration(recordingElapsed) : needsRecordingSetup ? 'One-time macOS approval' : 'System + mic'}</span>
            </button>
            <button
              className={`button button--dictation${activeRecording?.kind === 'dictation' ? ' button--recording' : ''}`}
              disabled={activeRecording?.kind === 'dictation' ? isStoppingRecording : !canDictate}
              onClick={() => void (activeRecording?.kind === 'dictation' ? handleStopLiveRecording() : handleStartRecording('dictation'))}
              type="button"
            >
              {isStartingRecording || isStoppingRecording ? <SpinnerIcon className="spinner" /> : <MicrophoneIcon />}
              <span>{isStartingRecording ? 'Opening microphone…' : activeRecording?.kind === 'dictation' ? 'Stop dictation' : 'Dictate'}</span>
              <span className="button__status">{activeRecording?.kind === 'dictation' ? formatDuration(recordingElapsed) : dictationShortcutLabel()}</span>
            </button>
            </div>

            <div className="import-status-stack">
              {(appState?.pendingImports?.length ?? 0) > 0 ? (
                <p className="import-message import-message--notice">
                  Waiting to transcribe: {appState?.pendingImports?.join(', ')}
                </p>
              ) : null}
              {appState?.engine.state !== 'ready' ? (
                <p className="import-message import-message--error" role="alert">
                  {appState?.engine.message ?? 'Checking the local transcription engine…'}
                </p>
              ) : (
                <p className="import-message import-message--notice">
                  Local engine ready · {appState.engine.modelName}
                </p>
              )}
              {appState?.recording.capability.state !== 'ready' ? (
                <div className="recording-permission">
                  <p className="import-message import-message--notice">
                    {appState?.recording.capability.message ?? 'Checking live capture support…'}
                  </p>
                  {appState?.recording.capability.state === 'permission-required' ? (
                    <div className="recording-permission__actions">
                      <button
                        className="recording-permission__button recording-permission__button--primary"
                        disabled={isRepairingPermissions}
                        onClick={() => void handleRepairRecordingPermissions()}
                        type="button"
                      >
                        {isRepairingPermissions ? 'Requesting access…' : 'Request access for this Sotto'}
                      </button>
                      <button
                        className="recording-permission__button"
                        disabled={isRepairingPermissions}
                        onClick={() => void handleOpenRecordingSettings()}
                        type="button"
                      >
                        Open System Settings
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {visibleStorageMessage ? (
                <CaptureFailureNotice
                  message={visibleStorageMessage}
                  onDismiss={() => setDismissedStorageMessage(visibleStorageMessage)}
                  platform={navigator.platform}
                />
              ) : null}
              {notice ? (
                <HomeNotice notice={notice} onDismiss={() => setNotice(null)} />
              ) : null}
            </div>
          </div>
        </section>
        ) : null}
        <MeetingLibrary
          busyId={recordingActionId}
          onDeleteRecording={(recording) => void deleteRecording(recording.id)}
          onDeleteTranscript={(transcriptSummary) =>
            void deleteTranscriptFromLibrary(transcriptSummary)
          }
          onExportRecording={(recording) => void exportRecording(recording.id)}
          onOpen={openTranscript}
          onRetryRecording={(recording) => void retryRecording(recording.id)}
          recordings={appState?.recordings ?? []}
          onViewStateChange={setLibraryViewState}
          transcripts={appState?.transcripts ?? []}
          viewState={libraryViewState}
        />
      </main>
    </div>
  );
};

export const App = () => {
  const [theme, setTheme] = useState<AppTheme>(initialAppTheme);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  const onToggleTheme = useCallback(() => {
    setTheme((current) => {
      const next = nextAppTheme(current);
      try {
        window.localStorage.setItem(THEME_STORAGE_KEY, next);
      } catch {
        // Keep the in-session toggle working if storage is unavailable.
      }
      return next;
    });
  }, []);

  return new URLSearchParams(window.location.search).get('window') === 'activity'
    ? <ActivityOverlay />
    : <MainApp onToggleTheme={onToggleTheme} theme={theme} />;
};
