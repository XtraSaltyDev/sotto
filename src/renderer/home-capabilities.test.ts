import { describe, expect, it } from 'vitest';

import type { AppState } from '../shared/contracts';
import { homeCapabilities, type HomeBusyState } from './home-capabilities';

const IDLE: HomeBusyState = {
  running: false,
  isSelecting: false,
  isStartingRecording: false,
  isStoppingRecording: false,
};

const createState = (overrides: Partial<AppState> = {}): AppState => ({
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
  activeJob: null,
  activeLocalAiSummary: null,
  queuedLocalAiSummaries: [],
  annotationEnabled: false,
  recordings: [],
  transcripts: [],
  ...overrides,
});

describe('homeCapabilities', () => {
  it('allows everything when the engine is ready and nothing is happening', () => {
    expect(homeCapabilities(createState(), IDLE)).toEqual({
      canImport: true,
      canRecord: true,
      canDictate: true,
    });
  });

  it('allows nothing before the engine is ready', () => {
    expect(homeCapabilities(
      createState({
        engine: {
          state: 'unavailable',
          engineVersion: '',
          modelName: '',
          message: 'missing',
        },
      }),
      IDLE,
    )).toEqual({ canImport: false, canRecord: false, canDictate: false });
  });

  it('allows nothing with no state loaded yet', () => {
    expect(homeCapabilities(null, IDLE)).toEqual({
      canImport: false,
      canRecord: false,
      canDictate: false,
    });
  });

  it('keeps importing available during a transcription but blocks capture', () => {
    // Extra files join the sequential import queue; a second capture cannot.
    expect(homeCapabilities(createState(), { ...IDLE, running: true })).toEqual({
      canImport: true,
      canRecord: false,
      canDictate: false,
    });
  });

  it.each<keyof HomeBusyState>([
    'isSelecting',
    'isStartingRecording',
    'isStoppingRecording',
  ])('blocks everything while %s', (flag) => {
    expect(homeCapabilities(createState(), { ...IDLE, [flag]: true })).toEqual({
      canImport: false,
      canRecord: false,
      canDictate: false,
    });
  });

  it('blocks everything while a recording is active', () => {
    expect(homeCapabilities(
      createState({
        recording: {
          capability: { state: 'ready', message: 'ready' },
          active: {
            id: '32ce6fee-8f3e-4f03-a266-46d6c00ef08c',
            kind: 'meeting',
            startedAt: '2026-07-29T18:00:00.000Z',
          } as AppState['recording']['active'],
          storageMessage: null,
        },
      }),
      IDLE,
    )).toEqual({ canImport: false, canRecord: false, canDictate: false });
  });

  it('still offers recording when the operating system needs setup first', () => {
    // The button stays live so it can explain the permission, rather than
    // going dead with no route to fixing it.
    expect(homeCapabilities(
      createState({
        recording: {
          capability: { state: 'setup-required', message: 'grant access' },
          active: null,
          storageMessage: null,
        },
      }),
      IDLE,
    )).toMatchObject({ canRecord: true });
  });

  it('does not offer recording when capture is unsupported, but still dictation', () => {
    expect(homeCapabilities(
      createState({
        recording: {
          capability: { state: 'unsupported', message: 'macOS 12' },
          active: null,
          storageMessage: null,
        },
      }),
      IDLE,
    )).toEqual({ canImport: true, canRecord: false, canDictate: true });
  });
});
