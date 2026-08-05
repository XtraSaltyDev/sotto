import { describe, expect, it } from 'vitest';

import type { TranscriptDetail } from '../shared/contracts';
import { speakerDiagnosticsNotice } from './speaker-diagnostics-notice';

type NoticeInput = Pick<TranscriptDetail, 'speakerAnalysis' | 'speakerDiagnostics'>;

const labeled: NonNullable<TranscriptDetail['speakerAnalysis']> = {
  engine: { name: 'sherpa-onnx', version: '1.13.4', model: 'test' },
  speakers: [{ id: '11111111-1111-4111-8111-111111111111', label: 'Speaker 1' }],
};

const input = (overrides: Partial<NoticeInput>): NoticeInput => ({
  speakerAnalysis: null,
  speakerDiagnostics: null,
  ...overrides,
});

describe('speakerDiagnosticsNotice', () => {
  it('explains an over-fragmented pass with the real cluster count', () => {
    const notice = speakerDiagnosticsNotice(input({
      speakerDiagnostics: {
        outcome: 'over-fragmented',
        clusterCount: 156,
        reliableClusterCount: 45,
        labeledSpeakerCount: 0,
      },
    }));

    expect(notice?.headline).toContain('not saved');
    expect(notice?.detail).toContain('156');
    expect(notice?.suggestsExpectedSpeakers).toBe(true);
  });

  it('explains a pass that found nothing confident enough to label', () => {
    const notice = speakerDiagnosticsNotice(input({
      speakerDiagnostics: {
        outcome: 'no-reliable-speakers',
        clusterCount: 3,
        reliableClusterCount: 0,
        labeledSpeakerCount: 0,
      },
    }));

    expect(notice?.detail).toContain('could not match any voice');
    expect(notice?.suggestsExpectedSpeakers).toBe(true);
  });

  it('says nothing when labels were produced', () => {
    expect(speakerDiagnosticsNotice(input({
      speakerAnalysis: labeled,
      speakerDiagnostics: {
        outcome: 'labeled',
        clusterCount: 4,
        reliableClusterCount: 4,
        labeledSpeakerCount: 4,
      },
    }))).toBeNull();
  });

  it('says nothing when the pass simply could not run', () => {
    // macOS below 15.5 and missing speaker resources already explain
    // themselves elsewhere; a second message would only add noise.
    expect(speakerDiagnosticsNotice(input({
      speakerDiagnostics: {
        outcome: 'not-attempted',
        clusterCount: 0,
        reliableClusterCount: 0,
        labeledSpeakerCount: 0,
      },
    }))).toBeNull();
  });

  it('says nothing for transcripts saved before diagnostics existed', () => {
    expect(speakerDiagnosticsNotice(input({}))).toBeNull();
    expect(speakerDiagnosticsNotice({ speakerAnalysis: null } as NoticeInput)).toBeNull();
  });
});
