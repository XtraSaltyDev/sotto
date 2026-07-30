import { describe, expect, it } from 'vitest';

import { alignTranscriptSpeakers } from './speaker-alignment';

const IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
];

const withoutWordTimings = <T extends { words: unknown }>(segments: readonly T[]) =>
  segments.map((segment) => {
    const { words, ...withoutWords } = segment;
    void words;
    return withoutWords;
  });

describe('alignTranscriptSpeakers', () => {
  it('drops tiny fragmentation clusters instead of showing dozens of speakers', () => {
    const words = Array.from({ length: 24 }, (_, index) => ({
      startMs: index * 500,
      endMs: index * 500 + 400,
      text: ` word${index}`,
      segmentIndex: 0,
    }));
    const dominant = words.map((word, index) => ({
      startMs: word.startMs,
      endMs: word.endMs,
      cluster: index % 4,
    }));
    const fragments = Array.from({ length: 100 }, (_, index) => ({
      startMs: index * 115,
      endMs: index * 115 + 50,
      cluster: index + 10,
    }));
    let nextId = 0;

    const result = alignTranscriptSpeakers(
      [{ startMs: 0, endMs: 12_000, text: words.map((word) => word.text).join('').trim() }],
      words,
      [...dominant, ...fragments],
      () => IDS[nextId++],
    );

    expect(result.speakerAnalysis?.speakers).toHaveLength(4);
    expect(result.speakerAnalysis?.speakers.map((speaker) => speaker.label)).toEqual([
      'Speaker 1',
      'Speaker 2',
      'Speaker 3',
      'Speaker 4',
    ]);
  });

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
    expect(withoutWordTimings(result.segments)).toEqual([
      { startMs: 100, endMs: 1_000, text: 'Hello there.', speakerId: IDS[0] },
      { startMs: 1_100, endMs: 1_800, text: 'Hi!', speakerId: IDS[1] },
    ]);
  });

  it('recovers a short opening phrase when the first speaker span starts late', () => {
    const result = alignTranscriptSpeakers(
      [{ startMs: 0, endMs: 3_030, text: 'This is me speaking.' }],
      [
        { startMs: 460, endMs: 750, text: ' This', segmentIndex: 0 },
        { startMs: 750, endMs: 1_120, text: ' is', segmentIndex: 0 },
        { startMs: 1_120, endMs: 1_160, text: ' me', segmentIndex: 0 },
        { startMs: 2_070, endMs: 3_000, text: ' speaking', segmentIndex: 0 },
        { startMs: 3_000, endMs: 3_030, text: '.', segmentIndex: 0 },
      ],
      [{ startMs: 2_039, endMs: 3_030, cluster: 0 }],
      () => IDS[0],
    );

    expect(withoutWordTimings(result.segments)).toEqual([
      {
        startMs: 460,
        endMs: 1_160,
        text: 'This is me',
        speakerId: IDS[0],
      },
      {
        startMs: 2_070,
        endMs: 3_030,
        text: 'speaking.',
        speakerId: IDS[0],
      },
    ]);
  });

  it('places a stranded turn-opening token with the clearly nearer new speaker', () => {
    const result = alignTranscriptSpeakers(
      [
        { startMs: 0, endMs: 5_270, text: 'I am speaking first.' },
        { startMs: 5_560, endMs: 9_280, text: 'This is me speaking second.' },
      ],
      [
        { startMs: 2_070, endMs: 3_000, text: ' I', segmentIndex: 0 },
        { startMs: 3_000, endMs: 3_500, text: ' am', segmentIndex: 0 },
        { startMs: 3_500, endMs: 4_430, text: ' speaking', segmentIndex: 0 },
        { startMs: 4_430, endMs: 5_000, text: ' first', segmentIndex: 0 },
        { startMs: 5_000, endMs: 5_270, text: '.', segmentIndex: 0 },
        { startMs: 5_950, endMs: 5_950, text: ' This', segmentIndex: 1 },
        { startMs: 6_020, endMs: 6_140, text: ' is', segmentIndex: 1 },
        { startMs: 6_140, endMs: 6_330, text: ' me', segmentIndex: 1 },
        { startMs: 6_330, endMs: 8_300, text: ' speaking', segmentIndex: 1 },
        { startMs: 8_370, endMs: 8_590, text: ' second', segmentIndex: 1 },
        { startMs: 9_220, endMs: 9_280, text: '.', segmentIndex: 1 },
      ],
      [
        { startMs: 2_039, endMs: 5_296, cluster: 0 },
        { startMs: 6_376, endMs: 9_228, cluster: 1 },
      ],
      (() => {
        let nextId = 0;
        return () => IDS[nextId++];
      })(),
    );

    expect(
      result.segments.find((segment) => segment.text.startsWith('This'))?.speakerId,
    ).toBe(IDS[1]);
    expect(result.segments.every((segment) => segment.speakerId !== null)).toBe(true);
  });

  it('fills a short timing hole bounded by reliable spans from the same speaker', () => {
    const result = alignTranscriptSpeakers(
      [{ startMs: 0, endMs: 4_500, text: 'Before middle after' }],
      [
        { startMs: 0, endMs: 1_000, text: 'Before', segmentIndex: 0 },
        { startMs: 1_500, endMs: 1_700, text: ' middle', segmentIndex: 0 },
        { startMs: 2_200, endMs: 3_000, text: ' after', segmentIndex: 0 },
      ],
      [
        { startMs: 0, endMs: 300, cluster: 0 },
        { startMs: 2_700, endMs: 3_000, cluster: 0 },
      ],
      () => IDS[0],
    );

    expect(result.segments.every((segment) => segment.speakerId === IDS[0])).toBe(
      true,
    );
  });

  it('repairs a tiny filtered cluster enclosed by strong same-speaker evidence', () => {
    const result = alignTranscriptSpeakers(
      [{ startMs: 0, endMs: 1_200, text: 'Before glitch after' }],
      [
        { startMs: 0, endMs: 500, text: 'Before', segmentIndex: 0 },
        { startMs: 500, endMs: 650, text: ' glitch', segmentIndex: 0 },
        { startMs: 650, endMs: 1_200, text: ' after', segmentIndex: 0 },
      ],
      [
        { startMs: 0, endMs: 500, cluster: 0 },
        { startMs: 500, endMs: 650, cluster: 99 },
        { startMs: 650, endMs: 1_200, cluster: 0 },
      ],
      () => IDS[0],
    );

    expect(result.speakerAnalysis?.speakers).toHaveLength(1);
    expect(result.segments.every((segment) => segment.speakerId === IDS[0])).toBe(
      true,
    );
  });

  it('does not absorb a filtered cluster between different reliable speakers', () => {
    let nextId = 0;
    const result = alignTranscriptSpeakers(
      [{ startMs: 0, endMs: 1_200, text: 'Alpha glitch bravo' }],
      [
        { startMs: 0, endMs: 500, text: 'Alpha', segmentIndex: 0 },
        { startMs: 500, endMs: 650, text: ' glitch', segmentIndex: 0 },
        { startMs: 650, endMs: 1_200, text: ' bravo', segmentIndex: 0 },
      ],
      [
        { startMs: 0, endMs: 500, cluster: 0 },
        { startMs: 500, endMs: 650, cluster: 99 },
        { startMs: 650, endMs: 1_200, cluster: 1 },
      ],
      () => IDS[nextId++],
    );

    expect(
      result.segments.find((segment) => segment.text === 'glitch')?.speakerId,
    ).toBeNull();
  });

  it('does not move a filtered cluster across a Whisper segment boundary', () => {
    const result = alignTranscriptSpeakers(
      [
        { startMs: 0, endMs: 650, text: 'Before glitch' },
        { startMs: 700, endMs: 1_200, text: 'After' },
      ],
      [
        { startMs: 0, endMs: 500, text: 'Before', segmentIndex: 0 },
        { startMs: 500, endMs: 650, text: ' glitch', segmentIndex: 0 },
        { startMs: 700, endMs: 1_200, text: 'After', segmentIndex: 1 },
      ],
      [
        { startMs: 0, endMs: 500, cluster: 0 },
        { startMs: 500, endMs: 650, cluster: 99 },
        { startMs: 700, endMs: 1_200, cluster: 0 },
      ],
      () => IDS[0],
    );

    expect(
      result.segments.find((segment) => segment.text === 'glitch')?.speakerId,
    ).toBeNull();
  });

  it('leaves equally overlapping speech unlabeled instead of guessing', () => {
    let nextId = 0;
    const result = alignTranscriptSpeakers(
      [{ startMs: 0, endMs: 1_000, text: 'Hello' }],
      [{ startMs: 100, endMs: 900, text: ' Hello', segmentIndex: 0 }],
      [
        { startMs: 100, endMs: 900, cluster: 0 },
        { startMs: 100, endMs: 900, cluster: 1 },
      ],
      () => IDS[nextId++],
    );

    expect(result.segments[0].speakerId).toBeNull();
  });

  it('leaves a narrow overlap winner unlabeled instead of guessing', () => {
    let nextId = 0;
    const result = alignTranscriptSpeakers(
      [{ startMs: 0, endMs: 1_000, text: 'Hello' }],
      [{ startMs: 100, endMs: 900, text: ' Hello', segmentIndex: 0 }],
      [
        { startMs: 100, endMs: 700, cluster: 0 },
        { startMs: 350, endMs: 900, cluster: 1 },
      ],
      () => IDS[nextId++],
    );

    expect(result.segments[0].speakerId).toBeNull();
  });

  it('keeps a clearly dominant overlap winner', () => {
    let nextId = 0;
    const result = alignTranscriptSpeakers(
      [{ startMs: 0, endMs: 1_000, text: 'Hello' }],
      [{ startMs: 100, endMs: 900, text: ' Hello', segmentIndex: 0 }],
      [
        { startMs: 100, endMs: 900, cluster: 0 },
        { startMs: 700, endMs: 900, cluster: 1 },
      ],
      () => IDS[nextId++],
    );

    expect(result.segments[0].speakerId).toBe(IDS[0]);
  });

  it('does not recover an overlap tie between matching speaker anchors', () => {
    let nextId = 0;
    const result = alignTranscriptSpeakers(
      [{ startMs: 0, endMs: 1_200, text: 'Alpha overlap continues' }],
      [
        { startMs: 0, endMs: 300, text: 'Alpha', segmentIndex: 0 },
        { startMs: 500, endMs: 700, text: ' overlap', segmentIndex: 0 },
        { startMs: 710, endMs: 1_200, text: ' continues', segmentIndex: 0 },
      ],
      [
        { startMs: 0, endMs: 300, cluster: 0 },
        { startMs: 500, endMs: 700, cluster: 0 },
        { startMs: 500, endMs: 700, cluster: 1 },
        { startMs: 710, endMs: 1_200, cluster: 0 },
      ],
      () => IDS[nextId++],
    );

    expect(result.segments.find((segment) => segment.text === 'overlap')?.speakerId).toBeNull();
  });

  it('keeps a timing gap unclear when different speakers are equally plausible', () => {
    let nextId = 0;
    const result = alignTranscriptSpeakers(
      [{ startMs: 0, endMs: 1_300, text: 'Alpha maybe bravo' }],
      [
        { startMs: 0, endMs: 500, text: 'Alpha', segmentIndex: 0 },
        { startMs: 600, endMs: 700, text: ' maybe', segmentIndex: 0 },
        { startMs: 800, endMs: 1_300, text: ' bravo', segmentIndex: 0 },
      ],
      [
        { startMs: 0, endMs: 500, cluster: 0 },
        { startMs: 800, endMs: 1_300, cluster: 1 },
      ],
      () => IDS[nextId++],
    );

    expect(withoutWordTimings(result.segments)).toEqual([
      { startMs: 0, endMs: 500, text: 'Alpha', speakerId: IDS[0] },
      { startMs: 600, endMs: 700, text: 'maybe', speakerId: null },
      { startMs: 800, endMs: 1_300, text: 'bravo', speakerId: IDS[1] },
    ]);
  });

  it('keeps a distant opening run unclear despite a later reliable speaker', () => {
    const result = alignTranscriptSpeakers(
      [{ startMs: 0, endMs: 4_500, text: 'Too far known' }],
      [
        { startMs: 0, endMs: 500, text: 'Too', segmentIndex: 0 },
        { startMs: 500, endMs: 1_000, text: ' far', segmentIndex: 0 },
        { startMs: 4_000, endMs: 4_500, text: ' known', segmentIndex: 0 },
      ],
      [{ startMs: 4_000, endMs: 4_500, cluster: 0 }],
      () => IDS[0],
    );

    expect(withoutWordTimings(result.segments)).toEqual([
      { startMs: 0, endMs: 1_000, text: 'Too far', speakerId: null },
      { startMs: 4_000, endMs: 4_500, text: 'known', speakerId: IDS[0] },
    ]);
  });

  it('requires meaningful direct evidence before recovering an opening gap', () => {
    let nextId = 0;
    const result = alignTranscriptSpeakers(
      [{ startMs: 0, endMs: 1_700, text: 'Opening known' }],
      [
        { startMs: 0, endMs: 0, text: 'Opening', segmentIndex: 0 },
        { startMs: 700, endMs: 1_700, text: ' known', segmentIndex: 0 },
      ],
      [
        { startMs: 700, endMs: 1_201, cluster: 0 },
        { startMs: 750, endMs: 1_200, cluster: 1 },
      ],
      () => IDS[nextId++],
    );

    expect(result.segments[0]).toMatchObject({
      startMs: 0,
      endMs: 0,
      text: 'Opening',
      speakerId: null,
    });
  });

  it('does not assign a missed short final speaker to the preceding speaker', () => {
    const result = alignTranscriptSpeakers(
      [{ startMs: 0, endMs: 2_000, text: 'Known missed' }],
      [
        { startMs: 0, endMs: 1_000, text: 'Known', segmentIndex: 0 },
        { startMs: 1_700, endMs: 2_000, text: ' missed', segmentIndex: 0 },
      ],
      [{ startMs: 0, endMs: 1_000, cluster: 0 }],
      () => IDS[0],
    );

    expect(result.segments.at(-1)).toMatchObject({
      startMs: 1_700,
      endMs: 2_000,
      text: 'missed',
      speakerId: null,
    });
  });

  it('does not absorb a longer missed voice between different speakers', () => {
    let nextId = 0;
    const result = alignTranscriptSpeakers(
      [{ startMs: 0, endMs: 4_000, text: 'Alpha missed voice bravo' }],
      [
        { startMs: 0, endMs: 1_000, text: 'Alpha', segmentIndex: 0 },
        { startMs: 2_500, endMs: 3_100, text: ' missed voice', segmentIndex: 0 },
        { startMs: 3_200, endMs: 4_000, text: ' bravo', segmentIndex: 0 },
      ],
      [
        { startMs: 0, endMs: 200, cluster: 0 },
        { startMs: 3_800, endMs: 4_000, cluster: 1 },
      ],
      () => IDS[nextId++],
    );

    expect(
      result.segments.find((segment) => segment.text === 'missed voice')?.speakerId,
    ).toBeNull();
  });

  it('does not move a short missed voice across a Whisper turn boundary', () => {
    let nextId = 0;
    const result = alignTranscriptSpeakers(
      [
        { startMs: 0, endMs: 1_000, text: 'Alpha' },
        { startMs: 1_600, endMs: 1_800, text: 'Missed' },
        { startMs: 1_850, endMs: 2_600, text: 'Bravo' },
      ],
      [
        { startMs: 0, endMs: 1_000, text: 'Alpha', segmentIndex: 0 },
        { startMs: 1_600, endMs: 1_800, text: 'Missed', segmentIndex: 1 },
        { startMs: 1_850, endMs: 2_600, text: 'Bravo', segmentIndex: 2 },
      ],
      [
        { startMs: 0, endMs: 1_000, cluster: 0 },
        { startMs: 2_300, endMs: 2_600, cluster: 1 },
      ],
      () => IDS[nextId++],
    );

    expect(
      result.segments.find((segment) => segment.text === 'Missed')?.speakerId,
    ).toBeNull();
  });

  it('does not guess when full word timing is unavailable', () => {
    const result = alignTranscriptSpeakers(
      [{ startMs: 0, endMs: 5_000, text: 'Two people may speak here.' }],
      [],
      [{ startMs: 0, endMs: 5_000, cluster: 0 }],
      () => IDS[0],
    );

    expect(withoutWordTimings(result.segments)).toEqual([
      {
        startMs: 0,
        endMs: 5_000,
        text: 'Two people may speak here.',
        speakerId: null,
      },
    ]);
  });

  it('does not recover missing word timing between matching speaker turns', () => {
    const result = alignTranscriptSpeakers(
      [
        { startMs: 0, endMs: 500, text: 'Before' },
        { startMs: 600, endMs: 900, text: 'Untimed words' },
        { startMs: 1_000, endMs: 1_500, text: 'After' },
      ],
      [
        { startMs: 0, endMs: 500, text: 'Before', segmentIndex: 0 },
        { startMs: 1_000, endMs: 1_500, text: 'After', segmentIndex: 2 },
      ],
      [
        { startMs: 0, endMs: 500, cluster: 0 },
        { startMs: 1_000, endMs: 1_500, cluster: 0 },
      ],
      () => IDS[0],
    );

    expect(
      result.segments.find((segment) => segment.text === 'Untimed words')?.speakerId,
    ).toBeNull();
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
    expect(withoutWordTimings(result.segments)).toEqual([
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

    expect(result.speakerAnalysis).toBeNull();
    expect(
      withoutWordTimings(result.segments),
    ).toEqual([{ ...original, speakerId: null }]);
  });
});
