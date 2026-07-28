import { StringDecoder } from 'node:string_decoder';

export type FfmpegProgressPhase = 'continue' | 'end';

export interface FfmpegProgressRecord {
  readonly phase: FfmpegProgressPhase;
  readonly fields: Readonly<Record<string, string>>;
}

export interface FfmpegProgressParser {
  push(chunk: string | Uint8Array): void;
  end(): void;
}

const PROGRESS_KEY = /^[a-zA-Z0-9_]+$/;

/**
 * Parses FFmpeg's `-progress pipe:1` key/value protocol. Records are emitted
 * only at its documented `progress=continue` and `progress=end` boundaries.
 */
export const createFfmpegProgressParser = (
  onRecord: (record: FfmpegProgressRecord) => void,
): FfmpegProgressParser => {
  let decoder = new StringDecoder('utf8');
  let pending = '';
  let fields: Record<string, string> = {};
  let ended = false;

  const handleLine = (input: string): void => {
    const line = input.endsWith('\r') ? input.slice(0, -1) : input;
    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) {
      return;
    }

    const key = line.slice(0, separatorIndex);
    if (!PROGRESS_KEY.test(key)) {
      return;
    }

    const value = line.slice(separatorIndex + 1);
    fields[key] = value;

    if (key !== 'progress' || (value !== 'continue' && value !== 'end')) {
      return;
    }

    onRecord({
      phase: value,
      fields: Object.freeze({ ...fields }),
    });
    fields = {};
  };

  const processCompleteLines = (): void => {
    let newlineIndex = pending.indexOf('\n');
    while (newlineIndex >= 0) {
      handleLine(pending.slice(0, newlineIndex));
      pending = pending.slice(newlineIndex + 1);
      newlineIndex = pending.indexOf('\n');
    }
  };

  const append = (chunk: string | Uint8Array): void => {
    if (typeof chunk === 'string') {
      pending += decoder.end();
      decoder = new StringDecoder('utf8');
      pending += chunk;
    } else {
      pending += decoder.write(Buffer.from(chunk));
    }

    processCompleteLines();
  };

  return {
    push(chunk): void {
      if (ended) {
        throw new Error('Cannot push FFmpeg progress after the parser has ended.');
      }

      append(chunk);
    },
    end(): void {
      if (ended) {
        return;
      }

      ended = true;
      pending += decoder.end();
      processCompleteLines();
      if (pending.length > 0) {
        handleLine(pending);
        pending = '';
      }
    },
  };
};
