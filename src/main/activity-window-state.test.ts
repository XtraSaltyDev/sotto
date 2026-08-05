import { describe, expect, it } from 'vitest';

import type { AppState, TranscriptionJobSnapshot } from '../shared/contracts';
import {
  isRunningActivityJob,
  shouldRestoreActivityWindow,
} from './activity-window-state';

const createState = (job: TranscriptionJobSnapshot | null = null): AppState => ({
  engine: {
    state: 'ready',
    engineVersion: 'test',
    modelName: 'test',
    message: 'ready',
  },
  recording: {
    capability: { state: 'ready', message: 'ready' },
    active: null,
    storageMessage: null,
  },
  activeLocalAiSummary: null,
  activeJob: job,
  recordings: [],
  transcripts: [],
});

const createJob = (
  stage: TranscriptionJobSnapshot['stage'],
): TranscriptionJobSnapshot => ({
  id: 'job-id',
  sourceName: 'recording.webm',
  stage,
  progress: 0,
  startedAt: new Date(0).toISOString(),
  message: 'Working',
});

describe('activity window state', () => {
  it('restores the main window as soon as a meeting recording stops', () => {
    expect(shouldRestoreActivityWindow('meeting-recording', createState(createJob('transcribing')))).toBe(true);
  });

  it('keeps the overlay while a meeting recording is active', () => {
    const state = createState();
    state.recording.active = {
      id: 'recording-id',
      kind: 'meeting',
      sourceName: 'Live meeting',
      startedAt: new Date(0).toISOString(),
      bytesWritten: 0,
    };
    expect(shouldRestoreActivityWindow('meeting-recording', state)).toBe(false);
  });

  it('keeps dictation collapsed through transcription and completed insertion', () => {
    expect(shouldRestoreActivityWindow('dictation', createState())).toBe(false);
    expect(shouldRestoreActivityWindow('dictation', createState(createJob('transcribing')))).toBe(false);
    expect(shouldRestoreActivityWindow('dictation', createState(createJob('completed')))).toBe(false);
  });

  it('returns after dictation fails or is cancelled', () => {
    expect(shouldRestoreActivityWindow('dictation', createState(createJob('failed')))).toBe(true);
    expect(shouldRestoreActivityWindow('dictation', createState(createJob('cancelled')))).toBe(true);
  });

  it('returns when an imported transcription reaches a terminal state', () => {
    expect(isRunningActivityJob(createState(createJob('saving')))).toBe(true);
    expect(shouldRestoreActivityWindow('transcribing', createState(createJob('completed')))).toBe(true);
  });
});
