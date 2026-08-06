import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { AppState, TranscriptionJobSnapshot } from '../shared/contracts';
import {
  ActivityOverlayContent,
  formatActivityDuration,
} from './ActivityOverlay';

const createState = (): AppState => ({
  engine: {
    state: 'ready',
    engineVersion: 'test',
    modelName: 'test',
    message: 'Ready',
  },
  recording: {
    capability: { state: 'ready', message: 'Ready' },
    active: null,
    storageMessage: null,
  },
  activeLocalAiSummary: null,
  queuedLocalAiSummaries: [],
  annotationEnabled: false,
  activeJob: null,
  recordings: [],
  transcripts: [],
});

const renderOverlay = (appState: AppState) =>
  renderToStaticMarkup(
    <ActivityOverlayContent
      appState={appState}
      error={null}
      now={84_000}
      onRequestAction={vi.fn()}
      pendingAction={null}
    />,
  );

describe('ActivityOverlayContent', () => {
  it('renders a compact recording pill with pause and stop controls', () => {
    const state = createState();
    state.recording.active = {
      id: 'recording-id',
      kind: 'meeting',
      sourceName: 'Live meeting',
      startedAt: new Date(0).toISOString(),
      bytesWritten: 1,
      paused: false,
      pausedAt: null,
      pausedDurationMs: 0,
      markers: [],
    };

    const markup = renderOverlay(state);

    expect(markup).toContain('Recording…');
    expect(markup).toContain('00:01:24');
    expect(markup).toContain('Pause recording');
    expect(markup).toContain('Stop recording');
    expect(markup.match(/<i><\/i>/g)).toHaveLength(5);
  });

  it('turns the left recording control into resume while paused', () => {
    const state = createState();
    state.recording.active = {
      id: 'recording-id',
      kind: 'dictation',
      sourceName: 'Dictation',
      startedAt: new Date(0).toISOString(),
      bytesWritten: 1,
      paused: true,
      pausedAt: new Date(80_000).toISOString(),
      pausedDurationMs: 0,
      markers: [],
    };

    const markup = renderOverlay(state);

    expect(markup).toContain('Recording paused');
    expect(markup).toContain('Resume recording');
    expect(markup).toContain('Stop dictation');
  });

  it('uses the same pill for transcription progress and cancellation', () => {
    const state = createState();
    state.activeJob = {
      id: 'job-id',
      sourceName: 'Meeting.webm',
      stage: 'transcribing',
      progress: 0.42,
      startedAt: new Date(0).toISOString(),
      message: 'Working',
    } satisfies TranscriptionJobSnapshot;

    const markup = renderOverlay(state);

    expect(markup).toContain('Transcribing…');
    expect(markup).toContain('42%');
    expect(markup).toContain('Cancel transcription');
  });
});

describe('formatActivityDuration', () => {
  it('always uses a stable hours, minutes, and seconds shape', () => {
    expect(formatActivityDuration(84_000)).toBe('00:01:24');
    expect(formatActivityDuration(3_661_000)).toBe('01:01:01');
  });
});
