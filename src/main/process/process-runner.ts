import { spawn } from 'node:child_process';
import path from 'node:path';

export const DEFAULT_MAX_DIAGNOSTIC_BYTES = 64 * 1024;

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface RunProcessOptions {
  readonly executable: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly maxDiagnosticBytes?: number;
  readonly onStdout?: (chunk: Buffer) => void;
  readonly onStderr?: (chunk: Buffer) => void;
}

export class ProcessAbortedError extends Error {
  readonly result: ProcessResult;

  constructor(result: ProcessResult) {
    super('The process was cancelled.');
    this.name = 'ProcessAbortedError';
    this.result = result;
  }
}

const isUnsafeEnvironmentKey = (key: string): boolean => {
  const normalizedKey = key.toUpperCase();

  return (
    normalizedKey.startsWith('DYLD_') ||
    normalizedKey === 'LD_PRELOAD' ||
    normalizedKey === 'NODE_OPTIONS'
  );
};

/**
 * Returns a detached copy of an environment suitable for a bundled native
 * sidecar. Loader injection and inherited Node runtime flags are deliberately
 * removed. Environment names are compared case-insensitively for Windows.
 */
export const sanitizeProcessEnvironment = (
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(environment).filter(
      ([key, value]) => value !== undefined && !isUnsafeEnvironmentKey(key),
    ),
  );

class BoundedDiagnostics {
  private value = Buffer.alloc(0);

  truncated = false;

  constructor(private readonly maximumBytes: number) {}

  append(chunk: Buffer): void {
    if (chunk.length === 0) {
      return;
    }

    if (this.maximumBytes === 0) {
      this.truncated = true;
      return;
    }

    const combinedLength = this.value.length + chunk.length;
    if (combinedLength <= this.maximumBytes) {
      this.value = Buffer.concat([this.value, chunk], combinedLength);
      return;
    }

    this.truncated = true;
    if (chunk.length >= this.maximumBytes) {
      this.value = Buffer.from(chunk.subarray(chunk.length - this.maximumBytes));
      return;
    }

    const retainedBytes = this.maximumBytes - chunk.length;
    this.value = Buffer.concat(
      [this.value.subarray(this.value.length - retainedBytes), chunk],
      this.maximumBytes,
    );
  }

  toString(): string {
    return this.value.toString('utf8');
  }
}

const validateOptions = (options: RunProcessOptions): void => {
  if (!path.isAbsolute(options.executable)) {
    throw new TypeError('Process executables must use an absolute path.');
  }

  if (options.executable.includes('\0')) {
    throw new TypeError('Process executable paths cannot contain null bytes.');
  }

  if (options.args?.some((argument) => argument.includes('\0'))) {
    throw new TypeError('Process arguments cannot contain null bytes.');
  }

  const maximumBytes =
    options.maxDiagnosticBytes ?? DEFAULT_MAX_DIAGNOSTIC_BYTES;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new TypeError('maxDiagnosticBytes must be a non-negative safe integer.');
  }
};

/**
 * Runs a trusted executable directly, never through a shell. A completed
 * process always resolves, including non-zero exits; callers own exit-code
 * policy. Spawn failures reject normally and cancellation rejects with a
 * ProcessAbortedError carrying the bounded diagnostics collected so far.
 */
export const runProcess = async (
  options: RunProcessOptions,
): Promise<ProcessResult> => {
  validateOptions(options);

  const maximumBytes =
    options.maxDiagnosticBytes ?? DEFAULT_MAX_DIAGNOSTIC_BYTES;
  const stdout = new BoundedDiagnostics(maximumBytes);
  const stderr = new BoundedDiagnostics(maximumBytes);

  const createResult = (
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): ProcessResult => ({
    exitCode,
    signal,
    stdout: stdout.toString(),
    stderr: stderr.toString(),
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
  });

  if (options.signal?.aborted) {
    throw new ProcessAbortedError(createResult(null, null));
  }

  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(options.executable, [...(options.args ?? [])], {
      cwd: options.cwd,
      env: sanitizeProcessEnvironment(options.env),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let aborted = false;
    let callbackError: unknown;
    let hasCallbackError = false;
    let settled = false;

    const cleanUp = (): void => {
      options.signal?.removeEventListener('abort', handleAbort);
    };

    const settleWithError = (error: unknown): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanUp();
      reject(error);
    };

    const handleAbort = (): void => {
      aborted = true;
      child.kill();
    };

    const handleChunk = (
      chunk: Buffer,
      diagnostics: BoundedDiagnostics,
      callback: ((value: Buffer) => void) | undefined,
    ): void => {
      diagnostics.append(chunk);

      if (!callback || hasCallbackError) {
        return;
      }

      try {
        callback(chunk);
      } catch (error) {
        hasCallbackError = true;
        callbackError = error;
        child.kill();
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      handleChunk(chunk, stdout, options.onStdout);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      handleChunk(chunk, stderr, options.onStderr);
    });

    child.once('error', (error) => {
      settleWithError(error);
    });

    child.once('close', (exitCode, signal) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanUp();
      const result = createResult(exitCode, signal);

      if (hasCallbackError) {
        reject(callbackError);
      } else if (aborted) {
        reject(new ProcessAbortedError(result));
      } else {
        resolve(result);
      }
    });

    options.signal?.addEventListener('abort', handleAbort, { once: true });

    // Close the small race between the pre-spawn check and listener setup.
    if (options.signal?.aborted) {
      handleAbort();
    }
  });
};
