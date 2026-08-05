/**
 * Serializes live-recording chunk writes to the main process.
 *
 * The encoder emits a chunk every second regardless of how the previous write
 * is going, so the writes have to be chained rather than raced: the private
 * recording file is appended to in order, and two concurrent appends would
 * interleave. The first failure is latched and reported once — after that the
 * capture is finished, and continuing to queue writes against a file that is
 * already broken only delays the honest error.
 */
export class LiveRecordingChunkQueue {
  private chain: Promise<void> = Promise.resolve();
  private failure: string | null = null;
  private notified = false;

  constructor(
    private readonly options: {
      /** Writes one chunk, rejecting or returning a reason when it fails. */
      write: (chunk: ArrayBuffer) => Promise<{ rejected: string | null }>;
      /** Called once, on the first failure, to stop the capture. */
      onFailure: (reason: string) => void;
    },
  ) {}

  /** The reason the capture stopped being writable, if it did. */
  get failureReason(): string | null {
    return this.failure;
  }

  /**
   * Queues one chunk behind the writes already in flight. The buffer is read
   * inside the queued step so that decoding is serialized too, rather than
   * every pending chunk being held in memory at once.
   */
  enqueue(readChunk: () => Promise<ArrayBuffer>): void {
    if (this.failure !== null) return;
    const write = this.chain.then(async () => {
      if (this.failure !== null) return;
      const result = await this.options.write(await readChunk());
      if (result.rejected !== null) throw new Error(result.rejected);
    });
    this.chain = write.catch((error: unknown) => {
      this.fail(
        error instanceof Error
          ? error.message
          : 'Sotto could not save the live recording.',
      );
    });
  }

  /** Resolves once every queued write has settled, successfully or not. */
  drain(): Promise<void> {
    return this.chain;
  }

  private fail(reason: string): void {
    if (this.failure !== null) return;
    this.failure = reason;
    if (this.notified) return;
    this.notified = true;
    this.options.onFailure(reason);
  }

  /** Records a failure raised outside a write, such as an encoder error. */
  reportFailure(reason: string): void {
    this.fail(reason);
  }
}
