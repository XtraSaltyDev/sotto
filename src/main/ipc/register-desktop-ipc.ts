import { lstat } from 'node:fs/promises';

import {
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Notification,
  systemPreferences,
  type IpcMainInvokeEvent,
} from 'electron';

import {
  IPC_CHANNELS,
  MAX_LIVE_RECORDING_MARKER_LABEL_CHARACTERS,
  MAX_LIVE_RECORDING_MARKER_OFFSET_MS,
  isExpectedSpeakerCount,
  type ActivityAction,
  type ActivityMode,
  type AppState,
  SUPPORTED_TRANSCRIPTION_LANGUAGES,
  type AppSettingsSummary,
  type AppendLiveRecordingChunkResult,
  type CancelLiveRecordingResult,
  type CheckForAppUpdateResult,
  type ConnectLocalAiInput,
  type ConnectLocalAiResult,
  type CopyTranscriptOutputResult,
  type DeleteMeetingResult,
  type DeleteRecordingResult,
  type DeletePlaybackResult,
  type DeleteTranscriptResult,
  type DisconnectLocalAiResult,
  type DownloadAppUpdateResult,
  type ExportRecordingResult,
  type ExportTranscriptResult,
  type ExpectedSpeakerCount,
  type FinishLiveRecordingResult,
  type GenerateLocalAiMeetingSummaryResult,
  type PreviewLocalAiMeetingSummaryResult,
  type AssignTranscriptSegmentSpeakerResult,
  type AssignTranscriptSegmentSpeakersResult,
  type AddTranscriptSpeakerResult,
  type ExportSpeakerAnnotationResult,
  type ImportMediaResult,
  type InsertDictationTextResult,
  type InstallAppUpdateResult,
  type LocalAiConnectionSummary,
  type OpenRecordingSettingsResult,
  type RecordingKind,
  type RetranscribeTranscriptResult,
  type RetryRecordingResult,
  type RequestRecordingPermissionsResult,
  type RenameTranscriptSpeakerResult,
  type StartLiveRecordingResult,
  type TranscriptLibraryResult,
  type TranscriptExportFormat,
  type UpdateAppSettingsInput,
  type UpdateAppSettingsResult,
  type UpdateTranscriptMetadataResult,
  type UpdateTranscriptSegmentResult,
} from '../../shared/contracts';
import { AppController } from '../app-controller';
import {
  SUPPORTED_AUDIO_EXTENSIONS,
  SUPPORTED_VIDEO_EXTENSIONS,
  validateSelectedMedia,
  type SelectedMedia,
} from '../media/media-import';
import { TranscriptionStartError } from '../transcription/transcription-service';
import {
  isTranscriptId,
  isTranscriptSpeakerId,
  MAX_SEGMENT_TEXT_CHARACTERS,
  MAX_TRANSCRIPT_SEGMENTS,
  MAX_SPEAKER_LABEL_CHARACTERS,
  TranscriptValidationError,
} from '../transcription/transcript-types';
import {
  LiveRecordingError,
  MAX_LIVE_RECORDING_CHUNK_BYTES,
} from '../recording/live-recording-service';
import { copyRecordingForExport } from '../recording/recording-export';
import { writeTranscriptExport } from '../export/transcript-export';
import { insertTextAtCursor } from '../dictation/cursor-insertion';
import type { LocalAiConnectionService } from '../local-ai/local-ai-connection';
import { isLocalAiTranscriptFingerprint } from '../local-ai/local-ai-meeting-summary';
import type { UpdateService } from '../updates/update-service';
import {
  isTranscriptCopyKind,
  isTranscriptExportFormat,
  parseTranscriptLibraryQuery,
  parseTranscriptMetadataUpdate,
} from './transcript-ipc-validation';

export interface DesktopIpcOptions {
  controller: AppController;
  localAiService: LocalAiConnectionService;
  updateService: UpdateService;
  getMainWindow: () => BrowserWindow | null;
  getActivityWindow: () => BrowserWindow | null;
  collapseForActivity: (mode: ActivityMode) => void;
  restoreMainWindow: () => void;
  onControllerStateChanged?: (state: AppState) => void;
  openRecordingSettings: () => Promise<void>;
  requestRecordingPermissions: () => Promise<
    'native-requested' | 'native-prompted'
  >;
  revealDownloadedUpdate: (filePath: string) => void;
  relaunchForUpdate: () => void;
  appSettings: {
    get: () => Promise<AppSettingsSummary>;
    update: (
      input: UpdateAppSettingsInput,
    ) => Promise<{ outcome: 'updated' } | { outcome: 'rejected'; reason: string }>;
    revealTranscripts: () => Promise<void>;
    revealModels: () => Promise<void>;
  };
}

const EXPECTED_SPEAKER_COUNT_REASON =
  'Choose Auto or an expected speaker count from 1 to 12.';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isActivityMode = (value: unknown): value is ActivityMode =>
  value === 'meeting-recording' ||
  value === 'dictation' ||
  value === 'transcribing';

const isActivityAction = (value: unknown): value is ActivityAction =>
  value === 'stop-recording' ||
  value === 'pause-recording' ||
  value === 'resume-recording' ||
  value === 'add-marker' ||
  value === 'cancel-transcription';

