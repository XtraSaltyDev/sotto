import type { TranscriptRecord } from '../transcription/transcript-types';

/**
 * Ground-truth speaker annotation in the shape the speaker-accuracy harness
 * reads. Produced from a transcript the user has corrected by hand, so the
 * ranges are Sotto's own segment boundaries with human-verified labels.
 *
 * That inheritance is the format's one limitation and it is deliberate:
 * measuring label accuracy against known boundaries answers the question this
 * was built for — how many speakers, and which line belongs to whom — while
 * costing an afternoon rather than a week of boundary marking. It cannot
 * measure boundary error, and it cannot see speech the transcript missed.
 */
export interface SpeakerAnnotation {
  schemaVersion: 1;
  durationMs: number;
  speakers: string[];
  ranges: Array<{ startMs: number; endMs: number; speaker: string }>;
  words: [];
}

/** Segments with no speaker are omitted: unlabeled is not a claim about who spoke. */
export const buildSpeakerAnnotation = (
  record: TranscriptRecord,
): SpeakerAnnotation => {
  const labelById = new Map(
    (record.speakerAnalysis?.speakers ?? []).map((speaker) => [
      speaker.id,
      speaker.label,
    ]),
  );
  const ranges = record.segments.flatMap((segment) => {
    const label = segment.speakerId ? labelById.get(segment.speakerId) : undefined;
    return label === undefined
      ? []
      : [{ startMs: segment.startMs, endMs: segment.endMs, speaker: label }];
  });
  // Only speakers that actually carry a range: an unused label would inflate
  // the reference count and make the measurement flatter than the truth.
  const used = [...new Set(ranges.map((range) => range.speaker))].sort(
    (left, right) => left.localeCompare(right),
  );
  return {
    schemaVersion: 1,
    durationMs: record.durationMs,
    speakers: used,
    ranges,
    words: [],
  };
};

export const formatSpeakerAnnotation = (record: TranscriptRecord): string =>
  `${JSON.stringify(buildSpeakerAnnotation(record), null, 2)}\n`;
