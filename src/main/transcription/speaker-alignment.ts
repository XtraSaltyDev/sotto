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
const persistedWords = (words: readonly WhisperWord[]) =>
  words.map(({ startMs, endMs, text }) => ({ startMs, endMs, text }));
const isPunctuationOnly = (value: string): boolean =>
  normalizeText(value).length > 0 && !/[\p{L}\p{N}]/u.test(value);
const MAX_SAME_SPEAKER_RUN_DURATION_MS = 750;
const MAX_SAME_SPEAKER_TEXT_CHARACTERS = 60;
const MAX_SAME_SPEAKER_NEIGHBOR_GAP_MS = 750;
const MAX_OPENING_RUN_DURATION_MS = 1_000;
const MAX_OPENING_TEXT_CHARACTERS = 60;
const MAX_OPENING_NEIGHBOR_GAP_MS = 1_000;
const MAX_TRANSITION_RUN_DURATION_MS = 300;
const MAX_TRANSITION_TEXT_CHARACTERS = 30;
const MAX_TRANSITION_NEXT_GAP_MS = 250;
const MIN_TRANSITION_ADVANTAGE_MS = 300;
const MIN_DIRECT_SUPPORT_MS = 200;
const MIN_DIRECT_MARGIN_MS = 100;
const MIN_DIRECT_DOMINANCE_RATIO = 1.5;
export const MAX_RELIABLE_AUTOMATIC_SPEAKERS = 12;
const MIN_RELIABLE_CLUSTER_SUPPORT_MS = 200;
const MAX_RELIABLE_CLUSTER_SUPPORT_MS = 5_000;
const RELIABLE_CLUSTER_SUPPORT_RATIO = 0.0025;

interface ClusterChoice {
  cluster: number | null;
  evidence: 'ambiguous-overlap' | 'nearby' | 'overlap' | 'timing-gap';
  directSupportMs: number;
  competingSupportMs: number;
}

const indirectChoice = (
  cluster: number | null,
  evidence: 'nearby' | 'timing-gap',
): ClusterChoice => ({
  cluster,
  evidence,
  directSupportMs: 0,
  competingSupportMs: 0,
});

const overlapMs = (
  startMs: number,
  endMs: number,
  span: SpeakerDiarizationSegment,
): number => Math.max(0, Math.min(endMs, span.endMs) - Math.max(startMs, span.startMs));

const chooseCluster = (
  startMs: number,
  endMs: number,
  diarization: readonly SpeakerDiarizationSegment[],
): ClusterChoice => {
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
      return indirectChoice(before.cluster, 'nearby');
    }
    if (beforeDistance <= 500 && beforeDistance + 250 < afterDistance) {
      return before
        ? indirectChoice(before.cluster, 'nearby')
        : indirectChoice(null, 'timing-gap');
    }
    if (afterDistance <= 500 && afterDistance + 250 < beforeDistance) {
      return after
        ? indirectChoice(after.cluster, 'nearby')
        : indirectChoice(null, 'timing-gap');
    }
    return indirectChoice(null, 'timing-gap');
  }
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) {
    return {
      cluster: null,
      evidence: 'ambiguous-overlap',
      directSupportMs: ranked[0][1],
      competingSupportMs: ranked[1][1],
    };
  }
  return {
    cluster: ranked[0][0],
    evidence: 'overlap',
    directSupportMs: ranked[0][1],
    competingSupportMs: ranked[1]?.[1] ?? 0,
  };
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
  words: readonly WhisperWord[],
  createId: SpeakerIdFactory,
): { speakers: TranscriptSpeaker[]; ids: Map<number, string> } => {
  const supportByCluster = new Map<number, number>();
  let totalSupportMs = 0;
  for (const word of words) {
    if (isPunctuationOnly(word.text)) continue;
    const choice = chooseCluster(word.startMs, word.endMs, diarization);
    if (choice.cluster === null || choice.directSupportMs <= 0) continue;
    supportByCluster.set(
      choice.cluster,
      (supportByCluster.get(choice.cluster) ?? 0) + choice.directSupportMs,
    );
    totalSupportMs += choice.directSupportMs;
  }

  const minimumSupportMs = Math.max(
    MIN_RELIABLE_CLUSTER_SUPPORT_MS,
    Math.min(
      MAX_RELIABLE_CLUSTER_SUPPORT_MS,
      Math.round(totalSupportMs * RELIABLE_CLUSTER_SUPPORT_RATIO),
    ),
  );
  let supported = [...supportByCluster.entries()]
    .filter(([, supportMs]) => supportMs >= minimumSupportMs)
    .sort((left, right) => right[1] - left[1] || left[0] - right[0])
    .slice(0, Math.min(MAX_RELIABLE_AUTOMATIC_SPEAKERS, MAX_TRANSCRIPT_SPEAKERS));
  if (supported.length === 0 && diarization.length > 0) {
    const diarizationSupport = new Map<number, number>();
    for (const span of diarization) {
      diarizationSupport.set(
        span.cluster,
        (diarizationSupport.get(span.cluster) ?? 0) + span.endMs - span.startMs,
      );
    }
    supported = [...diarizationSupport.entries()]
      .sort((left, right) => right[1] - left[1] || left[0] - right[0])
      .slice(0, 1);
  }
  const supportedClusters = new Set(supported.map(([cluster]) => cluster));
  const clusters = clusterOrder(diarization)
    .filter((cluster) => supportedClusters.has(cluster));

  const ids = new Map<number, string>();
  const speakers = clusters.map((cluster, index): TranscriptSpeaker => {
    const id = createId();
    ids.set(cluster, id);
    return { id, label: `Speaker ${index + 1}` };
  });
  return { speakers, ids };
};

