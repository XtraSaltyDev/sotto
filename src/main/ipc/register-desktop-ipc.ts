import { lstat } from 'node:fs/promises';

import {
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
} from 'electron';

import {
  IPC_CHANNELS,
  type AppendLiveRecordingChunkResult,
  type CancelLiveRecordingResult,
  type DeleteRecordingResult,
  type DeletePlaybackResult,
  type DeleteTranscriptResult,
  type ExportRecordingResult,
  type ExportTranscriptResult,
  type FinishLiveRecordingResult,
  type ImportMediaResult,
  type OpenRecordingSettingsResult,
  type RecordingKind,
  type RetryRecordingResult,
  type RenameTranscriptSpeakerResult,
  type StartLiveRecordingResult,
  type TranscriptExportFormat,
  type UpdateTranscriptSegmentResult,
} from '../../shared/contracts';
import { AppController } from '../app-controller';
import {
  SUPPORTED_AUDIO_EXTENSIONS,
  SUPPORTED_VIDEO_EXTENSIONS,
  validateSelectedMedia,
} from '../media/media-import';
import { TranscriptionStartError } from '../transcription/transcription-service';
import {
  isTranscriptId,
  isTranscriptSpeakerId,
  MAX_SEGMENT_TEXT_CHARACTERS,
  MAX_TRANSCRIPT_SEGMENTS,
  MAX_SPEAKER_LABEL_CHARACTERS,
} from '../transcription/transcript-types';
import {
  LiveRecordingError,
  MAX_LIVE_RECORDING_CHUNK_BYTES,
} from '../recording/live-recording-service';
import { copyRecordingForExport } from '../recording/recording-export';
import { writeTranscriptExport } from '../export/transcript-export';

export interface DesktopIpcOptions {
  controller: AppController;
  getMainWindow: () => BrowserWindow | null;
  openRecordingSettings: () => Promise<void>;
}

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
  return `${safeTitle || 'Sotto transcript'}.${format}`;
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
  getMainWindow,
  openRecordingSettings,
}: DesktopIpcOptions): (() => void) => {
  const trust = (event: IpcMainInvokeEvent): BrowserWindow =>
    assertTrustedSender(event, getMainWindow);

  ipcMain.handle(IPC_CHANNELS.getAppState, (event) => {
    trust(event);
    return controller.getState();
  });

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
    IPC_CHANNELS.importMedia,
    async (event): Promise<ImportMediaResult> => {
      const window = trust(event);
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
        message: 'Choose a local meeting, audio recording, or video to transcribe.',
        properties: ['openFile'],
        title: 'Import a Recording into Sotto',
      });

      if (selection.canceled || selection.filePaths.length !== 1) {
        return { outcome: 'cancelled' };
      }

      try {
        const filePath = selection.filePaths[0];
        const fileStats = await lstat(filePath);
        if (!fileStats.isFile()) {
          return {
            outcome: 'rejected',
            reason: 'Choose a regular audio or video file.',
            code: 'invalid-media',
          };
        }

        const validation = validateSelectedMedia(filePath, fileStats.size);
        if (!validation.ok) {
          return {
            outcome: 'rejected',
            reason: validation.reason,
            code: 'invalid-media',
          };
        }

        const job = await controller.startTranscription(validation.media);
        return { outcome: 'started', job };
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
    IPC_CHANNELS.finishLiveRecording,
    async (event, recordingId: unknown): Promise<FinishLiveRecordingResult> => {
      trust(event);
      if (!isTranscriptId(recordingId)) return { outcome: 'not-found' };
      try {
        return {
          outcome: 'started',
          job: await controller.finishLiveRecording(recordingId),
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
    async (event, recordingId: unknown): Promise<RetryRecordingResult> => {
      trust(event);
      if (!isTranscriptId(recordingId)) return { outcome: 'not-found' };
      try {
        const job = await controller.retryRecording(recordingId);
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
      if (!isTranscriptId(id) || (format !== 'txt' && format !== 'docx')) {
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

      const selection = await dialog.showSaveDialog(window, {
        buttonLabel: 'Export Transcript',
        defaultPath: fileName,
        filters: [
          format === 'docx'
            ? { name: 'Microsoft Word document', extensions: ['docx'] }
            : { name: 'Plain text', extensions: ['txt'] },
        ],
        title: 'Export Sotto Transcript',
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

  const unsubscribe = controller.subscribe((state) => {
    const window = getMainWindow();
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.stateChanged, state);
    }
  });

  return () => {
    unsubscribe();
    for (const channel of [
      IPC_CHANNELS.getAppState,
      IPC_CHANNELS.importMedia,
      IPC_CHANNELS.startLiveRecording,
      IPC_CHANNELS.appendLiveRecordingChunk,
      IPC_CHANNELS.finishLiveRecording,
      IPC_CHANNELS.cancelLiveRecording,
      IPC_CHANNELS.retryRecording,
      IPC_CHANNELS.deleteRecording,
      IPC_CHANNELS.exportRecording,
      IPC_CHANNELS.openRecordingSettings,
      IPC_CHANNELS.cancelTranscription,
      IPC_CHANNELS.getTranscript,
      IPC_CHANNELS.updateTranscriptSegment,
      IPC_CHANNELS.renameTranscriptSpeaker,
      IPC_CHANNELS.deleteTranscript,
      IPC_CHANNELS.deletePlayback,
      IPC_CHANNELS.exportTranscript,
    ]) {
      ipcMain.removeHandler(channel);
    }
  };
};
