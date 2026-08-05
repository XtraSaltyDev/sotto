/**
 * Channel layout of a live meeting recording.
 *
 * Sotto captures two independent sources — the desktop mix carrying remote
 * participants, and the local microphone. Which one a voice arrived on is the
 * only perfectly reliable speaker signal in the system: the person at this
 * computer is always on the microphone and never in the Teams mix. Summing
 * them into one channel throws that away before anything downstream can use
 * it, and no amount of voice clustering recovers it.
 *
 * Separation is only used when both sources are actually present. A
 * microphone-only capture stays single-source, because putting it on one side
 * of a stereo pair would halve its level once transcription downmixes to mono
 * for whisper.cpp — a real cost for no information gained.
 */
export const CAPTURE_CHANNELS = {
  /** Remote participants, as mixed by the meeting application. */
  desktop: 0,
  /** The person at this computer. */
  microphone: 1,
} as const;

export const CAPTURE_CHANNEL_COUNT = 2;

/** How a saved recording's audio channels should be read. */
export type RecordingChannelLayout =
  /** One source, or two sources summed together; channels carry no meaning. */
  | 'mixed'
  /** Desktop on channel 0, microphone on channel 1. */
  | 'desktop-microphone';

/**
 * Separation is worth it only when both sources carry audio. A capture that
 * has just one of them gains nothing from being spread across a stereo pair.
 */
export const recordingChannelLayout = (sources: {
  hasDesktopAudio: boolean;
  hasMicrophoneAudio: boolean;
}): RecordingChannelLayout =>
  sources.hasDesktopAudio && sources.hasMicrophoneAudio
    ? 'desktop-microphone'
    : 'mixed';
