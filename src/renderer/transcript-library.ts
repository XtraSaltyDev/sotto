import type { TranscriptLibraryQuery } from '../shared/contracts';

export type TranscriptLibraryDateRange =
  | 'all'
  | 'today'
  | '7-days'
  | '30-days'
  | 'this-year';

export const transcriptLibraryCreatedFrom = (
  range: TranscriptLibraryDateRange,
  now = new Date(),
): string | null => {
  if (range === 'all') return null;
  const from = new Date(now);
  if (range === 'today') {
    from.setHours(0, 0, 0, 0);
  } else if (range === 'this-year') {
    from.setMonth(0, 1);
    from.setHours(0, 0, 0, 0);
  } else {
    from.setTime(
      now.getTime() -
        (range === '7-days' ? 7 : 30) * 24 * 60 * 60 * 1_000,
    );
  }
  return from.toISOString();
};

export const createTranscriptLibraryQuery = ({
  dateRange,
  speaker,
  tag,
  text,
  now,
}: {
  dateRange: TranscriptLibraryDateRange;
  speaker: string;
  tag: string;
  text: string;
  now?: Date;
}): TranscriptLibraryQuery => ({
  text: text.trim(),
  createdFrom: transcriptLibraryCreatedFrom(dateRange, now),
  speaker: speaker || null,
  tag: tag || null,
});

export type ParsedTagDraft =
  | { ok: true; tags: string[] }
  | { ok: false; reason: string };

export const parseTranscriptTagDraft = (draft: string): ParsedTagDraft => {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const candidate of draft.split(',')) {
    const tag = candidate.replace(/\s+/gu, ' ').trim();
    if (!tag) continue;
    if (tag.length > 48) {
      return {
        ok: false,
        reason: 'Each tag must be 48 characters or fewer.',
      };
    }
    const key = tag.toLocaleLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      tags.push(tag);
    }
  }
  if (tags.length > 32) {
    return { ok: false, reason: 'Use no more than 32 tags.' };
  }
  return { ok: true, tags };
};
