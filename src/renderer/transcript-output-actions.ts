import type {
  TranscriptCopyKind,
  TranscriptExportFormat,
} from '../shared/contracts';

export const TRANSCRIPT_EXPORT_OPTIONS: ReadonlyArray<{
  format: TranscriptExportFormat;
  label: string;
}> = [
  { format: 'minutes-docx', label: 'Meeting minutes (DOCX)' },
  { format: 'docx', label: 'Full transcript (DOCX)' },
  { format: 'txt', label: 'Full transcript (TXT)' },
  { format: 'srt', label: 'Subtitles (SRT)' },
  { format: 'vtt', label: 'Subtitles (WebVTT)' },
  { format: 'json', label: 'Portable transcript data (JSON)' },
];

export const TRANSCRIPT_COPY_OPTIONS: ReadonlyArray<{
  kind: TranscriptCopyKind;
  label: string;
}> = [
  { kind: 'overview', label: 'Overview' },
  { kind: 'key-points', label: 'Key points' },
  { kind: 'decisions', label: 'Decisions' },
  { kind: 'action-items', label: 'Action items' },
  { kind: 'meeting-minutes', label: 'Complete meeting minutes' },
];

export const transcriptCopySuccessMessage = (
  kind: TranscriptCopyKind,
): string => {
  const option = TRANSCRIPT_COPY_OPTIONS.find((candidate) => candidate.kind === kind);
  return `${option?.label ?? 'Meeting output'} copied.`;
};

export const transcriptExportFailureLabel = (
  format: TranscriptExportFormat,
): string => {
  const option = TRANSCRIPT_EXPORT_OPTIONS.find(
    (candidate) => candidate.format === format,
  );
  return option?.label ?? 'transcript file';
};
