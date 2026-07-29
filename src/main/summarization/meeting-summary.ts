import type {
  MeetingSummary,
  MeetingSummaryItem,
} from '../../shared/contracts';
import type { TranscriptRecord } from '../transcription/transcript-types';

const MAX_ITEM_CHARACTERS = 360;
const MAX_OVERVIEW_CHARACTERS = 620;
const MAX_CANDIDATE_CHARACTERS = 720;
const MAX_KEY_POINTS = 5;
const MAX_DECISIONS = 5;
const MAX_ACTION_ITEMS = 5;

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'are', 'because', 'been', 'before',
  'being', 'but', 'can', 'could', 'did', 'does', 'doing', 'for', 'from', 'get',
  'actually', 'anything', 'basically', 'don\'t', 'even', 'got', 'guess', 'had',
  'has', 'have', 'here', 'how', 'into', 'just', 'kind', 'like', 'maybe', 'mean', 'more',
  'most', 'not', 'now', 'okay', 'only', 'our', 'out', 'really', 'right', 'said',
  'should', 'some', 'something', 'stuff', 'that', 'the', 'their', 'them', 'then',
  'there', 'these', 'they', 'thing', 'things', 'think', 'this', 'those', 'through',
  'too', 'very', 'want',
  'was', 'way', 'well', 'were', 'what', 'when', 'where', 'which', 'who', 'why',
  'with', 'would', 'yeah', 'you', 'your',
]);

const DECISION_PATTERN =
  /\b(?:(?:we|the (?:team|group|committee)) (?:agreed|approved|decided) (?:to|that|on)|decision is|settled on|the plan is|we(?:'ll| will) (?:use|choose|launch|move|keep|stop|start|adopt|ship))\b/iu;
const ACTION_VERBS =
  'send|share|prepare|schedule|review|update|deliver|complete|finish|check|confirm|contact|draft|create|fix|investigate|test|publish|write|call|email';
const ACTION_PATTERN = new RegExp(
  `\\b(?:action item|follow[ -]?up(?: on| with)?|please (?:${ACTION_VERBS})|let(?:'s| us) (?:${ACTION_VERBS})|(?:(?:i|we|you|they|he|she)(?:'ll| will| should| need(?:s)? to)|[\\p{L}][\\p{L}'-]+ (?:will|should|need(?:s)? to)) (?:${ACTION_VERBS}))\\b`,
  'iu',
);
const SENTENCE_END_PATTERN = /[.!?]["'”’)]*$/u;
const SENTENCE_PIECE_PATTERN = /[^.!?]+(?:[.!?]+["'”’)]*|$)/gu;
const SPOKEN_TURN_PREFIX_PATTERN = /^[-–—]\s*/u;

interface Candidate extends MeetingSummaryItem {
  index: number;
  wordCount: number;
  words: string[];
}

const normalizeText = (value: string): string =>
  value.replace(/\s+/gu, ' ').trim();

const boundedText = (value: string, maximum: number): string => {
  if (value.length <= maximum) return value;
  const clipped = value.slice(0, Math.max(0, maximum - 1)).trimEnd();
  const lastSpace = clipped.lastIndexOf(' ');
  return `${lastSpace >= maximum * 0.65 ? clipped.slice(0, lastSpace) : clipped}…`;
};

const meaningfulWords = (value: string): string[] =>
  (value.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]{2,}/gu) ?? [])
    .filter((word) => !STOP_WORDS.has(word));

const wordCount = (value: string): number =>
  value.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu)?.length ?? 0;

const sentenceCandidates = (record: TranscriptRecord): Candidate[] => {
  const candidates: Candidate[] = [];
  let pending: MeetingSummaryItem | null = null;

  const flush = (): void => {
    if (!pending) return;
    const text = boundedText(
      normalizeText(pending.text).replace(SPOKEN_TURN_PREFIX_PATTERN, ''),
      MAX_ITEM_CHARACTERS,
    );
    if (text.length >= 8) {
      candidates.push({
        ...pending,
        index: candidates.length,
        text,
        wordCount: wordCount(text),
        words: meaningfulWords(text),
      });
    }
    pending = null;
  };

  for (const segment of record.segments) {
    const segmentText = normalizeText(segment.text);
    if (!segmentText) continue;

    const startsSpokenTurn = SPOKEN_TURN_PREFIX_PATTERN.test(segmentText);
    const changesKnownSpeaker = Boolean(
      pending?.speakerId &&
      segment.speakerId &&
      pending.speakerId !== segment.speakerId,
    );
    if (pending && (startsSpokenTurn || changesKnownSpeaker)) flush();

    const pieces = segmentText.match(SENTENCE_PIECE_PATTERN) ?? [segmentText];
    for (const rawPiece of pieces) {
      const piece = normalizeText(rawPiece);
      if (!piece) continue;
      if (
        pending &&
        pending.text.length + piece.length + 1 > MAX_CANDIDATE_CHARACTERS
      ) {
        flush();
      }

      if (pending) {
        pending.text = `${pending.text} ${piece}`;
        if (pending.speakerId !== segment.speakerId) pending.speakerId = null;
      } else {
        pending = {
          speakerId: segment.speakerId,
          startMs: segment.startMs,
          text: piece,
        };
      }

      if (SENTENCE_END_PATTERN.test(piece)) flush();
    }
  }
  flush();
  return candidates;
};

const isUsefulSignal = (candidate: Candidate, pattern: RegExp): boolean =>
  candidate.text.length >= 20 &&
  candidate.words.length >= 3 &&
  pattern.test(candidate.text);

const distinctItems = (
  candidates: readonly Candidate[],
  maximum: number,
): MeetingSummaryItem[] => {
  const seen = new Set<string>();
  const items: MeetingSummaryItem[] = [];
  for (const candidate of candidates) {
    const key = candidate.text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      text: candidate.text,
      startMs: candidate.startMs,
      speakerId: candidate.speakerId,
    });
    if (items.length === maximum) break;
  }
  return items;
};

