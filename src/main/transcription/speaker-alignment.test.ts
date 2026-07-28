import { describe, expect, it } from 'vitest';

import { alignTranscriptSpeakers } from './speaker-alignment';

const IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
];

describe('alignTranscriptSpeakers', () => {
  it('creates labels by first appearance and splits text on word-level speaker changes', () => {
    let nextId = 0;
    const result = alignTranscriptSpeakers(
      [{ startMs: 0, endMs: 2_000, text: 'Hello there. Hi!' }],
      [
        { startMs: 100, endMs: 500, text: ' Hello', segmentIndex: 0 },
        { startMs: 500, endMs: 900, text: ' there', segmentIndex: 0 },
        { startMs: 900, endMs: 1_000, text: '.', segmentIndex: 0 },
        { startMs: 1_100, endMs: 1_700, text: ' Hi', segmentIndex: 0 },
        { startMs: 1_700, endMs: 1_800, text: '!', segmentIndex: 0 },
      ],
      [
        { startMs: 0, endMs: 1_050, cluster: 8 },
        { startMs: 1_050, endMs: 2_000, cluster: 3 },
      ],
      () => IDS[nextId++],
    );

    expect(result.speakerAnalysis?.speakers).toEqual([
      { id: IDS[0], label: 'Speaker 1' },
      { id: IDS[1], label: 'Speaker 2' },
    ]);
    expect(result.segments).toEqual([
      { startMs: 100, endMs: 1_000, text: 'Hello there.', speakerId: IDS[0] },
      { startMs: 1_100, endMs: 1_800, text: 'Hi!', speakerId: IDS[1] },
    ]);
  });

  it('leaves equally overlapping speech unlabeled instead of guessing', () => {
    const result = alignTranscriptSpeakers(
      [{ startMs: 0, endMs: 1_000, text: 'Hello' }],
      [{ startMs: 100, endMs: 900, text: ' Hello', segmentIndex: 0 }],
      [
        { startMs: 100, endMs: 900, cluster: 0 },
        { startMs: 100, endMs: 900, cluster: 1 },
      ],
      () => IDS.shift() as string,
    );

    expect(result.segments[0].speakerId).toBeNull();
  });

  it('does not guess when full word timing is unavailable', () => {
    const result = alignTranscriptSpeakers(
      [{ startMs: 0, endMs: 5_000, text: 'Two people may speak here.' }],
      [],
      [{ startMs: 0, endMs: 5_000, cluster: 0 }],
      () => IDS[0],
    );

    expect(result.segments).toEqual([
      {
        startMs: 0,
        endMs: 5_000,
        text: 'Two people may speak here.',
        speakerId: null,
      },
    ]);
  });

  it('leaves speech far from a lone detected span unlabeled', () => {
    const result = alignTranscriptSpeakers(
      [{ startMs: 60_000, endMs: 61_000, text: 'Distant speech' }],
      [
        {
          startMs: 60_000,
          endMs: 61_000,
          text: ' Distant speech',
          segmentIndex: 0,
        },
      ],
      [{ startMs: 0, endMs: 1_000, cluster: 0 }],
      () => IDS[0],
    );

    expect(result.speakerAnalysis).not.toBeNull();
    expect(result.segments).toEqual([
      {
        startMs: 60_000,
        endMs: 61_000,
        text: 'Distant speech',
        speakerId: null,
      },
    ]);
  });

  it('only bridges matching speaker spans across a short timing gap', () => {
    const result = alignTranscriptSpeakers(
      [{ startMs: 5_000, endMs: 6_000, text: 'Long gap' }],
      [
        {
          startMs: 5_000,
          endMs: 6_000,
          text: ' Long gap',
          segmentIndex: 0,
        },
      ],
      [
        { startMs: 0, endMs: 1_000, cluster: 0 },
        { startMs: 10_000, endMs: 11_000, cluster: 0 },
      ],
      () => IDS[0],
    );

    expect(result.segments[0].speakerId).toBeNull();
  });

  it('returns a normal unlabeled transcript when no voices were clustered', () => {
    const result = alignTranscriptSpeakers(
      [{ startMs: 0, endMs: 200, text: '' }],
      [],
      [],
    );

    expect(result.speakerAnalysis).toBeNull();
    expect(result.segments[0].speakerId).toBeNull();
  });

  it('falls back to original unlabeled segments when splitting would exceed the cap', () => {
    const original = { startMs: 0, endMs: 1_000, text: 'Hello again' };
    let nextId = 0;
    const localIds = [
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
    ];
    const result = alignTranscriptSpeakers(
      [original],
      [
        { startMs: 0, endMs: 500, text: 'Hello', segmentIndex: 0 },
        { startMs: 500, endMs: 1_000, text: ' again', segmentIndex: 0 },
      ],
      [
        { startMs: 0, endMs: 500, cluster: 0 },
        { startMs: 500, endMs: 1_000, cluster: 1 },
      ],
      () => localIds[nextId++],
      1,
    );

    expect(result).toEqual({
      speakerAnalysis: null,
      segments: [{ ...original, speakerId: null }],
    });
  });
});
