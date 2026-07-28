import {
  createTranscriptSpeakerId,
  MAX_TRANSCRIPT_SEGMENTS,
  MAX_TRANSCRIPT_SPEAKERS,
  type TranscriptSegment,
  type TranscriptSpeaker,
  type TranscriptSpeakerAnalysis,
} from './transcript-types';
import {
  SPEAKER_DIARIZATION_ENGINE,
  type SpeakerDiarizationSegment,
} from './speaker-diarization';
import type {
  WhisperTranscriptSegment,
  WhisperWord,
} from './whisper-output';

export interface SpeakerAlignmentResult {
  speakerAnalysis: TranscriptSpeakerAnalysis | null;
  segments: TranscriptSegment[];
}

type SpeakerIdFactory = () => string;

const normalizeText = (value: string): string => value.replace(/\s+/gu, ' ').trim();
const isPunctuationOnly = (value: string): boolean =>
  normalizeText(value).length > 0 && !/[\p{L}\p{N}]/u.test(value);

const overlapMs = (
  startMs: number,
  endMs: number,
  span: SpeakerDiarizationSegment,
): number => Math.max(0, Math.min(endMs, span.endMs) - Math.max(startMs, span.startMs));

const chooseCluster = (
  startMs: number,
  endMs: number,
  diarization: readonly SpeakerDiarizationSegment[],
): number | null => {
  const scores = new Map<number, number>();

  if (startMs === endMs) {
    for (const span of diarization) {
      if (span.startMs <= startMs && startMs <= span.endMs) {
        scores.set(span.cluster, (scores.get(span.cluster) ?? 0) + 1);
      }
    }
  } else {
    for (const span of diarization) {
      const overlap = overlapMs(startMs, endMs, span);
      if (overlap > 0) {
        scores.set(span.cluster, (scores.get(span.cluster) ?? 0) + overlap);
      }
    }
  }

  const ranked = [...scores.entries()].sort(
    (left, right) => right[1] - left[1] || left[0] - right[0],
  );
  if (ranked.length === 0) {
    const before = diarization
      .filter((span) => span.endMs <= startMs)
      .sort((left, right) => right.endMs - left.endMs)[0];
    const after = diarization
      .filter((span) => span.startMs >= endMs)
      .sort((left, right) => left.startMs - right.startMs)[0];
    const beforeDistance = before ? startMs - before.endMs : Number.POSITIVE_INFINITY;
    const afterDistance = after ? after.startMs - endMs : Number.POSITIVE_INFINITY;
    if (
      before &&
      after &&
      before.cluster === after.cluster &&
      beforeDistance <= 1_000 &&
      afterDistance <= 1_000
    ) {
      return before.cluster;
    }
    if (beforeDistance <= 500 && beforeDistance + 250 < afterDistance) {
      return before?.cluster ?? null;
    }
    if (afterDistance <= 500 && afterDistance + 250 < beforeDistance) {
      return after?.cluster ?? null;
    }
    return null;
  }
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return null;
  return ranked[0][0];
};

const clusterOrder = (
  diarization: readonly SpeakerDiarizationSegment[],
): number[] => {
  const seen = new Set<number>();
  const clusters: number[] = [];
  for (const span of diarization) {
    if (!seen.has(span.cluster)) {
      seen.add(span.cluster);
      clusters.push(span.cluster);
    }
  }
  return clusters;
};

const createSpeakerMap = (
  diarization: readonly SpeakerDiarizationSegment[],
  createId: SpeakerIdFactory,
): { speakers: TranscriptSpeaker[]; ids: Map<number, string> } => {
  const clusters = clusterOrder(diarization);
  if (clusters.length > MAX_TRANSCRIPT_SPEAKERS) {
    return { speakers: [], ids: new Map() };
  }

  const ids = new Map<number, string>();
  const speakers = clusters.map((cluster, index): TranscriptSpeaker => {
    const id = createId();
    ids.set(cluster, id);
    return { id, label: `Speaker ${index + 1}` };
  });
  return { speakers, ids };
};

