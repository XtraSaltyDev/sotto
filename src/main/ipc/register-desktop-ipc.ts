import { lstat, writeFile } from 'node:fs/promises';

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
  type DeleteTranscriptResult,
  type ExportRecordingResult,
  type ExportTranscriptResult,
  type FinishLiveRecordingResult,
  type ImportMediaResult,
  type RetryRecordingResult,
  type StartLiveRecordingResult,
} from '../../shared/contracts';
import { AppController } from '../app-controller';
import {
  SUPPORTED_AUDIO_EXTENSIONS,
  SUPPORTED_VIDEO_EXTENSIONS,
  validateSelectedMedia,
} from '../media/media-import';
import { TranscriptionStartError } from '../transcription/transcription-service';
import { isTranscriptId } from '../transcription/transcript-types';
import {
  LiveRecordingError,
  MAX_LIVE_RECORDING_CHUNK_BYTES,
} from '../recording/live-recording-service';
import { copyRecordingForExport } from '../recording/recording-export';

export interface DesktopIpcOptions {
  controller: AppController;
  getMainWindow: () => BrowserWindow | null;
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

const exportFileName = (title: string): string => {
  const withoutControls = Array.from(title, (character) =>
    character.charCodeAt(0) < 32 ? '-' : character,
  ).join('');
  const safeTitle = withoutControls
    .replace(/[<>:"/\\|?*]/gu, '-')
    .replace(/[. ]+$/gu, '')
    .trim()
    .slice(0, 120);
  return `${safeTitle || 'Sotto transcript'}.txt`;
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
}: DesktopIpcOptions): (() => void) => {
  const trust = (event: IpcMainInvokeEvent): BrowserWindow =>
    assertTrustedSender(event, getMainWindow);

  ipcMain.handle(IPC_CHANNELS.getAppState, (event) => {
    trust(event);
    return controller.getState();
  });

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
    async (event): Promise<StartLiveRecordingResult> => {
      trust(event);
      try {
        return {
          outcome: 'started',
          recording: await controller.startLiveRecording(),
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
    IPC_CHANNELS.deleteTranscript,
    async (event, id: unknown): Promise<DeleteTranscriptResult> => {
      trust(event);
      return isTranscriptId(id) && (await controller.deleteTranscript(id))
        ? { outcome: 'deleted' }
        : { outcome: 'not-found' };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.exportTranscript,
    async (event, id: unknown): Promise<ExportTranscriptResult> => {
      const window = trust(event);
      if (!isTranscriptId(id)) return { outcome: 'not-found' };

      const transcript = await controller.getTranscriptExport(id);
      if (!transcript) return { outcome: 'not-found' };

      const selection = await dialog.showSaveDialog(window, {
        buttonLabel: 'Export Transcript',
        defaultPath: exportFileName(transcript.title),
        filters: [{ name: 'Plain text', extensions: ['txt'] }],
        title: 'Export Sotto Transcript',
      });
      if (selection.canceled || !selection.filePath) return { outcome: 'cancelled' };

      try {
        await writeFile(selection.filePath, transcript.text, {
          encoding: 'utf8',
          mode: 0o600,
        });
        return { outcome: 'saved', fileName: exportFileName(transcript.title) };
      } catch {
        return {
          outcome: 'failed',
          reason: 'Sotto could not write the transcript to that location.',
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
      IPC_CHANNELS.cancelTranscription,
      IPC_CHANNELS.getTranscript,
      IPC_CHANNELS.deleteTranscript,
      IPC_CHANNELS.exportTranscript,
    ]) {
      ipcMain.removeHandler(channel);
    }
  };
};
