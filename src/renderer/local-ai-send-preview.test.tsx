import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { LocalAiSummaryPreview } from '../shared/contracts';
import { LocalAiBusyNotice } from './LocalAiBusyNotice';
import { LocalAiSendPreview } from './LocalAiSendPreview';
import {
  describeLocalAiRequestCount,
  localAiSummaryActivity,
  describeLocalAiSendScope,
  describeLocalAiSpeakers,
  formatLocalAiPayloadSize,
  localAiPreviewDocuments,
  localAiTranscriptLines,
} from './local-ai-send-preview';

const transcriptRequest = (...lines: string[]): string =>
  `Summarize transcript section 1 of 1.\n\nTRANSCRIPT SEGMENTS (JSON lines):\n${lines.join('\n')}\n`;

const createPreview = (
  overrides: Partial<LocalAiSummaryPreview> = {},
): LocalAiSummaryPreview => ({
  transcriptId: '32ce6fee-8f3e-4f03-a266-46d6c00ef08c',
  endpoint: 'http://127.0.0.1:11434/v1/chat/completions',
  model: 'gemma3:4b',
  sendsApiKey: false,
  systemPrompt: 'Summarize only what the transcript supports.',
  transcriptRequests: ['{"segmentIndex":0,"text":"Sarah will send the draft."}'],
  needsConsolidationRequest: false,
  segmentCount: 1,
  speakerLabels: ['Sarah'],
  characterCount: 640,
  approvalFingerprint: 'a'.repeat(64),
  ...overrides,
});

describe('formatLocalAiPayloadSize', () => {
  it('states an exact count for small payloads and an approximate one above a thousand', () => {
    expect(formatLocalAiPayloadSize(640)).toBe('640 characters');
    expect(formatLocalAiPayloadSize(14_200)).toBe('about 14,000 characters');
  });
});

describe('describeLocalAiSendScope', () => {
  it('states the scale in plain language', () => {
    expect(describeLocalAiSendScope(createPreview({
      segmentCount: 412,
      characterCount: 38_000,
    }))).toBe('412 lines of this transcript, about 38,000 characters');
  });

  it('uses singular wording for a one-line transcript', () => {
    expect(describeLocalAiSendScope(createPreview())).toBe(
      '1 line of this transcript, 640 characters',
    );
  });
});

describe('describeLocalAiRequestCount', () => {
  it('stays silent when the send is a single request', () => {
    expect(describeLocalAiRequestCount(createPreview())).toBeNull();
  });

  it('counts the consolidation request the user cannot see in advance', () => {
    expect(describeLocalAiRequestCount(createPreview({
      transcriptRequests: ['one', 'two', 'three'],
      needsConsolidationRequest: true,
    }))).toBe('Sent as 4 requests because the transcript is long.');
  });
});

describe('describeLocalAiSpeakers', () => {
  it('names every label that leaves the device', () => {
    expect(describeLocalAiSpeakers(createPreview({
      speakerLabels: ['Morgan', 'Sarah'],
    }))).toBe('Morgan, Sarah');
  });

  it('says so plainly when no label is attached', () => {
    expect(describeLocalAiSpeakers(createPreview({ speakerLabels: [] }))).toBe(
      'No speaker names',
    );
  });
});

describe('localAiSummaryActivity', () => {
  const A = 'aaaaaaaa-0000-4000-8000-000000000001';
  const B = 'bbbbbbbb-0000-4000-8000-000000000002';

  it('does not make an unrelated transcript look busy while another generates', () => {
    // The reported bug: opening B during A's run showed B as generating.
    expect(localAiSummaryActivity({
      activeTranscriptId: A,
      queuedTranscriptIds: [],
      requestTranscriptId: A,
      selectedTranscriptId: B,
    })).toEqual({ generating: false, queued: false, runningElsewhere: true });
  });

  it('shows the running transcript as generating', () => {
    expect(localAiSummaryActivity({
      activeTranscriptId: A,
      queuedTranscriptIds: [],
      requestTranscriptId: null,
      selectedTranscriptId: A,
    })).toEqual({ generating: true, queued: false, runningElsewhere: false });
  });

  it('covers the gap before the first state event arrives', () => {
    expect(localAiSummaryActivity({
      activeTranscriptId: null,
      queuedTranscriptIds: [],
      requestTranscriptId: A,
      selectedTranscriptId: A,
    }).generating).toBe(true);
  });

  it('reports a waiting transcript as queued, not generating', () => {
    expect(localAiSummaryActivity({
      activeTranscriptId: A,
      queuedTranscriptIds: [B],
      requestTranscriptId: null,
      selectedTranscriptId: B,
    })).toEqual({ generating: false, queued: true, runningElsewhere: true });
  });

  it('is inert with no transcript open', () => {
    expect(localAiSummaryActivity({
      activeTranscriptId: A,
      queuedTranscriptIds: [B],
      requestTranscriptId: A,
      selectedTranscriptId: null,
    })).toEqual({ generating: false, queued: false, runningElsewhere: false });
  });
});

