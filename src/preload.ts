import { contextBridge, ipcRenderer } from 'electron';

import {
  IPC_CHANNELS,
  type AppState,
  type SottoDesktopApi,
} from './shared/contracts';

const api: SottoDesktopApi = Object.freeze({
  getAppState: () => ipcRenderer.invoke(IPC_CHANNELS.getAppState),
  importMedia: () => ipcRenderer.invoke(IPC_CHANNELS.importMedia),
  startLiveRecording: () =>
    ipcRenderer.invoke(IPC_CHANNELS.startLiveRecording),
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
  cancelTranscription: (jobId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.cancelTranscription, jobId),
  getTranscript: (transcriptId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.getTranscript, transcriptId),
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
  exportTranscript: (transcriptId: string, format: 'txt' | 'docx') =>
    ipcRenderer.invoke(IPC_CHANNELS.exportTranscript, transcriptId, format),
  onAppStateChanged: (listener: (state: AppState) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: AppState) => listener(state);
    ipcRenderer.on(IPC_CHANNELS.stateChanged, wrapped);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.stateChanged, wrapped);
  },
});

contextBridge.exposeInMainWorld('sotto', api);