type AssignedWord = WhisperWord & ClusterChoice;

type UnclearReason = 'ambiguous-overlap' | 'missing-timing' | 'timing-gap';

interface AlignedTranscriptSegment extends TranscriptSegment {
  unclearReason: UnclearReason | null;
  directSupportMs: number;
  competingSupportMs: number;
  sourceSegmentIndex: number;
  recovered: boolean;
}

const segmentGapMs = (
  left: AlignedTranscriptSegment,
  right: AlignedTranscriptSegment,
): number => Math.max(0, right.startMs - left.endMs);

const hasStableDirectEvidence = (segment: AlignedTranscriptSegment): boolean =>
  segment.directSupportMs >= MIN_DIRECT_SUPPORT_MS &&
  segment.directSupportMs - segment.competingSupportMs >= MIN_DIRECT_MARGIN_MS &&
  (segment.competingSupportMs === 0 ||
    segment.directSupportMs / segment.competingSupportMs >=
      MIN_DIRECT_DOMINANCE_RATIO);

interface StableNeighbor {
  boundary: AlignedTranscriptSegment;
  speakerId: string;
}

const findStableNeighbor = (
  segments: readonly AlignedTranscriptSegment[],
  startIndex: number,
): StableNeighbor | null => {
  const boundary = segments[startIndex];
  return boundary?.speakerId &&
    !boundary.recovered &&
    hasStableDirectEvidence(boundary)
    ? { boundary, speakerId: boundary.speakerId }
    : null;
};

const isSingleShortRun = (
  run: readonly AlignedTranscriptSegment[],
  maximumDurationMs: number,
  maximumTextCharacters: number,
): boolean =>
  run.length === 1 &&
  run[0].endMs - run[0].startMs <= maximumDurationMs &&
  run[0].text.length <= maximumTextCharacters;

const sharesSourceSegment = (
  run: readonly AlignedTranscriptSegment[],
  neighbor: AlignedTranscriptSegment,
): boolean =>
  run.every(
    (segment) => segment.sourceSegmentIndex === neighbor.sourceSegmentIndex,
  );

const stripAlignmentEvidence = (
  segments: readonly AlignedTranscriptSegment[],
): TranscriptSegment[] =>
  segments.map((segment) => ({
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: segment.text,
    speakerId: segment.speakerId,
    words: segment.words,
  }));

/**
 * Reconciles short timing-gap runs only after the whole transcript has been
 * aligned. Direct overlap ties and missing token timing stay unclear.
 */
const finalizeSpeakerAssignments = (
  segments: readonly AlignedTranscriptSegment[],
): TranscriptSegment[] => {
  const finalized = segments.map((segment) => ({ ...segment }));

  for (let runStart = 0; runStart < finalized.length;) {
    if (finalized[runStart].speakerId !== null) {
      runStart += 1;
      continue;
    }

    let runEnd = runStart + 1;
    while (
      runEnd < finalized.length &&
      finalized[runEnd].speakerId === null
    ) {
      runEnd += 1;
    }

    const run = finalized.slice(runStart, runEnd);
    if (run.some((segment) => segment.unclearReason !== 'timing-gap')) {
      runStart = runEnd;
      continue;
    }

    const left = finalized[runStart - 1];
    const right = finalized[runEnd];
    const leftNeighbor = findStableNeighbor(finalized, runStart - 1);
    const rightNeighbor = findStableNeighbor(finalized, runEnd);
    const leftGapMs = left ? segmentGapMs(left, run[0]) : Number.POSITIVE_INFINITY;
    const rightGapMs = right
      ? segmentGapMs(run.at(-1)!, right)
      : Number.POSITIVE_INFINITY;
    let recoveredSpeakerId: string | null = null;

    if (
      isSingleShortRun(
        run,
        MAX_SAME_SPEAKER_RUN_DURATION_MS,
        MAX_SAME_SPEAKER_TEXT_CHARACTERS,
      ) &&
      leftNeighbor &&
      rightNeighbor &&
      leftNeighbor.speakerId === rightNeighbor.speakerId &&
      leftGapMs <= MAX_SAME_SPEAKER_NEIGHBOR_GAP_MS &&
      rightGapMs <= MAX_SAME_SPEAKER_NEIGHBOR_GAP_MS
    ) {
      recoveredSpeakerId = leftNeighbor.speakerId;
    } else if (
      isSingleShortRun(
        run,
        MAX_OPENING_RUN_DURATION_MS,
        MAX_OPENING_TEXT_CHARACTERS,
      ) &&
      runStart === 0 &&
      rightNeighbor &&
      rightGapMs <= MAX_OPENING_NEIGHBOR_GAP_MS &&
      sharesSourceSegment(run, rightNeighbor.boundary)
    ) {
      recoveredSpeakerId = rightNeighbor.speakerId;
    } else if (
      isSingleShortRun(
        run,
        MAX_TRANSITION_RUN_DURATION_MS,
        MAX_TRANSITION_TEXT_CHARACTERS,
      ) &&
      leftNeighbor &&
      rightNeighbor &&
      leftNeighbor.speakerId !== rightNeighbor.speakerId &&
      rightGapMs <= MAX_TRANSITION_NEXT_GAP_MS &&
      leftGapMs - rightGapMs >= MIN_TRANSITION_ADVANTAGE_MS &&
      sharesSourceSegment(run, rightNeighbor.boundary)
    ) {
      recoveredSpeakerId = rightNeighbor.speakerId;
    }

    if (recoveredSpeakerId) {
      for (let index = runStart; index < runEnd; index += 1) {
        finalized[index] = {
          ...finalized[index],
          speakerId: recoveredSpeakerId,
          unclearReason: null,
          directSupportMs: 0,
          competingSupportMs: 0,
          recovered: true,
        };
      }
    }
    runStart = runEnd;
  }

  return stripAlignmentEvidence(finalized);
};

