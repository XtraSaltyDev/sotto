import type {
  SavedRecordingSummary,
  TranscriptSummary,
} from '../shared/contracts';

export interface MeetingLibraryItem {
  key: string;
  recording: SavedRecordingSummary | null;
  sortAt: string;
  transcript: TranscriptSummary | null;
}

export const mergeMeetingLibraryItems = (
  transcripts: TranscriptSummary[],
  recordings: SavedRecordingSummary[],
): MeetingLibraryItem[] => {
  const recordingsByTranscriptId = new Map<string, SavedRecordingSummary>();

  for (const recording of recordings) {
    if (recording.transcriptId) {
      recordingsByTranscriptId.set(recording.transcriptId, recording);
    }
  }

  const transcriptIds = new Set(transcripts.map((transcript) => transcript.id));
  const items: MeetingLibraryItem[] = transcripts.map((transcript) => ({
    key: `transcript:${transcript.id}`,
    recording: recordingsByTranscriptId.get(transcript.id) ?? null,
    sortAt: transcript.createdAt,
    transcript,
  }));

  for (const recording of recordings) {
    if (recording.transcriptId && transcriptIds.has(recording.transcriptId)) {
      continue;
    }
    items.push({
      key: `recording:${recording.id}`,
      recording,
      sortAt: recording.completedAt,
      transcript: null,
    });
  }

  return items.sort((left, right) => {
    const dateOrder = Date.parse(right.sortAt) - Date.parse(left.sortAt);
    return dateOrder || left.key.localeCompare(right.key);
  });
};