interface AssignedWord extends WhisperWord {
  cluster: number | null;
}

const alignWhisperSegment = (
  segment: WhisperTranscriptSegment,
  segmentWords: readonly WhisperWord[],
  diarization: readonly SpeakerDiarizationSegment[],
  ids: ReadonlyMap<number, string>,
): TranscriptSegment[] => {
  const reconstructed = normalizeText(segmentWords.map((word) => word.text).join(''));
  if (segmentWords.length === 0 || reconstructed !== segment.text) {
    // A whole Whisper segment can contain multiple speakers. Without complete
    // token timing, assigning a dominant voice would silently mislabel words.
    return [{ ...segment, speakerId: null }];
  }

  const assigned: AssignedWord[] = segmentWords.map((word) => ({
    ...word,
    cluster: chooseCluster(word.startMs, word.endMs, diarization),
  }));

  // Punctuation timing often stretches across silence. Keep it with the word
  // before it rather than treating punctuation as a new speaker turn.
  assigned.forEach((word, index) => {
    if (index > 0 && isPunctuationOnly(word.text)) {
      word.cluster = assigned[index - 1].cluster;
    }
  });

  const groups: AssignedWord[][] = [];
  for (const word of assigned) {
    const current = groups.at(-1);
    if (!current || current[0].cluster !== word.cluster) {
      groups.push([word]);
    } else {
      current.push(word);
    }
  }

  let previousEndMs = segment.startMs;
  return groups.flatMap((group): TranscriptSegment[] => {
    const text = normalizeText(group.map((word) => word.text).join(''));
    if (!text) return [];

    const startMs = Math.max(previousEndMs, segment.startMs, group[0].startMs);
    const endMs = Math.max(
      startMs,
      Math.min(segment.endMs, group.at(-1)?.endMs ?? startMs),
    );
    previousEndMs = endMs;
    return [{
      startMs,
      endMs,
      text,
      speakerId: group[0].cluster === null ? null : (ids.get(group[0].cluster) ?? null),
    }];
  });
};

/**
 * Gives diarization clusters transcript-local UUIDs, then aligns Whisper words
 * to those clusters. Labels are stable within the saved transcript only; no
 * biometric voiceprint is stored or reused across meetings.
 */
export const alignTranscriptSpeakers = (
  segments: readonly WhisperTranscriptSegment[],
  words: readonly WhisperWord[],
  diarization: readonly SpeakerDiarizationSegment[],
  createId: SpeakerIdFactory = createTranscriptSpeakerId,
  maximumSegments = MAX_TRANSCRIPT_SEGMENTS,
): SpeakerAlignmentResult => {
  const unlabeled = (): SpeakerAlignmentResult => ({
    speakerAnalysis: null,
    segments: segments.map((segment) => ({ ...segment, speakerId: null })),
  });

  if (!Number.isSafeInteger(maximumSegments) || maximumSegments < segments.length) {
    return unlabeled();
  }

  if (diarization.length === 0) {
    return unlabeled();
  }

  const { speakers, ids } = createSpeakerMap(diarization, createId);
  if (speakers.length === 0) {
    return unlabeled();
  }

  const wordsBySegment = new Map<number, WhisperWord[]>();
  for (const word of words) {
    const segmentWords = wordsBySegment.get(word.segmentIndex);
    if (segmentWords) segmentWords.push(word);
    else wordsBySegment.set(word.segmentIndex, [word]);
  }

  const alignedSegments: TranscriptSegment[] = [];
  for (const [index, segment] of segments.entries()) {
    const aligned = alignWhisperSegment(
      segment,
      wordsBySegment.get(index) ?? [],
      diarization,
      ids,
    );
    if (alignedSegments.length + aligned.length > maximumSegments) {
      // Speaker labels must never turn a valid Whisper transcript into a
      // record that the bounded repository rejects.
      return unlabeled();
    }
    alignedSegments.push(...aligned);
  }

  return {
    speakerAnalysis: {
      engine: { ...SPEAKER_DIARIZATION_ENGINE },
      speakers,
    },
    segments: alignedSegments,
  };
};
