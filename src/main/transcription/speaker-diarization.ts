import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { UtilityProcess } from 'electron';

import { sanitizeProcessEnvironment } from '../process/process-runner';
import { MAX_TRANSCRIPT_OFFSET_MS, MAX_TRANSCRIPT_SEGMENTS } from './transcript-types';

export const SPEAKER_DIARIZATION_ENGINE = {
  name: 'sherpa-onnx',
  model: 'pyannote-segmentation-3.0 + 3D-Speaker ERes2Net',
  version: '1.13.4',
} as const;

export const MAX_SPEAKER_DIARIZATION_JSON_BYTES = 16 * 1_024 * 1_024;
export const DEFAULT_SPEAKER_DIARIZATION_TIMEOUT_MS = 15 * 60 * 1_000;
const MAX_SPEAKER_DIAGNOSTIC_BYTES = 64 * 1_024;
const MAX_SPEAKER_FAILURE_MESSAGE_BYTES = 4 * 1_024;
const DIARIZATION_PROTOCOL_VERSION = 1;

export interface SpeakerDiarizationSegment {
  startMs: number;
  endMs: number;
  cluster: number;
}

export interface RunSpeakerDiarizationOptions {
  wavPath: string;
  segmentationModelPath: string;
  embeddingModelPath: string;
  childPath: string;
  signal?: AbortSignal;
  modulePath?: string;
  timeoutMs?: number;
}

export class SpeakerDiarizationError extends Error {
  constructor(message = 'The local speaker-separation engine could not process this recording.') {
    super(message);
    this.name = 'SpeakerDiarizationError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const assertInputPath = (
  value: string,
  extensions: readonly string[],
  label: string,
): void => {
  if (
    !path.isAbsolute(value) ||
    !extensions.includes(path.extname(value).toLowerCase())
  ) {
    throw new TypeError(`${label} must be an absolute ${extensions.join(' or ')} file path.`);
  }
};

/**
 * Treats native-addon output as untrusted input before it reaches persistence.
 * The result is sorted because overlapping speaker ranges are valid, while a
 * native engine returning backward or unbounded time values is not.
 */
export const normalizeDiarizationSegments = (
  value: unknown,
): SpeakerDiarizationSegment[] => {
  if (!Array.isArray(value) || value.length > MAX_TRANSCRIPT_SEGMENTS) {
    throw new SpeakerDiarizationError('The speaker engine returned too many or invalid segments.');
  }

  const normalized = value.map((candidate, index) => {
    if (!isRecord(candidate)) {
      throw new SpeakerDiarizationError(`Speaker segment ${index} was invalid.`);
    }

    const startSeconds = candidate.start;
    const endSeconds = candidate.end;
    const cluster = candidate.speaker;
    if (
      typeof startSeconds !== 'number' ||
      !Number.isFinite(startSeconds) ||
      startSeconds < 0 ||
      typeof endSeconds !== 'number' ||
      !Number.isFinite(endSeconds) ||
      endSeconds <= startSeconds ||
      !Number.isSafeInteger(cluster) ||
      (cluster as number) < 0
    ) {
      throw new SpeakerDiarizationError(`Speaker segment ${index} contained invalid timing data.`);
    }

    const startMs = Math.round(startSeconds * 1_000);
    const endMs = Math.round(endSeconds * 1_000);
    if (endMs <= startMs || endMs > MAX_TRANSCRIPT_OFFSET_MS) {
      throw new SpeakerDiarizationError('Speaker timing exceeded Sotto\'s transcript limit.');
    }

    return { startMs, endMs, cluster: cluster as number };
  });

  return normalized.sort(
    (left, right) =>
      left.startMs - right.startMs ||
      left.endMs - right.endMs ||
      left.cluster - right.cluster,
  );
};

export const parseDiarizationChildJson = (
  json: string,
): SpeakerDiarizationSegment[] => {
  if (Buffer.byteLength(json, 'utf8') > MAX_SPEAKER_DIARIZATION_JSON_BYTES) {
    throw new SpeakerDiarizationError('The speaker engine output exceeded its size limit.');
  }

  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    throw new SpeakerDiarizationError('The speaker engine returned unreadable output.');
  }

  if (
    !isRecord(value) ||
    value.schemaVersion !== DIARIZATION_PROTOCOL_VERSION
  ) {
    throw new SpeakerDiarizationError('The speaker engine returned an unsupported output format.');
  }

  if (value.outcome === 'failed') {
    if (
      typeof value.message !== 'string' ||
      value.message.length === 0 ||
      value.message.includes('\0') ||
      Buffer.byteLength(value.message, 'utf8') > MAX_SPEAKER_FAILURE_MESSAGE_BYTES
    ) {
      throw new SpeakerDiarizationError('The speaker engine returned an invalid failure message.');
    }
    throw new SpeakerDiarizationError(value.message);
  }
  if (value.outcome !== 'completed' || !Object.hasOwn(value, 'segments')) {
    throw new SpeakerDiarizationError('The speaker engine returned an unsupported output format.');
  }

  return normalizeDiarizationSegments(value.segments);
};

interface IsolatedDiarizationProcess {
  readonly transport: 'message' | 'stdout';
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  onError(listener: (error: unknown) => void): void;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  onMessage(listener: (message: unknown) => void): void;
  kill(): void;
}

const runtimeRequire = createRequire(__filename);