const selectKeyPoints = (
  candidates: readonly Candidate[],
): { items: MeetingSummaryItem[]; overviewItems: MeetingSummaryItem[] } => {
  const frequencies = new Map<string, number>();
  for (const candidate of candidates) {
    for (const word of new Set(candidate.words)) {
      frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
    }
  }

  const ranked = candidates
    .filter(
      (candidate) =>
        candidate.text.length >= 24 &&
        candidate.words.length >= 3 &&
        candidate.words.length / Math.max(1, candidate.wordCount) >= 0.23,
    )
    .map((candidate) => {
      const termScore = candidate.words.reduce(
        (score, word) =>
          score + Math.log2(Math.max(1, frequencies.get(word) ?? 0)),
        0,
      );
      const emphasis =
        (DECISION_PATTERN.test(candidate.text) ? 1.8 : 0) +
        (ACTION_PATTERN.test(candidate.text) ? 1.2 : 0);
      return {
        candidate,
        score: termScore / Math.sqrt(candidate.words.length) + emphasis,
      };
    })
    .sort((left, right) =>
      right.score - left.score || left.candidate.index - right.candidate.index,
    );

  const selected: Candidate[] = [];
  const selectedWords: Array<Set<string>> = [];
  const informative = ranked.some(({ score }) => score > 0)
    ? ranked.filter(({ score }) => score > 0)
    : ranked;
  for (const { candidate } of informative) {
    const words = new Set(candidate.words);
    const duplicatesExisting = selectedWords.some((existing) => {
      const overlap = [...words].filter((word) => existing.has(word)).length;
      return overlap >= 3 && overlap / Math.min(words.size, existing.size) >= 0.65;
    });
    if (duplicatesExisting) continue;
    selected.push(candidate);
    selectedWords.push(words);
    if (selected.length === MAX_KEY_POINTS) break;
  }

  return {
    items: distinctItems(
      [...selected].sort((left, right) => left.index - right.index),
      MAX_KEY_POINTS,
    ),
    overviewItems: distinctItems(selected, 2),
  };
};

export const buildMeetingSummary = (
  record: TranscriptRecord,
): MeetingSummary | null => {
  const candidates = sentenceCandidates(record);
  if (candidates.length === 0) return null;

  const keyPointSelection = selectKeyPoints(candidates);
  const keyPoints = keyPointSelection.items;
  const fallback = keyPoints.length > 0
    ? keyPoints
    : distinctItems(candidates, Math.min(3, MAX_KEY_POINTS));
  const overviewItems = keyPointSelection.overviewItems.length > 0
    ? keyPointSelection.overviewItems
    : fallback;
  const overview = boundedText(
    overviewItems.slice(0, 2).map((item) => item.text).join(' '),
    MAX_OVERVIEW_CHARACTERS,
  );

  return {
    overview,
    keyPoints: fallback,
    decisions: distinctItems(
      candidates.filter((candidate) => isUsefulSignal(candidate, DECISION_PATTERN)),
      MAX_DECISIONS,
    ),
    actionItems: distinctItems(
      candidates.filter((candidate) => isUsefulSignal(candidate, ACTION_PATTERN)),
      MAX_ACTION_ITEMS,
    ),
  };
};
