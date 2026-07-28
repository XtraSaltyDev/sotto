import { StringDecoder } from 'node:string_decoder';

export interface WhisperProgressParser {
  push(chunk: string | Uint8Array): void;
  end(): void;
}

const WHISPER_PROGRESS_LINE =
  /^whisper_print_progress_callback:\s+progress\s*=\s*(\d{1,3})%$/;

/** Parses one complete whisper.cpp CLI stderr line. */
export const parseWhisperProgressLine = (line: string): number | null => {
  const normalizedLine = line.endsWith('\r') ? line.slice(0, -1) : line;
  const match = WHISPER_PROGRESS_LINE.exec(normalizedLine);
  if (!match) {
    return null;
  }

  const progress = Number.parseInt(match[1], 10);
  return progress >= 0 && progress <= 100 ? progress : null;
};

/** Streams stderr and emits only fully anchored whisper.cpp progress lines. */
export const createWhisperProgressParser = (
  onProgress: (progress: number) => void,
): WhisperProgressParser => {
  let decoder = new StringDecoder('utf8');
  let pending = '';
  let ended = false;

  const handleLine = (line: string): void => {
    const progress = parseWhisperProgressLine(line);
    if (progress !== null) {
      onProgress(progress);
    }
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
        throw new Error('Cannot push whisper progress after the parser has ended.');
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