const adaptUtilityProcess = (child: UtilityProcess): IsolatedDiarizationProcess => ({
  transport: 'message',
  stdout: null,
  stderr: child.stderr,
  onError: (listener) => {
    child.once('error', (type, location) =>
      listener(new Error(`${type}${location ? ` at ${location}` : ''}`)),
    );
  },
  onExit: (listener) => {
    child.once('exit', (code) => listener(code, null));
  },
  onMessage: (listener) => {
    child.on('message', listener);
  },
  kill: () => {
    child.kill();
  },
});

const launchDiarizationProcess = (
  childPath: string,
  args: string[],
): IsolatedDiarizationProcess => {
  const env = sanitizeProcessEnvironment();
  if (process.versions.electron) {
    const electron = runtimeRequire('electron') as typeof import('electron');
    return adaptUtilityProcess(
      electron.utilityProcess.fork(childPath, args, {
        env,
        serviceName: 'Sotto Speaker Separation',
        stdio: ['ignore', 'ignore', 'pipe'],
      }),
    );
  }

  const child = spawn(process.execPath, [childPath, ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return {
    transport: 'stdout',
    stdout: child.stdout,
    stderr: child.stderr,
    onError: (listener) => {
      child.once('error', listener);
    },
    onExit: (listener) => {
      child.once('exit', listener);
    },
    onMessage: () => undefined,
    kill: () => {
      child.kill();
    },
  };
};

const boundedDiagnostic = (chunks: readonly Buffer[]): string | undefined => {
  const message = Buffer.concat(chunks).toString('utf8').trim();
  return message ? message.slice(-1_000) : undefined;
};

/** Runs the synchronous native diarizer in a crash-isolated child process. */
export const runSpeakerDiarization = async (
  options: RunSpeakerDiarizationOptions,
): Promise<SpeakerDiarizationSegment[]> => {
  assertInputPath(options.wavPath, ['.wav'], 'Normalized audio');
  assertInputPath(options.segmentationModelPath, ['.onnx'], 'Speaker segmentation model');
  assertInputPath(options.embeddingModelPath, ['.onnx'], 'Speaker embedding model');
  assertInputPath(options.childPath, ['.cjs', '.js'], 'Speaker child process');

  if (options.signal?.aborted) {
    throw new SpeakerDiarizationError('Speaker separation was cancelled.');
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_SPEAKER_DIARIZATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('Speaker separation timeout must be a positive safe integer.');
  }

  const modulePath = options.modulePath ?? runtimeRequire.resolve('sherpa-onnx-node');
  if (!path.isAbsolute(modulePath)) {
    throw new TypeError('The speaker engine module path must be absolute.');
  }

  return new Promise((resolve, reject) => {
    const child = launchDiarizationProcess(options.childPath, [
      modulePath,
      options.wavPath,
      options.segmentationModelPath,
      options.embeddingModelPath,
    ]);
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutEnded = child.stdout === null;
    let exitCode: number | null | undefined;
    let exitSignal: NodeJS.Signals | null = null;
    let settled = false;

    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
      callback();
    };
    const fail = (message?: string): void => {
      settle(() => reject(new SpeakerDiarizationError(message)));
    };
    const abort = (): void => {
      child.kill();
      fail('Speaker separation was cancelled.');
    };
    const finishIfReady = (): void => {
      if (child.transport !== 'stdout') return;
      if (settled || exitCode === undefined) return;
      if (exitCode !== 0 || exitSignal !== null) {
        fail(boundedDiagnostic(stderrChunks));
        return;
      }
      if (!stdoutEnded) return;

      try {
        const json = Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8');
        settle(() => resolve(parseDiarizationChildJson(json)));
      } catch (error) {
        settle(() => reject(error));
      }
    };

    const timeout = setTimeout(() => {
      child.kill();
      fail('Speaker separation timed out. The text transcript was kept without speaker labels.');
    }, timeoutMs);

    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) {
      abort();
      return;
    }

    if (child.transport === 'message') {
      child.onMessage((message) => {
        if (settled) return;
        if (typeof message !== 'string') {
          child.kill();
          fail('The speaker engine returned an unsupported output format.');
          return;
        }

        try {
          const segments = parseDiarizationChildJson(message);
          child.kill();
          settle(() => resolve(segments));
        } catch (error) {
          child.kill();
          settle(() => reject(error));
        }
      });
    }

    if (child.transport === 'stdout') {
      child.stdout?.on('data', (chunk: Buffer | string) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes += buffer.byteLength;
        if (stdoutBytes > MAX_SPEAKER_DIARIZATION_JSON_BYTES) {
          child.kill();
          fail('The speaker engine output exceeded its size limit.');
          return;
        }
        stdoutChunks.push(buffer);
      });
    }
    const stdoutFinished = (): void => {
      stdoutEnded = true;
      finishIfReady();
    };
    if (child.transport === 'stdout') {
      child.stdout?.once('end', stdoutFinished);
      child.stdout?.once('close', stdoutFinished);
    }

    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (stderrBytes >= MAX_SPEAKER_DIAGNOSTIC_BYTES) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_SPEAKER_DIAGNOSTIC_BYTES - stderrBytes;
      const bounded = buffer.subarray(0, remaining);
      stderrBytes += bounded.byteLength;
      stderrChunks.push(bounded);
    });

    child.onError((error) => {
      fail(error instanceof Error ? error.message : undefined);
    });
    child.onExit((code, signal) => {
      if (child.transport === 'message') {
        fail(boundedDiagnostic(stderrChunks));
        return;
      }
      exitCode = code;
      exitSignal = signal;
      finishIfReady();
    });
  });
};
