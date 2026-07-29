export interface SearchableTranscriptSegment {
  text: string;
}

export const matchingTranscriptSegmentIndexes = (
  segments: readonly SearchableTranscriptSegment[],
  query: string,
): number[] => {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) return [];

  return segments.flatMap((segment, index) =>
    segment.text.toLowerCase().includes(normalizedQuery) ? [index] : [],
  );
};

export const adjacentSearchResult = (
  current: number,
  resultCount: number,
  direction: 1 | -1,
): number => {
  if (resultCount === 0) return -1;
  if (current < 0 || current >= resultCount) {
    return direction === 1 ? 0 : resultCount - 1;
  }
  return (current + direction + resultCount) % resultCount;
};