describe('LocalAiBusyNotice', () => {
  it('names the running transcript and offers to queue or cancel', () => {
    const markup = renderToStaticMarkup(
      <LocalAiBusyNotice
        onCancel={vi.fn()}
        onQueue={vi.fn()}
        runningTitle="Launch planning"
      />,
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('A summary is already being generated');
    expect(markup).toContain('Launch planning');
    expect(markup).toContain('Review and queue');
    expect(markup).toContain('>Cancel<');
  });

  it('stays accurate when the running transcript has no title yet', () => {
    const markup = renderToStaticMarkup(
      <LocalAiBusyNotice onCancel={vi.fn()} onQueue={vi.fn()} runningTitle={null} />,
    );

    expect(markup).toContain('Sotto is finishing another summary.');
  });
});

describe('localAiTranscriptLines', () => {
  it('reads the readable view out of the text that will actually be sent', () => {
    expect(localAiTranscriptLines(createPreview({
      transcriptRequests: [transcriptRequest(
        '{"segmentIndex":0,"startMs":1000,"speaker":"Morgan","text":"Opening remark."}',
        '{"segmentIndex":1,"startMs":12000,"speaker":null,"text":"Unattributed reply."}',
      )],
    }))).toEqual([
      { startMs: 1_000, speaker: 'Morgan', text: 'Opening remark.' },
      { startMs: 12_000, speaker: null, text: 'Unattributed reply.' },
    ]);
  });

  it('spans every request in send order', () => {
    expect(localAiTranscriptLines(createPreview({
      transcriptRequests: [
        transcriptRequest('{"startMs":0,"speaker":"A","text":"First."}'),
        transcriptRequest('{"startMs":5000,"speaker":"B","text":"Second."}'),
      ],
    })).map((line) => line.text)).toEqual(['First.', 'Second.']);
  });

  it('drops unparseable lines rather than inventing content', () => {
    expect(localAiTranscriptLines(createPreview({
      transcriptRequests: [transcriptRequest('{not json', '{"noText":true}')],
    }))).toEqual([]);
  });
});

describe('localAiPreviewDocuments', () => {
  it('lists the instructions once and marks them as repeated across requests', () => {
    expect(localAiPreviewDocuments(createPreview({
      systemPrompt: 'Rules.',
      transcriptRequests: ['part one', 'part two'],
    }))).toEqual([
      { label: 'Instructions (sent with each of the 2 requests)', body: 'Rules.' },
      { label: 'Transcript part 1 of 2', body: 'part one' },
      { label: 'Transcript part 2 of 2', body: 'part two' },
    ]);
  });

  it('keeps labels simple when there is only one request', () => {
    expect(localAiPreviewDocuments(createPreview()).map((entry) => entry.label))
      .toEqual(['Instructions', 'Transcript']);
  });
});

describe('LocalAiSendPreview', () => {
  const readablePreview = createPreview({
    transcriptRequests: [transcriptRequest(
      '{"segmentIndex":0,"startMs":12000,"speaker":"Sarah","text":"Sarah will send the draft."}',
    )],
  });

  it('leads with a readable transcript and the destination', () => {
    const markup = renderToStaticMarkup(
      <LocalAiSendPreview
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        preview={readablePreview}
      />,
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('Send this transcript to gemma3:4b?');
    expect(markup).toContain('http://127.0.0.1:11434/v1/chat/completions');
    // Rendered as a timestamped line, not as raw JSON.
    expect(markup).toContain('0:12');
    expect(markup).toContain('Sarah will send the draft.');
    expect(markup).toContain('>Send<');
    expect(markup).toContain('>Cancel<');
  });

  it('keeps the literal request text available behind a disclosure', () => {
    const markup = renderToStaticMarkup(
      <LocalAiSendPreview
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        preview={readablePreview}
      />,
    );

    expect(markup).toContain('Show the exact request text');
    expect(markup).toContain('Summarize only what the transcript supports.');
    expect(markup).toContain('TRANSCRIPT SEGMENTS');
  });

  it('mentions the API key only when one is actually attached', () => {
    expect(renderToStaticMarkup(
      <LocalAiSendPreview
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        preview={createPreview()}
      />,
    )).not.toContain('API key');

    expect(renderToStaticMarkup(
      <LocalAiSendPreview
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        preview={createPreview({ sendsApiKey: true })}
      />,
    )).toContain('Your saved key is sent with the request.');
  });

  it('never claims an empty transcript when the exact text has content', () => {
    const markup = renderToStaticMarkup(
      <LocalAiSendPreview
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        preview={createPreview({ transcriptRequests: ['unrecognized shape'] })}
      />,
    );

    expect(markup).toContain('could not lay this request out');
    expect(markup).toContain('unrecognized shape');
  });

  it('explains the consolidation request instead of implying a single send', () => {
    const markup = renderToStaticMarkup(
      <LocalAiSendPreview
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        preview={createPreview({
          transcriptRequests: ['part one', 'part two'],
          needsConsolidationRequest: true,
        })}
      />,
    );

    expect(markup).toContain('Sent as 3 requests because the transcript is long.');
    expect(markup).toContain('One further request combines');
    expect(markup).toContain('is not known until they arrive');
  });

  it('never renders the approval fingerprint as if it were content to review', () => {
    const markup = renderToStaticMarkup(
      <LocalAiSendPreview
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        preview={createPreview()}
      />,
    );

    expect(markup).not.toContain('a'.repeat(64));
  });
});