const notifyDictationFallback = (reason: string): void => {
  if (!Notification.isSupported()) return;
  new Notification({
    title: 'Sotto dictation saved',
    body: reason,
  }).show();
};

const parseExpectedSpeakerCount = (
  value: unknown,
): { ok: true; value: ExpectedSpeakerCount } | { ok: false } => {
  const normalized = value === undefined ? null : value;
  return isExpectedSpeakerCount(normalized)
    ? { ok: true, value: normalized }
    : { ok: false };
};

const assertTrustedSender = (
  event: IpcMainInvokeEvent,
  getMainWindow: () => BrowserWindow | null,
): BrowserWindow => {
  const window = getMainWindow();
  const trusted =
    window !== null &&
    !window.isDestroyed() &&
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame;

  if (!trusted || !window) {
    throw new Error('Blocked an IPC request from an untrusted renderer.');
  }

  return window;
};

const assertTrustedRenderer = (
  event: IpcMainInvokeEvent,
  getMainWindow: () => BrowserWindow | null,
  getActivityWindow: () => BrowserWindow | null,
): BrowserWindow => {
  const window = [getMainWindow(), getActivityWindow()].find(
    (candidate): candidate is BrowserWindow =>
      candidate !== null &&
      !candidate.isDestroyed() &&
      event.sender === candidate.webContents &&
      event.senderFrame === candidate.webContents.mainFrame,
  );
  if (!window) {
    throw new Error('Blocked an IPC request from an untrusted renderer.');
  }
  return window;
};

const TRANSCRIPT_EXPORT_DETAILS = {
  txt: {
    buttonLabel: 'Export Transcript',
    extension: 'txt',
    filterName: 'Plain text',
    suffix: '.txt',
    title: 'Export Sotto Transcript',
  },
  docx: {
    buttonLabel: 'Export Transcript',
    extension: 'docx',
    filterName: 'Microsoft Word document',
    suffix: '.docx',
    title: 'Export Sotto Transcript',
  },
  srt: {
    buttonLabel: 'Export Subtitles',
    extension: 'srt',
    filterName: 'SubRip subtitles',
    suffix: '.srt',
    title: 'Export Sotto Subtitles',
  },
  vtt: {
    buttonLabel: 'Export Subtitles',
    extension: 'vtt',
    filterName: 'WebVTT subtitles',
    suffix: '.vtt',
    title: 'Export Sotto Subtitles',
  },
  json: {
    buttonLabel: 'Export Transcript Data',
    extension: 'json',
    filterName: 'Sotto portable transcript',
    suffix: '.json',
    title: 'Export Sotto Transcript Data',
  },
  'minutes-docx': {
    buttonLabel: 'Export Meeting Minutes',
    extension: 'docx',
    filterName: 'Microsoft Word document',
    suffix: ' - meeting minutes.docx',
    title: 'Export Sotto Meeting Minutes',
  },
} as const satisfies Record<TranscriptExportFormat, {
  buttonLabel: string;
  extension: string;
  filterName: string;
  suffix: string;
  title: string;
}>;

