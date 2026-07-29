import { contextBridge, ipcRenderer } from 'electron';

import {
  IPC_CHANNELS,
  type AppState,
  type RecordingKind,
  type SottoDesktopApi,
  type TranscriptCopyKind,
  type TranscriptExportFormat,
  type TranscriptLibraryQuery,
} from './shared/contracts';

const api: SottoDesktopApi = Object.freeze({
  getAppState: () => ipcRenderer.invoke(IPC_CHANNELS.getAppState),
  importMedia: () => ipcRenderer.invoke(IPC_CHANNELS.importMedia),
  startLiveRecording: (kind: RecordingKind = 'meeting') =>
    ipcRenderer.invoke(IPC_CHANNELS.startLiveRecording, kind),
  appendLiveRecordingChunk: (recordingId: string, chunk: ArrayBuffer) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.appendLiveRecordingChunk,
      recordingId,
      chunk,
    ),
  finishLiveRecording: (recordingId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.finishLiveRecording, recordingId),
  cancelLiveRecording: (recordingId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.cancelLiveRecording, recordingId),
  retryRecording: (recordingId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.retryRecording, recordingId),
  deleteRecording: (recordingId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.deleteRecording, recordingId),
  exportRecording: (recordingId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.exportRecording, recordingId),
  openRecordingSettings: () =>
    ipcRenderer.invoke(IPC_CHANNELS.openRecordingSettings),
  requestRecordingPermissions: () =>
    ipcRenderer.invoke(IPC_CHANNELS.requestRecordingPermissions),
  cancelTranscription: (jobId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.cancelTranscription, jobId),
  searchTranscriptLibrary: (query: TranscriptLibraryQuery) =>
    ipcRenderer.invoke(IPC_CHANNELS.searchTranscriptLibrary, query),
  getTranscript: (transcriptId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.getTranscript, transcriptId),
  updateTranscriptMetadata: (
    transcriptId: string,
    metadata: { title?: string; tags?: string[] },
  ) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.updateTranscriptMetadata,
      transcriptId,
      metadata,
    ),
  updateTranscriptSegment: (
    transcriptId: string,
    segmentIndex: number,
    text: string,
  ) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.updateTranscriptSegment,
      transcriptId,
      segmentIndex,
      text,
    ),
  renameTranscriptSpeaker: (
    transcriptId: string,
    speakerId: string,
    label: string,
  ) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.renameTranscriptSpeaker,
      transcriptId,
      speakerId,
      label,
    ),
  deleteTranscript: (transcriptId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.deleteTranscript, transcriptId),
  deletePlayback: (transcriptId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.deletePlayback, transcriptId),
  exportTranscript: (transcriptId: string, format: TranscriptExportFormat) =>
    ipcRenderer.invoke(IPC_CHANNELS.exportTranscript, transcriptId, format),
  copyTranscriptOutput: (transcriptId: string, kind: TranscriptCopyKind) =>
    ipcRenderer.invoke(IPC_CHANNELS.copyTranscriptOutput, transcriptId, kind),
  onDictationShortcut: (listener: () => void) => {
    const wrapped = () => listener();
    ipcRenderer.on(IPC_CHANNELS.dictationShortcut, wrapped);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.dictationShortcut, wrapped);
  },
  onAppStateChanged: (listener: (state: AppState) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: AppState) => listener(state);
    ipcRenderer.on(IPC_CHANNELS.stateChanged, wrapped);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.stateChanged, wrapped);
  },
});

contextBridge.exposeInMainWorld('sotto', api);