const alignWhisperSegment = (
  segment: WhisperTranscriptSegment,
  sourceSegmentIndex: number,
  segmentWords: readonly WhisperWord[],
  diarization: readonly SpeakerDiarizationSegment[],
  ids: ReadonlyMap<number, string>,
): AlignedTranscriptSegment[] => {
  const reconstructed = normalizeText(segmentWords.map((word) => word.text).join(''));
  if (segmentWords.length === 0 || reconstructed !== segment.text) {
    // A whole Whisper segment can contain multiple speakers. Without complete
    // token timing, assigning a dominant voice would silently mislabel words.
    return [{
      ...segment,
      speakerId: null,
      words: [],
      unclearReason: 'missing-timing',
      directSupportMs: 0,
      competingSupportMs: 0,
      sourceSegmentIndex,
      recovered: false,
    }];
  }

  const assigned: AssignedWord[] = segmentWords.map((word) => {
    const choice = chooseCluster(word.startMs, word.endMs, diarization);
    return { ...word, ...choice };
  });

  // Punctuation timing often stretches across silence. Keep it with the word
  // before it rather than treating punctuation as a new speaker turn.
  assigned.forEach((word, index) => {
    if (index > 0 && isPunctuationOnly(word.text)) {
      word.cluster = assigned[index - 1].cluster;
      word.evidence = assigned[index - 1].evidence;
      word.directSupportMs = 0;
      word.competingSupportMs = 0;
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
  return groups.flatMap((group): AlignedTranscriptSegment[] => {
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
      words: persistedWords(group),
      unclearReason:
        group[0].cluster === null
          ? group.every((word) => word.evidence === 'timing-gap')
            ? 'timing-gap'
            : 'ambiguous-overlap'
          : null,
      directSupportMs: group.reduce(
        (total, word) => total + word.directSupportMs,
        0,
      ),
      competingSupportMs: group.reduce(
        (total, word) => total + word.competingSupportMs,
        0,
      ),
      sourceSegmentIndex,
      recovered: false,
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
  const wordsBySegment = new Map<number, WhisperWord[]>();
  for (const word of words) {
    const segmentWords = wordsBySegment.get(word.segmentIndex);
    if (segmentWords) segmentWords.push(word);
    else wordsBySegment.set(word.segmentIndex, [word]);
  }
  const unlabeled = (): SpeakerAlignmentResult => ({
    speakerAnalysis: null,
    segments: segments.map((segment, index) => {
      const segmentWords = wordsBySegment.get(index) ?? [];
      const reconstructed = normalizeText(segmentWords.map((word) => word.text).join(''));
      return {
        ...segment,
        speakerId: null,
        words: reconstructed === segment.text ? persistedWords(segmentWords) : [],
      };
    }),
  });

  if (!Number.isSafeInteger(maximumSegments) || maximumSegments < segments.length) {
    return unlabeled();
  }

  if (diarization.length === 0) {
    return unlabeled();
  }

  const { speakers, ids } = createSpeakerMap(diarization, words, createId);
  if (speakers.length === 0) {
    return unlabeled();
  }

  const alignedSegments: AlignedTranscriptSegment[] = [];
  for (const [index, segment] of segments.entries()) {
    const aligned = alignWhisperSegment(
      segment,
      index,
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
    segments: finalizeSpeakerAssignments(alignedSegments),
  };
};
