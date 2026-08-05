import type { LocalAiSummaryPreview } from '../shared/contracts';

export interface LocalAiPreviewDocument {
  label: string;
  body: string;
}

export interface LocalAiSummaryActivity {
  /** This transcript's own summary is running. */
  generating: boolean;
  /** This transcript is approved and waiting its turn. */
  queued: boolean;
  /** A different transcript is running, so a new send would have to wait. */
  runningElsewhere: boolean;
}

/**
 * Resolves what the summary controls should show for the open transcript.
 * Every part of this is scoped to a transcript id: a run started on one
 * transcript must never make another look busy, which an unscoped in-flight
 * flag previously did.
 */
export const localAiSummaryActivity = ({
  activeTranscriptId,
  queuedTranscriptIds,
  requestTranscriptId,
  selectedTranscriptId,
}: {
  activeTranscriptId: string | null;
  queuedTranscriptIds: readonly string[];
  /** Set between invoking a send and the first state event, to avoid a flicker. */
  requestTranscriptId: string | null;
  selectedTranscriptId: string | null;
}): LocalAiSummaryActivity => {
  if (selectedTranscriptId === null) {
    return { generating: false, queued: false, runningElsewhere: false };
  }
  return {
    generating:
      requestTranscriptId === selectedTranscriptId ||
      activeTranscriptId === selectedTranscriptId,
    queued: queuedTranscriptIds.includes(selectedTranscriptId),
    runningElsewhere:
      activeTranscriptId !== null && activeTranscriptId !== selectedTranscriptId,
  };
};

const formatCount = (count: number, singular: string, plural: string): string =>
  `${count.toLocaleString()} ${count === 1 ? singular : plural}`;

/**
 * Approximate size of the outbound text. Characters rather than bytes, because
 * the point is to convey scale to a person deciding whether to send, not to
 * state a transport measurement they cannot check.
 */
export const formatLocalAiPayloadSize = (characterCount: number): string =>
  characterCount < 1_000
    ? `${characterCount.toLocaleString()} characters`
    : `about ${(Math.round(characterCount / 1_000) * 1_000).toLocaleString()} characters`;

/** Plain-language scale, for deciding whether to send rather than auditing. */
export const describeLocalAiSendScope = (
  preview: LocalAiSummaryPreview,
): string =>
  `${formatCount(preview.segmentCount, 'line', 'lines')} of this transcript, ${formatLocalAiPayloadSize(preview.characterCount)}`;

export const describeLocalAiSpeakers = (
  preview: LocalAiSummaryPreview,
): string =>
  preview.speakerLabels.length === 0
    ? 'No speaker names'
    : preview.speakerLabels.join(', ');

/**
 * How the send is split up. Only surfaced when it is more than one request,
 * since a single call needs no explanation.
 */
export const describeLocalAiRequestCount = (
  preview: LocalAiSummaryPreview,
): string | null => {
  const requests = preview.transcriptRequests.length +
    (preview.needsConsolidationRequest ? 1 : 0);
  return requests === 1
    ? null
    : `Sent as ${formatCount(requests, 'request', 'requests')} because the transcript is long.`;
};

export interface LocalAiTranscriptLine {
  startMs: number;
  speaker: string | null;
  text: string;
}

const isTranscriptLine = (value: unknown): value is {
  startMs: number;
  speaker: unknown;
  text: string;
} =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { startMs?: unknown }).startMs === 'number' &&
  typeof (value as { text?: unknown }).text === 'string';

/**
 * Renders the outbound requests as readable transcript lines by parsing the
 * very text that will be sent, rather than from a parallel copy. A readable
 * view built from a second source could disagree with the real payload; this
 * one cannot. Anything that does not parse is simply omitted here — the exact
 * request text stays available alongside it.
 */
export const localAiTranscriptLines = (
  preview: LocalAiSummaryPreview,
): LocalAiTranscriptLine[] =>
  preview.transcriptRequests.flatMap((request) =>
    request.split('\n').flatMap((line): LocalAiTranscriptLine[] => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) return [];
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return [];
      }
      if (!isTranscriptLine(parsed)) return [];
      return [{
        startMs: parsed.startMs,
        speaker: typeof parsed.speaker === 'string' ? parsed.speaker : null,
        text: parsed.text,
      }];
    }),
  );

/**
 * Every message that leaves the device, in send order. The instructions are
 * listed once rather than repeated per request, since they are identical, but
 * the note makes that repetition explicit instead of implying a single send.
 */
export const localAiPreviewDocuments = (
  preview: LocalAiSummaryPreview,
): LocalAiPreviewDocument[] => {
  const total = preview.transcriptRequests.length;
  return [
    {
      label:
        total === 1
          ? 'Instructions'
          : `Instructions (sent with each of the ${total} requests)`,
      body: preview.systemPrompt,
    },
    ...preview.transcriptRequests.map((body, index) => ({
      label: total === 1 ? 'Transcript' : `Transcript part ${index + 1} of ${total}`,
      body,
    })),
  ];
};

export const LOCAL_AI_CONSOLIDATION_NOTE =
  'One further request combines the model’s own replies to the parts above. It carries no transcript text beyond what those replies contain, and its exact wording is not known until they arrive.';
