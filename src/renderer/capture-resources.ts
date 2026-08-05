/**
 * The operating-system resources one live capture holds: the desktop and
 * microphone streams, the audio graph mixing them, and the encoder.
 *
 * They are grouped because releasing them is an ordering problem, not a
 * bookkeeping one. Every failure path in the capture flow has to let go of all
 * of them, and a stream left running keeps the microphone or screen-share
 * indicator lit long after Sotto believes it stopped. Release is idempotent so
 * the error path and the normal path can both call it.
 */

/** The parts of a MediaStream this needs, so tests need not build a real one. */
export interface ReleasableStream {
  getTracks(): Array<{ stop(): void }>;
}

export interface ClosableAudioContext {
  readonly state: string;
  close(): Promise<void>;
}

export interface StoppableRecorder {
  readonly state: string;
}

export class CaptureResources {
  private desktopStream: ReleasableStream | null = null;
  private microphoneStream: ReleasableStream | null = null;
  private audioContext: ClosableAudioContext | null = null;
  private recorder: StoppableRecorder | null = null;

  claimDesktopStream(stream: ReleasableStream | null): void {
    this.desktopStream = stream;
  }

  claimMicrophoneStream(stream: ReleasableStream | null): void {
    this.microphoneStream = stream;
  }

  claimAudioContext(context: ClosableAudioContext | null): void {
    this.audioContext = context;
  }

  claimRecorder(recorder: StoppableRecorder | null): void {
    this.recorder = recorder;
  }

  get activeRecorder(): StoppableRecorder | null {
    return this.recorder;
  }

  get hasDesktopStream(): boolean {
    return this.desktopStream !== null;
  }

  /**
   * Stops both streams and closes the audio graph. References are dropped
   * before the awaited close so a second call cannot double-release, and a
   * failure closing the context still leaves every track stopped.
   */
  async release(): Promise<void> {
    this.recorder = null;
    const streams = [this.desktopStream, this.microphoneStream];
    this.desktopStream = null;
    this.microphoneStream = null;
    const context = this.audioContext;
    this.audioContext = null;

    for (const stream of streams) {
      for (const track of stream?.getTracks() ?? []) {
        track.stop();
      }
    }
    if (context && context.state !== 'closed') await context.close();
  }
}
