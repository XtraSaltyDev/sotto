import type {
  MeetingSummary,
  MeetingSummaryItem,
} from '../../shared/contracts';
import type { TranscriptRecord } from '../transcription/transcript-types';

const MAX_ITEM_CHARACTERS = 360;
const MAX_OVERVIEW_CHARACTERS = 620;
const MAX_KEY_POINTS = 5;
const MAX_DECISIONS = 6;
const MAX_ACTION_ITEMS = 8;

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'are', 'because', 'been', 'before',
  'being', 'but', 'can', 'could', 'did', 'does', 'doing', 'for', 'from', 'get',
  'got', 'had', 'has', 'have', 'here', 'how', 'into', 'just', 'like', 'more',
  'most', 'not', 'now', 'okay', 'only', 'our', 'out', 'really', 'right', 'said',
  'should', 'some', 'that', 'the', 'their', 'them', 'then', 'there', 'these',
  'they', 'thing', 'think', 'this', 'those', 'through', 'too', 'very', 'want',
  'was', 'way', 'well', 'were', 'what', 'when', 'where', 'which', 'who', 'why',
  'with', 'would', 'yeah', 'you', 'your',
]);

const DECISION_PATTERN =
  /\b(?:agreed|approved|decided|decision is|settled on|the plan is|we(?:'ll| will) (?:use|choose|launch|move|keep|stop|start|adopt|ship))\b/iu;
const ACTION_PATTERN =
  /\b(?:action item|follow[ -]?up|need(?:s)? to|please|let(?:'s| us)|(?:i|we|you|they|he|she|[\p{L}][\p{L}'-]+) (?:will|can) (?:send|share|prepare|schedule|review|update|deliver|complete|finish|check|confirm|contact|draft|create|fix|investigate|test|publish|write|call|email))\b/iu;

interface Candidate extends MeetingSummaryItem {
  index: number;
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

const sentenceCandidates = (record: TranscriptRecord): Candidate[] => {
  const candidates: Candidate[] = [];
  for (const segment of record.segments) {
    const sentences = normalizeText(segment.text)
      .split(/(?<=[.!?])\s+(?=[\p{L}\p{N}])/u)
      .map(normalizeText)
      .filter((text) => text.length >= 8);
    for (const text of sentences) {
      candidates.push({
        index: candidates.length,
        speakerId: segment.speakerId,
        startMs: segment.startMs,
        text: boundedText(text, MAX_ITEM_CHARACTERS),
        words: meaningfulWords(text),
      });
    }
  }
  return candidates;
};

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

const selectKeyPoints = (candidates: readonly Candidate[]): MeetingSummaryItem[] => {
  const frequencies = new Map<string, number>();
  for (const candidate of candidates) {
    for (const word of new Set(candidate.words)) {
      frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
    }
  }

  const ranked = candidates
    .filter((candidate) => candidate.text.length >= 24 && candidate.words.length >= 3)
    .map((candidate) => {
      const termScore = candidate.words.reduce(
        (score, word) => score + Math.log2(1 + (frequencies.get(word) ?? 0)),
        0,
      );
      const emphasis =
        (DECISION_PATTERN.test(candidate.text) ? 1.8 : 0) +
        (ACTION_PATTERN.test(candidate.text) ? 1.2 : 0);
      const positionBonus = candidate.index < Math.max(2, candidates.length * 0.12)
        ? 0.45
        : 0;
      return {
        candidate,
        score: termScore / Math.sqrt(candidate.words.length) + emphasis + positionBonus,
      };
    })
    .sort((left, right) =>
      right.score - left.score || left.candidate.index - right.candidate.index,
    );

  const selected: Candidate[] = [];
  const selectedWords: Array<Set<string>> = [];
  for (const { candidate } of ranked) {
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

  return distinctItems(
    selected.sort((left, right) => left.index - right.index),
    MAX_KEY_POINTS,
  );
};

export const buildMeetingSummary = (
  record: TranscriptRecord,
): MeetingSummary | null => {
  const candidates = sentenceCandidates(record);
  if (candidates.length === 0) return null;

  const keyPoints = selectKeyPoints(candidates);
  const fallback = keyPoints.length > 0
    ? keyPoints
    : distinctItems(candidates, Math.min(3, MAX_KEY_POINTS));
  const overview = boundedText(
    fallback.slice(0, 2).map((item) => item.text).join(' '),
    MAX_OVERVIEW_CHARACTERS,
  );

  return {
    overview,
    keyPoints: fallback,
    decisions: distinctItems(
      candidates.filter((candidate) => DECISION_PATTERN.test(candidate.text)),
      MAX_DECISIONS,
    ),
    actionItems: distinctItems(
      candidates.filter((candidate) => ACTION_PATTERN.test(candidate.text)),
      MAX_ACTION_ITEMS,
    ),
  };
};