const exportFileName = (
  title: string,
  format: TranscriptExportFormat,
): string => {
  const withoutControls = Array.from(title, (character) =>
    character.charCodeAt(0) < 32 ? '-' : character,
  ).join('');
  const safeTitle = withoutControls
    .replace(/[<>:"/\\|?*]/gu, '-')
    .replace(/[. ]+$/gu, '')
    .trim()
    .slice(0, 120);
  return `${safeTitle || 'Sotto transcript'}${TRANSCRIPT_EXPORT_DETAILS[format].suffix}`;
};

const recordingExportFileName = (sourceName: string): string => {
  const baseName = sourceName.replace(/\.webm$/iu, '');
  const withoutControls = Array.from(baseName, (character) =>
    character.charCodeAt(0) < 32 ? '-' : character,
  ).join('');
  const safeName = withoutControls
    .replace(/[<>:"/\\|?*]/gu, '-')
    .replace(/[. ]+$/gu, '')
    .trim()
    .slice(0, 120);
  return `${safeName || 'Sotto recording'}.webm`;
};

const isDiskFullError = (error: unknown): boolean =>
  error instanceof Error &&
  'code' in error &&
  (error.code === 'ENOSPC' || error.code === 'EDQUOT');

const asChunk = (value: unknown): Uint8Array | null => {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
};

export const registerDesktopIpc = ({
  controller,
  localAiService,
  updateService,
  getMainWindow,
  getActivityWindow,
  collapseForActivity,
  restoreMainWindow,
  onControllerStateChanged,
  openRecordingSettings,
  requestRecordingPermissions,
  revealDownloadedUpdate,
  relaunchForUpdate,
  appSettings,
}: DesktopIpcOptions): (() => void) => {
  const trust = (event: IpcMainInvokeEvent): BrowserWindow =>
    assertTrustedSender(event, getMainWindow);
  const rendererTrust = (event: IpcMainInvokeEvent): BrowserWindow =>
    assertTrustedRenderer(event, getMainWindow, getActivityWindow);

  ipcMain.handle(IPC_CHANNELS.getAppState, (event) => {
    rendererTrust(event);
    return controller.getState();
  });

  ipcMain.handle(
    IPC_CHANNELS.retranscribeTranscript,
    async (
      event,
      transcriptId: unknown,
      rawExpectedSpeakerCount: unknown,
    ): Promise<RetranscribeTranscriptResult> => {
      trust(event);
      if (!isTranscriptId(transcriptId)) return { outcome: 'not-found' };
      const expectedSpeakerCount = parseExpectedSpeakerCount(
        rawExpectedSpeakerCount,
      );
      if (!expectedSpeakerCount.ok) {
        return { outcome: 'rejected', reason: EXPECTED_SPEAKER_COUNT_REASON };
      }
      return controller.retranscribeTranscript(
        transcriptId,
        expectedSpeakerCount.value,
      );
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.getAppSettings,
    async (event): Promise<AppSettingsSummary> => {
      trust(event);
      return appSettings.get();
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.updateAppSettings,
    async (event, input: unknown): Promise<UpdateAppSettingsResult> => {
      trust(event);
      if (!isRecord(input)) {
        return { outcome: 'rejected', reason: 'Enter valid settings.' };
      }
      const changes: UpdateAppSettingsInput = {};
      if (input.transcriptionModelId !== undefined) {
        if (
          typeof input.transcriptionModelId !== 'string' ||
          !/^[a-z0-9][a-z0-9.-]{0,60}$/u.test(input.transcriptionModelId)
        ) {
          return { outcome: 'rejected', reason: 'Choose a valid model.' };
        }
        changes.transcriptionModelId = input.transcriptionModelId;
      }
      if (input.transcriptionLanguage !== undefined) {
        if (
          typeof input.transcriptionLanguage !== 'string' ||
          !SUPPORTED_TRANSCRIPTION_LANGUAGES.some(
            (language) => language.id === input.transcriptionLanguage,
          )
        ) {
          return { outcome: 'rejected', reason: 'Choose a supported language.' };
        }
        changes.transcriptionLanguage = input.transcriptionLanguage;
      }
      const result = await appSettings.update(changes);
      if (result.outcome === 'rejected') return result;
      return { outcome: 'updated', settings: await appSettings.get() };
    },
  );

  ipcMain.handle(IPC_CHANNELS.revealTranscriptsFolder, async (event) => {
    trust(event);
    await appSettings.revealTranscripts();
  });

  ipcMain.handle(IPC_CHANNELS.revealModelsFolder, async (event) => {
    trust(event);
    await appSettings.revealModels();
  });

  ipcMain.handle(
    IPC_CHANNELS.getLocalAiConnection,
    async (event): Promise<LocalAiConnectionSummary> => {
      trust(event);
      return localAiService.getSummary();
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.connectLocalAi,
    async (event, input: unknown): Promise<ConnectLocalAiResult> => {
      trust(event);
      if (!isRecord(input)) {
        return { outcome: 'rejected', reason: 'Enter a local AI connection.' };
      }
      return localAiService.connect(input as unknown as ConnectLocalAiInput);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.disconnectLocalAi,
    async (event): Promise<DisconnectLocalAiResult> => {
      trust(event);
      await localAiService.disconnect();
      return { outcome: 'disconnected' };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.checkForAppUpdate,
    async (event): Promise<CheckForAppUpdateResult> => {
      trust(event);
      return updateService.checkForUpdates();
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.downloadAppUpdate,
    async (event): Promise<DownloadAppUpdateResult> => {
      trust(event);
      const result = await updateService.downloadUpdate();
      if (result.outcome === 'downloaded') {
        revealDownloadedUpdate(result.filePath);
      }
      return result;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.cancelAppUpdate,
    (event): void => {
      trust(event);
      updateService.cancelDownload();
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.installAppUpdate,
    async (event): Promise<InstallAppUpdateResult> => {
      trust(event);
      const result = await updateService.installUpdate();
      if (result.outcome === 'installed') {
        relaunchForUpdate();
      }
      return result;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.previewLocalAiMeetingSummary,
    async (
      event,
      transcriptId: unknown,
    ): Promise<PreviewLocalAiMeetingSummaryResult> => {
      trust(event);
      if (!isTranscriptId(transcriptId)) return { outcome: 'not-found' };
      return controller.previewLocalAiMeetingSummary(
        transcriptId,
        localAiService,
      );
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.generateLocalAiMeetingSummary,
    async (
      event,
      transcriptId: unknown,
      approvalFingerprint: unknown,
    ): Promise<GenerateLocalAiMeetingSummaryResult> => {
      trust(event);
      if (!isTranscriptId(transcriptId)) return { outcome: 'not-found' };
      if (!isLocalAiTranscriptFingerprint(approvalFingerprint)) {
        return {
          outcome: 'rejected',
          reason: 'Review what would be sent before generating this summary.',
        };
      }
      return controller.generateLocalAiMeetingSummary(
        transcriptId,
        localAiService,
        approvalFingerprint,
      );
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.cancelLocalAiMeetingSummary,
    (event, transcriptId: unknown): void => {
      trust(event);
      if (!isTranscriptId(transcriptId)) return;
      controller.cancelLocalAiMeetingSummary(transcriptId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.openRecordingSettings,
    async (event): Promise<OpenRecordingSettingsResult> => {
      trust(event);
      try {
        await openRecordingSettings();
        return { outcome: 'opened' };
      } catch {
        return {
          outcome: 'failed',
          reason:
            'Open System Settings → Privacy & Security → Screen & System Audio Recording.',
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.requestRecordingPermissions,
    async (event): Promise<RequestRecordingPermissionsResult> => {
      trust(event);
      try {
        const outcome = await requestRecordingPermissions();
        return {
          outcome: outcome === 'native-requested' ? 'requested' : 'prompted',
        };
      } catch (error) {
        return {
          outcome: 'failed',
          reason:
            error instanceof Error
              ? error.message
              : 'Sotto could not request macOS recording permission.',
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.importMedia,
    async (
      event,
      rawExpectedSpeakerCount: unknown,
    ): Promise<ImportMediaResult> => {
      const window = trust(event);
      const expectedSpeakerCount = parseExpectedSpeakerCount(
        rawExpectedSpeakerCount,
      );
      if (!expectedSpeakerCount.ok) {
        return {
          outcome: 'rejected',
          reason: EXPECTED_SPEAKER_COUNT_REASON,
          code: 'invalid-media',
        };
      }
      const selection = await dialog.showOpenDialog(window, {
        buttonLabel: 'Import Recording',
        filters: [
          {
            name: 'Audio and video recordings',
            extensions: Array.from(
              new Set([...SUPPORTED_AUDIO_EXTENSIONS, ...SUPPORTED_VIDEO_EXTENSIONS]),
            ).map((extension) => extension.slice(1)),
          },
        ],
        message: 'Choose local meetings, audio recordings, or videos to transcribe.',
        properties: ['openFile', 'multiSelections'],
        title: 'Import Recordings into Sotto',
      });

      if (selection.canceled || selection.filePaths.length === 0) {
        return { outcome: 'cancelled' };
      }

      try {
        const media: SelectedMedia[] = [];
        let firstRejection: string | null = null;
        for (const filePath of selection.filePaths.slice(0, 50)) {
          const fileStats = await lstat(filePath);
          if (!fileStats.isFile()) {
            firstRejection ??= 'Choose regular audio or video files.';
            continue;
          }
          const validation = validateSelectedMedia(filePath, fileStats.size);
          if (!validation.ok) {
            firstRejection ??= validation.reason;
            continue;
          }
          media.push(validation.media);
        }
        if (media.length === 0) {
          return {
            outcome: 'rejected',
            reason: firstRejection ?? 'Choose regular audio or video files.',
            code: 'invalid-media',
          };
        }

        const { job, queuedCount } = await controller.enqueueImports(
          media,
          expectedSpeakerCount.value,
        );
        if (!job) return { outcome: 'queued', queuedCount };
        return queuedCount > 0
          ? { outcome: 'started', job, queuedCount }
          : { outcome: 'started', job };
      } catch (error) {
        if (error instanceof TranscriptionStartError) {
          return { outcome: 'rejected', reason: error.message, code: error.code };
        }

        return {
          outcome: 'rejected',
          reason: 'Sotto could not read or start processing that recording.',
          code: 'invalid-media',
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.startLiveRecording,
    async (event, requestedKind: unknown): Promise<StartLiveRecordingResult> => {
      trust(event);
      if (
        requestedKind !== undefined &&
        requestedKind !== 'meeting' &&
        requestedKind !== 'dictation'
      ) {
        return {
          outcome: 'rejected',
          reason: 'That recording type is not supported.',
          code: 'recording-failed',
        };
      }
      const kind: RecordingKind = requestedKind ?? 'meeting';
      try {
        return {
          outcome: 'started',
          recording: await controller.startLiveRecording(kind),
        };
      } catch (error) {
        if (error instanceof LiveRecordingError) {
          return { outcome: 'rejected', reason: error.message, code: error.code };
        }
        return {
          outcome: 'rejected',
          reason: 'Sotto could not start live meeting capture.',
          code: 'recording-failed',
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.appendLiveRecordingChunk,
    async (event, recordingId: unknown, rawChunk: unknown): Promise<AppendLiveRecordingChunkResult> => {
      trust(event);
      if (!isTranscriptId(recordingId)) {
        return {
          outcome: 'rejected',
          reason: 'That live recording is no longer active.',
          code: 'recording-failed',
        };
      }
      const chunk = asChunk(rawChunk);
      if (!chunk || chunk.byteLength > MAX_LIVE_RECORDING_CHUNK_BYTES) {
        return {
          outcome: 'rejected',
          reason: 'Sotto rejected an invalid recording chunk.',
          code: 'recording-failed',
        };
      }
      try {
        return await controller.appendLiveRecordingChunk(recordingId, chunk);
      } catch (error) {
        if (error instanceof LiveRecordingError) {
          return { outcome: 'rejected', reason: error.message, code: error.code };
        }
        return {
          outcome: 'rejected',
          reason: 'Sotto could not save the live recording chunk.',
          code: 'recording-failed',
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.setLiveRecordingPaused,
    async (event, recordingId: unknown, rawPaused: unknown) => {
      trust(event);
      if (!isTranscriptId(recordingId) || typeof rawPaused !== 'boolean') {
        return { outcome: 'not-found' as const };
      }
      try {
        return (await controller.setLiveRecordingPaused(recordingId, rawPaused))
          ? { outcome: 'updated' as const, paused: rawPaused }
          : { outcome: 'not-found' as const };
      } catch (error) {
        if (error instanceof LiveRecordingError) {
          return { outcome: 'rejected' as const, reason: error.message, code: error.code };
        }
        return {
          outcome: 'rejected' as const,
          reason: 'Sotto could not update the live recording state.',
          code: 'recording-failed' as const,
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.addLiveRecordingMarker,
    async (
      event,
      recordingId: unknown,
      rawOffsetMs: unknown,
      rawLabel: unknown,
    ) => {
      trust(event);
      const label = rawLabel === undefined ? 'Bookmark' : rawLabel;
      if (
        !isTranscriptId(recordingId) ||
        !Number.isSafeInteger(rawOffsetMs) ||
        (rawOffsetMs as number) < 0 ||
        (rawOffsetMs as number) > MAX_LIVE_RECORDING_MARKER_OFFSET_MS ||
        typeof label !== 'string' ||
        label.trim().length === 0 ||
        label.length > MAX_LIVE_RECORDING_MARKER_LABEL_CHARACTERS
      ) {
        return {
          outcome: 'rejected' as const,
          reason: 'That bookmark is not valid.',
          code: 'recording-failed' as const,
        };
      }
      try {
        const marker = await controller.addLiveRecordingMarker(
          recordingId,
          rawOffsetMs as number,
          label,
        );
        return marker
          ? { outcome: 'added' as const, marker }
          : { outcome: 'not-found' as const };
      } catch (error) {
        if (error instanceof LiveRecordingError) {
          return { outcome: 'rejected' as const, reason: error.message, code: error.code };
        }
        return {
          outcome: 'rejected' as const,
          reason: 'Sotto could not save that bookmark.',
          code: 'recording-failed' as const,
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.finishLiveRecording,
    async (
      event,
      recordingId: unknown,
      rawExpectedSpeakerCount: unknown,
    ): Promise<FinishLiveRecordingResult> => {
      trust(event);
      if (!isTranscriptId(recordingId)) return { outcome: 'not-found' };
      const expectedSpeakerCount = parseExpectedSpeakerCount(
        rawExpectedSpeakerCount,
      );
      if (!expectedSpeakerCount.ok) {
        return {
          outcome: 'rejected',
          reason: EXPECTED_SPEAKER_COUNT_REASON,
          code: 'invalid-media',
        };
      }
      try {
        return {
          outcome: 'started',
          job: await controller.finishLiveRecording(
            recordingId,
            expectedSpeakerCount.value,
          ),
        };
      } catch (error) {
        if (error instanceof LiveRecordingError || error instanceof TranscriptionStartError) {
          return { outcome: 'rejected', reason: error.message, code: error.code };
        }
        return {
          outcome: 'rejected',
          reason: 'Sotto could not finish the live recording.',
          code: 'recording-failed',
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.cancelLiveRecording,
    async (event, recordingId: unknown): Promise<CancelLiveRecordingResult> => {
      trust(event);
      return isTranscriptId(recordingId) && (await controller.cancelLiveRecording(recordingId))
        ? { outcome: 'cancelled' }
        : { outcome: 'not-found' };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.retryRecording,
    async (
      event,
      recordingId: unknown,
      rawExpectedSpeakerCount: unknown,
    ): Promise<RetryRecordingResult> => {
      trust(event);
      if (!isTranscriptId(recordingId)) return { outcome: 'not-found' };
      const expectedSpeakerCount = parseExpectedSpeakerCount(
        rawExpectedSpeakerCount,
      );
      if (!expectedSpeakerCount.ok) {
        return {
          outcome: 'rejected',
          reason: EXPECTED_SPEAKER_COUNT_REASON,
          code: 'invalid-media',
        };
      }
      try {
        const job = await controller.retryRecording(
          recordingId,
          expectedSpeakerCount.value,
        );
        return job
          ? { outcome: 'started', job }
          : { outcome: 'not-found' };
      } catch (error) {
        if (
          error instanceof LiveRecordingError ||
          error instanceof TranscriptionStartError
        ) {
          return {
            outcome: 'rejected',
            reason: error.message,
            code: error.code,
          };
        }
        return {
          outcome: 'rejected',
          reason: 'Sotto could not retry transcription for that recording.',
          code: 'transcription-failed',
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.deleteRecording,
    async (event, recordingId: unknown): Promise<DeleteRecordingResult> => {
      trust(event);
      if (!isTranscriptId(recordingId)) return { outcome: 'not-found' };
      try {
        return (await controller.deleteRecording(recordingId))
          ? { outcome: 'deleted' }
          : { outcome: 'not-found' };
      } catch (error) {
        return {
          outcome: 'rejected',
          reason:
            error instanceof Error
              ? error.message
              : 'Sotto could not delete that recording.',
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.deleteMeeting,
    async (
      event,
      recordingId: unknown,
      transcriptId: unknown,
    ): Promise<DeleteMeetingResult> => {
      trust(event);
      if (!isTranscriptId(recordingId) || !isTranscriptId(transcriptId)) {
        return { outcome: 'not-found' };
      }
      try {
        return await controller.deleteMeeting(recordingId, transcriptId);
      } catch {
        return {
          outcome: 'rejected',
          reason: 'Sotto could not delete that meeting.',
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.exportRecording,
    async (event, recordingId: unknown): Promise<ExportRecordingResult> => {
      const window = trust(event);
      if (!isTranscriptId(recordingId)) return { outcome: 'not-found' };

      const recording = await controller.getRecordingExport(recordingId);
      if (!recording) return { outcome: 'not-found' };
      const fileName = recordingExportFileName(recording.fileName);
      const selection = await dialog.showSaveDialog(window, {
        buttonLabel: 'Export Recording',
        defaultPath: fileName,
        filters: [{ name: 'WebM recording', extensions: ['webm'] }],
        title: 'Export Sotto Recording',
      });
      if (selection.canceled || !selection.filePath) {
        return { outcome: 'cancelled' };
      }

      try {
        await copyRecordingForExport(recording.path, selection.filePath);
        return { outcome: 'saved', fileName };
      } catch (error) {
        return {
          outcome: 'failed',
          reason: isDiskFullError(error)
            ? 'That location ran out of space before the recording export completed.'
            : 'Sotto could not export the recording to that location.',
        };
      }
    },
  );

  ipcMain.handle(IPC_CHANNELS.cancelTranscription, (event, jobId: unknown) => {
    trust(event);
    return isTranscriptId(jobId) && controller.cancelTranscription(jobId)
      ? { outcome: 'cancelled' as const }
      : { outcome: 'not-found' as const };
  });

  ipcMain.handle(IPC_CHANNELS.getTranscript, async (event, id: unknown) => {
    trust(event);
    return isTranscriptId(id) ? controller.getTranscript(id) : null;
  });

  ipcMain.handle(
    IPC_CHANNELS.searchTranscriptLibrary,
    (
      event,
      rawQuery: unknown,
    ): TranscriptLibraryResult => {
      trust(event);
      try {
        return controller.searchTranscriptLibrary(
          parseTranscriptLibraryQuery(rawQuery),
        );
      } catch {
        return {
          transcripts: [],
          availableSpeakers: [],
          availableTags: [],
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.updateTranscriptMetadata,
    async (
      event,
      transcriptId: unknown,
      rawMetadata: unknown,
    ): Promise<UpdateTranscriptMetadataResult> => {
      trust(event);
      if (!isTranscriptId(transcriptId)) return { outcome: 'not-found' };
      try {
        return controller.updateTranscriptMetadata(
          transcriptId,
          parseTranscriptMetadataUpdate(rawMetadata),
        );
      } catch (error) {
        return {
          outcome: 'rejected',
          reason:
            error instanceof TranscriptValidationError
              ? error.message
              : 'Sotto rejected invalid transcript information.',
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.updateTranscriptSegment,
    async (
      event,
      transcriptId: unknown,
      segmentIndex: unknown,
      text: unknown,
    ): Promise<UpdateTranscriptSegmentResult> => {
      trust(event);
      if (!isTranscriptId(transcriptId)) return { outcome: 'not-found' };
      if (
        typeof segmentIndex !== 'number' ||
        !Number.isSafeInteger(segmentIndex) ||
        segmentIndex < 0 ||
        segmentIndex >= MAX_TRANSCRIPT_SEGMENTS
      ) {
        return { outcome: 'not-found' };
      }
      if (
        typeof text !== 'string' ||
        text.length === 0 ||
        text.length > MAX_SEGMENT_TEXT_CHARACTERS
      ) {
        return {
          outcome: 'rejected',
          reason: `Transcript corrections must be 1–${MAX_SEGMENT_TEXT_CHARACTERS.toLocaleString()} characters.`,
        };
      }
      return controller.updateTranscriptSegment(transcriptId, segmentIndex, text);
    },
  );

  /**
   * Speaker annotation is a development affordance for producing ground truth.
   * The refusal lives here rather than only in the interface, because a
   * packaged build must not expose transcript mutations merely because its
   * renderer normally hides the controls.
   */
  const annotationRefusal = {
    outcome: 'rejected',
    reason: 'Speaker annotation is only available in a development build.',
  } as const;

  ipcMain.handle(
    IPC_CHANNELS.assignTranscriptSegmentSpeaker,
    async (
      event,
      transcriptId: unknown,
      segmentIndex: unknown,
      speakerId: unknown,
    ): Promise<AssignTranscriptSegmentSpeakerResult> => {
      trust(event);
      if (!controller.isAnnotationEnabled) return annotationRefusal;
      if (!isTranscriptId(transcriptId)) return { outcome: 'not-found' };
      if (
        typeof segmentIndex !== 'number' ||
        !Number.isSafeInteger(segmentIndex) ||
        segmentIndex < 0 ||
        segmentIndex >= MAX_TRANSCRIPT_SEGMENTS
      ) {
        return { outcome: 'not-found' };
      }
      if (speakerId !== null && !isTranscriptSpeakerId(speakerId)) {
        return { outcome: 'not-found' };
      }
      return controller.assignTranscriptSegmentSpeaker(
        transcriptId,
        segmentIndex,
        speakerId,
      );
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.assignTranscriptSegmentSpeakers,
    async (
      event,
      transcriptId: unknown,
      segmentIndexes: unknown,
      speakerId: unknown,
    ): Promise<AssignTranscriptSegmentSpeakersResult> => {
      trust(event);
      if (!controller.isAnnotationEnabled) return annotationRefusal;
      if (!isTranscriptId(transcriptId)) return { outcome: 'not-found' };
      if (
        !Array.isArray(segmentIndexes) ||
        segmentIndexes.length > MAX_TRANSCRIPT_SEGMENTS ||
        segmentIndexes.some(
          (index) =>
            typeof index !== 'number' ||
            !Number.isSafeInteger(index) ||
            index < 0 ||
            index >= MAX_TRANSCRIPT_SEGMENTS,
        )
      ) {
        return { outcome: 'not-found' };
      }
      if (speakerId !== null && !isTranscriptSpeakerId(speakerId)) {
        return { outcome: 'not-found' };
      }
      return controller.assignTranscriptSegmentSpeakers(
        transcriptId,
        segmentIndexes as number[],
        speakerId,
      );
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.addTranscriptSpeaker,
    async (
      event,
      transcriptId: unknown,
      label: unknown,
    ): Promise<AddTranscriptSpeakerResult> => {
      trust(event);
      if (!controller.isAnnotationEnabled) return annotationRefusal;
      if (!isTranscriptId(transcriptId)) return { outcome: 'not-found' };
      if (
        typeof label !== 'string' ||
        label.trim().length === 0 ||
        label.length > MAX_SPEAKER_LABEL_CHARACTERS
      ) {
        return {
          outcome: 'rejected',
          reason: `Speaker names must be 1–${MAX_SPEAKER_LABEL_CHARACTERS} characters.`,
        };
      }
      return controller.addTranscriptSpeaker(transcriptId, label);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.exportSpeakerAnnotation,
    async (
      event,
      transcriptId: unknown,
    ): Promise<ExportSpeakerAnnotationResult> => {
      const window = trust(event);
      if (!controller.isAnnotationEnabled) return annotationRefusal;
      if (!isTranscriptId(transcriptId)) return { outcome: 'not-found' };
      const contents = await controller.getSpeakerAnnotation(transcriptId);
      if (contents === null) return { outcome: 'not-found' };
      const selection = await dialog.showSaveDialog(window, {
        title: 'Export Speaker Annotation',
        buttonLabel: 'Export Annotation',
        defaultPath: `${transcriptId}.annotation.json`,
        filters: [{ name: 'Speaker annotation', extensions: ['json'] }],
      });
      if (selection.canceled || !selection.filePath) {
        return { outcome: 'cancelled' };
      }
      try {
        await writeTranscriptExport(selection.filePath, contents);
        return { outcome: 'exported', filePath: selection.filePath };
      } catch {
        return {
          outcome: 'rejected',
          reason: 'Sotto could not write that annotation file.',
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.renameTranscriptSpeaker,
    async (
      event,
      transcriptId: unknown,
      speakerId: unknown,
      label: unknown,
    ): Promise<RenameTranscriptSpeakerResult> => {
      trust(event);
      if (!isTranscriptId(transcriptId) || !isTranscriptSpeakerId(speakerId)) {
        return { outcome: 'not-found' };
      }
      if (
        typeof label !== 'string' ||
        label.length === 0 ||
        label.length > MAX_SPEAKER_LABEL_CHARACTERS
      ) {
        return {
          outcome: 'rejected',
          reason: `Speaker names must be 1–${MAX_SPEAKER_LABEL_CHARACTERS} characters.`,
        };
      }
      return controller.renameTranscriptSpeaker(transcriptId, speakerId, label);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.deleteTranscript,
    async (event, id: unknown): Promise<DeleteTranscriptResult> => {
      trust(event);
      return isTranscriptId(id) && (await controller.deleteTranscript(id))
        ? { outcome: 'deleted' }
        : { outcome: 'not-found' };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.deletePlayback,
    async (event, id: unknown): Promise<DeletePlaybackResult> => {
      trust(event);
      if (!isTranscriptId(id)) return { outcome: 'not-found' };
      try {
        return (await controller.deletePlayback(id))
          ? { outcome: 'deleted' }
          : { outcome: 'not-found' };
      } catch (error) {
        return {
          outcome: 'rejected',
          reason:
            error instanceof Error
              ? error.message
              : 'Sotto could not delete that playback audio.',
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.exportTranscript,
    async (
      event,
      id: unknown,
      format: unknown,
    ): Promise<ExportTranscriptResult> => {
      const window = trust(event);
      if (!isTranscriptId(id) || !isTranscriptExportFormat(format)) {
        return { outcome: 'not-found' };
      }

      let transcript: Awaited<ReturnType<AppController['getTranscriptExport']>>;
      try {
        transcript = await controller.getTranscriptExport(id, format);
      } catch {
        return {
          outcome: 'failed',
          reason: 'Sotto could not prepare the transcript for export.',
        };
      }
      if (!transcript) return { outcome: 'not-found' };
      const fileName = exportFileName(transcript.title, format);
      const details = TRANSCRIPT_EXPORT_DETAILS[format];

      const selection = await dialog.showSaveDialog(window, {
        buttonLabel: details.buttonLabel,
        defaultPath: fileName,
        filters: [
          { name: details.filterName, extensions: [details.extension] },
        ],
        title: details.title,
      });
      if (selection.canceled || !selection.filePath) return { outcome: 'cancelled' };

      try {
        await writeTranscriptExport(selection.filePath, transcript.content);
        return { outcome: 'saved', fileName };
      } catch (error) {
        return {
          outcome: 'failed',
          reason: isDiskFullError(error)
            ? 'That location ran out of space before the transcript export completed.'
            : 'Sotto could not write the transcript to that location.',
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.copyTranscriptOutput,
    async (
      event,
      id: unknown,
      kind: unknown,
    ): Promise<CopyTranscriptOutputResult> => {
      trust(event);
      if (!isTranscriptId(id) || !isTranscriptCopyKind(kind)) {
        return { outcome: 'not-found' };
      }

      try {
        const text = await controller.getTranscriptCopyText(id, kind);
        if (text === null) return { outcome: 'not-found' };
        clipboard.writeText(text);
        return { outcome: 'copied' };
      } catch {
        return {
          outcome: 'failed',
          reason: 'Sotto could not copy that meeting output.',
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.insertDictationText,
    async (
      event,
      id: unknown,
    ): Promise<InsertDictationTextResult> => {
      trust(event);
      if (!isTranscriptId(id)) return { outcome: 'not-found' };

      try {
        const text = await controller.getDictationText(id);
        if (text === null) return { outcome: 'not-found' };
        const result = await insertTextAtCursor(text, {
          platform: process.platform,
          windowsRoot: process.env.SystemRoot,
          writeClipboardText: (value) => clipboard.writeText(value),
          isMacAccessibilityTrusted: () =>
            process.platform === 'darwin' &&
            systemPreferences.isTrustedAccessibilityClient(true),
        });
        if (result.outcome === 'copied' || result.outcome === 'failed') {
          notifyDictationFallback(result.reason);
        }
        return result;
      } catch {
        const result: InsertDictationTextResult = {
          outcome: 'failed',
          reason: 'Sotto could not prepare the completed dictation for insertion.',
        };
        notifyDictationFallback(result.reason);
        return result;
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.collapseForActivity,
    (event, rawMode: unknown): void => {
      trust(event);
      if (!isActivityMode(rawMode)) {
        throw new Error('That activity mode is not supported.');
      }
      collapseForActivity(rawMode);
    },
  );

  ipcMain.handle(IPC_CHANNELS.restoreMainWindow, (event): void => {
    trust(event);
    restoreMainWindow();
  });

  ipcMain.handle(
    IPC_CHANNELS.requestActivityAction,
    (event, rawAction: unknown): void => {
      rendererTrust(event);
      if (!isActivityAction(rawAction)) {
        throw new Error('That activity action is not supported.');
      }
      const window = getMainWindow();
      if (window && !window.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.activityAction, rawAction);
      }
    },
  );

  const unsubscribe = controller.subscribe((state) => {
    onControllerStateChanged?.(state);
    for (const window of [getMainWindow(), getActivityWindow()]) {
      if (window && !window.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.stateChanged, state);
      }
    }
  });

  return () => {
    unsubscribe();
    for (const channel of [
      IPC_CHANNELS.getAppState,
      IPC_CHANNELS.retranscribeTranscript,
      IPC_CHANNELS.getAppSettings,
      IPC_CHANNELS.updateAppSettings,
      IPC_CHANNELS.revealTranscriptsFolder,
      IPC_CHANNELS.revealModelsFolder,
      IPC_CHANNELS.getLocalAiConnection,
      IPC_CHANNELS.connectLocalAi,
      IPC_CHANNELS.disconnectLocalAi,
      IPC_CHANNELS.previewLocalAiMeetingSummary,
      IPC_CHANNELS.generateLocalAiMeetingSummary,
      IPC_CHANNELS.cancelLocalAiMeetingSummary,
      IPC_CHANNELS.checkForAppUpdate,
      IPC_CHANNELS.downloadAppUpdate,
      IPC_CHANNELS.cancelAppUpdate,
      IPC_CHANNELS.installAppUpdate,
      IPC_CHANNELS.importMedia,
      IPC_CHANNELS.startLiveRecording,
      IPC_CHANNELS.appendLiveRecordingChunk,
      IPC_CHANNELS.setLiveRecordingPaused,
      IPC_CHANNELS.addLiveRecordingMarker,
      IPC_CHANNELS.finishLiveRecording,
      IPC_CHANNELS.cancelLiveRecording,
      IPC_CHANNELS.retryRecording,
      IPC_CHANNELS.deleteRecording,
      IPC_CHANNELS.deleteMeeting,
      IPC_CHANNELS.exportRecording,
      IPC_CHANNELS.openRecordingSettings,
      IPC_CHANNELS.requestRecordingPermissions,
      IPC_CHANNELS.cancelTranscription,
      IPC_CHANNELS.searchTranscriptLibrary,
      IPC_CHANNELS.getTranscript,
      IPC_CHANNELS.updateTranscriptMetadata,
      IPC_CHANNELS.updateTranscriptSegment,
      IPC_CHANNELS.assignTranscriptSegmentSpeaker,
      IPC_CHANNELS.assignTranscriptSegmentSpeakers,
      IPC_CHANNELS.addTranscriptSpeaker,
      IPC_CHANNELS.exportSpeakerAnnotation,
      IPC_CHANNELS.renameTranscriptSpeaker,
      IPC_CHANNELS.deleteTranscript,
      IPC_CHANNELS.deletePlayback,
      IPC_CHANNELS.exportTranscript,
      IPC_CHANNELS.copyTranscriptOutput,
      IPC_CHANNELS.insertDictationText,
      IPC_CHANNELS.collapseForActivity,
      IPC_CHANNELS.restoreMainWindow,
      IPC_CHANNELS.requestActivityAction,
    ]) {
      ipcMain.removeHandler(channel);
    }
  };
};
