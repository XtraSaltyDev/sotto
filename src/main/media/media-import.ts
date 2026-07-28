import path from 'node:path';

export const SUPPORTED_AUDIO_EXTENSIONS = [
  '.aac',
  '.flac',
  '.m4a',
  '.mp3',
  '.ogg',
  '.opus',
  '.wav',
  '.webm',
] as const;

export const SUPPORTED_VIDEO_EXTENSIONS = [
  '.avi',
  '.m4v',
  '.mkv',
  '.mov',
  '.mp4',
  '.webm',
  '.wmv',
] as const;

export const MAX_MEDIA_FILE_BYTES = 20 * 1024 * 1024 * 1024;

export interface SelectedMedia {
  extension: string;
  mediaKind: 'audio' | 'video';
  name: string;
  path: string;
  sizeBytes: number;
  sourceType?: 'imported-file' | 'recording';
  /** Links a durable live recording to its job and transcript without exposing a path. */
  recordingId?: string;
  /** Only true processing inputs may be removed after the pipeline consumes them. */
  cleanupAfterTranscription?: boolean;
}

export type MediaImportValidation =
  | { ok: true; media: SelectedMedia }
  | { ok: false; reason: string };

const audioExtensions = new Set<string>(SUPPORTED_AUDIO_EXTENSIONS);
const videoExtensions = new Set<string>(SUPPORTED_VIDEO_EXTENSIONS);

export const validateSelectedMedia = (
  filePath: string,
  sizeBytes: number,
): MediaImportValidation => {
  const extension = path.extname(filePath).toLowerCase();
  const isAudio = audioExtensions.has(extension);
  const isVideo = videoExtensions.has(extension);

  if (!isAudio && !isVideo) {
    return {
      ok: false,
      reason: 'Choose a common audio or video recording, such as MP3, WAV, M4A, MP4, MOV, MKV, or WebM.',
    };
  }

  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    return { ok: false, reason: 'The selected media file is empty or unreadable.' };
  }

  if (sizeBytes > MAX_MEDIA_FILE_BYTES) {
    return { ok: false, reason: 'The selected media file is larger than 20 GB.' };
  }

  return {
    ok: true,
    media: {
      extension: extension.slice(1).toUpperCase(),
      mediaKind: isVideo && !isAudio ? 'video' : 'audio',
      name: path.basename(filePath),
      path: filePath,
      sizeBytes,
    },
  };
};
