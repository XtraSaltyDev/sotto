import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type {
  SavedRecordingSummary,
  TranscriptSummary,
} from '../shared/contracts';
import { MeetingLibrary } from './MeetingLibrary';

const transcript: TranscriptSummary = {
  id: '32ce6fee-8f3e-4f03-a266-46d6c00ef08c',
  title: 'Teams planning meeting',
  sourceName: 'Live meeting.webm',
  createdAt: '2026-07-27T12:00:00.000Z',
  durationMs: 60_000,
  language: 'en',
  preview: 'A transcript preview.',
  tags: [],
};

const linkedRecording: SavedRecordingSummary = {
  id: transcript.id,
  sourceName: 'Live meeting.webm',
  startedAt: '2026-07-27T12:00:00.000Z',
  completedAt: '2026-07-27T12:05:00.000Z',
  sizeBytes: 1_024,
  transcriptionState: 'completed',
  message: 'Transcript ready. The original recording is still saved.',
  transcriptId: transcript.id,
};

const renderLibrary = (
  recordings: SavedRecordingSummary[],
  transcripts: TranscriptSummary[],
) =>
  renderToStaticMarkup(
    <MeetingLibrary
      busyId={null}
      onDeleteAll={vi.fn()}
      onDeleteRecording={vi.fn()}
      onDeleteTranscript={vi.fn()}
      onExportRecording={vi.fn()}
      onOpen={vi.fn()}
      onRetryRecording={vi.fn()}
      onViewStateChange={vi.fn()}
      recordings={recordings}
      transcripts={transcripts}
      viewState={{ query: '', dateRange: 'all', speaker: '', tag: '' }}
    />,
  );

describe('Meeting Library deletion actions', () => {
  it('offers Delete all inside the menu for a linked recording and transcript', () => {
    const markup = renderLibrary([linkedRecording], [transcript]);

    expect(markup).toContain('Delete all');
    expect(markup).toMatch(
      /meeting-row__menu-panel[\s\S]*Delete all/,
    );
  });

  it('does not offer Delete all when only one retained item exists', () => {
    expect(renderLibrary([], [transcript])).not.toContain('Delete all');
    expect(renderLibrary([linkedRecording], [])).not.toContain('Delete all');
  });
});
