import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import type {
  ConnectLocalAiInput,
  ConnectLocalAiResult,
  LocalAiMeetingSummary,
  LocalAiConnectionSummary,
  LocalAiModel,
} from '../../shared/contracts';
import type { TranscriptRecord } from '../transcription/transcript-types';
import { generateLocalAiMeetingSummary } from './local-ai-meeting-summary';

const CONNECTION_SCHEMA_VERSION = 1;
const MAX_CONNECTION_BYTES = 64 * 1_024;
const MAX_MODEL_RESPONSE_BYTES = 1024 * 1_024;
const MAX_MODELS = 200;
const MAX_BASE_URL_CHARACTERS = 2_048;
const MAX_API_KEY_CHARACTERS = 8_192;
const MAX_MODEL_ID_CHARACTERS = 300;
const CONNECTION_TIMEOUT_MS = 8_000;

interface StoredLocalAiConnection {
  schemaVersion: 1;
  baseUrl: string;
  selectedModel: string;
  encryptedApiKey?: string;
  verifiedAt: string;
}

export interface LocalAiCredentialCipher {
  encrypt(value: string): string;
  decrypt(value: string): string;
}

export interface LocalAiConnectionServiceOptions {
  filePath: string;
  credentialCipher: LocalAiCredentialCipher;
  fetcher?: typeof fetch;
  now?: () => Date;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isMissingFileError = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

const isPrivateIpv4 = (hostname: string): boolean => {
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => octet < 0 || octet > 255)) {
    return false;
  }
  return (
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
};

const isPrivateIpv6 = (hostname: string): boolean => {
  const normalized = hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  return (
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/u.test(normalized)
  );
};

const isLocalHostname = (hostname: string): boolean => {
  const normalized = hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  const addressType = isIP(normalized);
  if (addressType === 4) return isPrivateIpv4(normalized);
  if (addressType === 6) return isPrivateIpv6(normalized);
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local')
  );
};

export const normalizeLocalAiBaseUrl = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > MAX_BASE_URL_CHARACTERS) {
    throw new TypeError('Enter a valid local OpenAI-compatible URL.');
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new TypeError('Enter a valid local OpenAI-compatible URL.');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !isLocalHostname(url.hostname)
  ) {
    throw new TypeError(
      'Use an HTTP or HTTPS endpoint on localhost, a private network address, or a .local host.',
    );
  }

  const pathname = url.pathname.replace(/\/+$/gu, '');
  url.pathname = pathname === '' ? '/v1' : pathname;
  return url.toString().replace(/\/$/u, '');
};

const parseApiKey = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > MAX_API_KEY_CHARACTERS) {
    throw new TypeError('The API key is too long or invalid.');
  }
  const normalized = value.trim();
  return normalized || undefined;
};

const parseModelId = (value: unknown, optional = false): string | null => {
  if (optional && (value === undefined || value === null || value === '')) return null;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_MODEL_ID_CHARACTERS ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    throw new TypeError('The selected model id is invalid.');
  }
  return value;
};

const parseStoredConnection = (value: unknown): StoredLocalAiConnection => {
  if (
    !isRecord(value) ||
    value.schemaVersion !== CONNECTION_SCHEMA_VERSION ||
    typeof value.baseUrl !== 'string' ||
    typeof value.selectedModel !== 'string' ||
    typeof value.verifiedAt !== 'string' ||
    (value.encryptedApiKey !== undefined && typeof value.encryptedApiKey !== 'string')
  ) {
    throw new TypeError('The saved local AI connection is invalid.');
  }
  const verifiedAt = new Date(value.verifiedAt);
  if (!Number.isFinite(verifiedAt.getTime())) {
    throw new TypeError('The saved local AI connection date is invalid.');
  }
  return {
    schemaVersion: 1,
    baseUrl: normalizeLocalAiBaseUrl(value.baseUrl),
    selectedModel: parseModelId(value.selectedModel) as string,
    verifiedAt: verifiedAt.toISOString(),
    ...(value.encryptedApiKey ? { encryptedApiKey: value.encryptedApiKey } : {}),
  };
};

const readBoundedJson = async (response: Response): Promise<unknown> => {
  if (!response.body) throw new TypeError('The endpoint returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let complete = false;
  while (!complete) {
    const next = await reader.read();
    if (next.done) {
      complete = true;
      continue;
    }
    bytes += next.value.byteLength;
    if (bytes > MAX_MODEL_RESPONSE_BYTES) {
      await reader.cancel();
      throw new TypeError('The endpoint returned too much model data.');
    }
    chunks.push(next.value);
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes)
    .toString('utf8');
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new TypeError('The endpoint did not return valid JSON.');
  }
};

const parseModels = (value: unknown): LocalAiModel[] => {
  if (!isRecord(value) || !Array.isArray(value.data) || value.data.length > MAX_MODELS) {
    throw new TypeError('The endpoint did not return an OpenAI-compatible model list.');
  }
  const models = value.data.map((candidate): LocalAiModel => {
    if (!isRecord(candidate)) {
      throw new TypeError('The endpoint returned an invalid model entry.');
    }
    const id = parseModelId(candidate.id) as string;
    const ownedBy =
      typeof candidate.owned_by === 'string' &&
      candidate.owned_by.length <= 200 &&
      ![...candidate.owned_by].some((character) => character.charCodeAt(0) < 32)
        ? candidate.owned_by
        : null;
    return { id, ownedBy };
  });
  const uniqueModels = Array.from(
    new Map(models.map((model) => [model.id, model])).values(),
  );
  if (uniqueModels.length === 0) {
    throw new TypeError('The endpoint is reachable, but it has no available models.');
  }
  return uniqueModels.sort((left, right) => left.id.localeCompare(right.id));
};

const toSummary = (
  connection: StoredLocalAiConnection | null,
): LocalAiConnectionSummary =>
  connection
    ? {
        configured: true,
        baseUrl: connection.baseUrl,
        selectedModel: connection.selectedModel,
        hasApiKey: Boolean(connection.encryptedApiKey),
        verifiedAt: connection.verifiedAt,
      }
    : {
        configured: false,
        baseUrl: '',
        selectedModel: null,
        hasApiKey: false,
        verifiedAt: null,
      };

export class LocalAiConnectionService {
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: LocalAiConnectionServiceOptions) {
    if (!path.isAbsolute(options.filePath)) {
      throw new TypeError('Local AI connection storage must use an absolute path.');
    }
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async getSummary(): Promise<LocalAiConnectionSummary> {
    return toSummary(await this.read());
  }

  async connect(input: ConnectLocalAiInput): Promise<ConnectLocalAiResult> {
    try {
      const baseUrl = normalizeLocalAiBaseUrl(input.baseUrl);
      const suppliedApiKey = parseApiKey(input.apiKey);
      const current = await this.read();
      const retainedApiKey =
        suppliedApiKey === undefined && current?.baseUrl === baseUrl
          ? this.decryptApiKey(current)
          : undefined;
      const apiKey = suppliedApiKey ?? retainedApiKey;
      const models = await this.fetchModels(baseUrl, apiKey);
      const requestedModel = parseModelId(input.selectedModel, true);
      const selectedModel = requestedModel ?? models[0].id;
      if (!models.some((model) => model.id === selectedModel)) {
        return {
          outcome: 'rejected',
          reason: 'Choose a model returned by this endpoint.',
        };
      }

      const connection: StoredLocalAiConnection = {
        schemaVersion: 1,
        baseUrl,
        selectedModel,
        verifiedAt: this.now().toISOString(),
        ...(apiKey
          ? { encryptedApiKey: this.options.credentialCipher.encrypt(apiKey) }
          : {}),
      };
      await this.write(connection);
      return { outcome: 'connected', connection: toSummary(connection), models };
    } catch (error) {
      return {
        outcome: 'rejected',
        reason:
          error instanceof Error
            ? error.message
            : 'Sotto could not connect to that local AI endpoint.',
      };
    }
  }

  async disconnect(): Promise<void> {
    await unlink(this.options.filePath).catch((error: unknown) => {
      if (!isMissingFileError(error)) throw error;
    });
  }

  async generateMeetingSummary(
    record: TranscriptRecord,
  ): Promise<LocalAiMeetingSummary> {
    const connection = await this.read();
    if (!connection) {
      throw new TypeError(
        'Connect a local model before improving this meeting summary.',
      );
    }
    return generateLocalAiMeetingSummary({
      connection: {
        baseUrl: connection.baseUrl,
        model: connection.selectedModel,
        ...(connection.encryptedApiKey
          ? { apiKey: this.decryptApiKey(connection) }
          : {}),
      },
      fetcher: this.fetcher,
      now: this.now,
      record,
    });
  }

  private async fetchModels(
    baseUrl: string,
    apiKey: string | undefined,
  ): Promise<LocalAiModel[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONNECTION_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetcher(`${baseUrl}/models`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timeout);
      if (controller.signal.aborted) {
        throw new TypeError('The local AI endpoint did not respond within 8 seconds.');
      }
      throw new TypeError('Sotto could not reach that local AI endpoint.');
    }
    try {
      if (response.status === 401 || response.status === 403) {
        throw new TypeError('The endpoint rejected the API key.');
      }
      if (!response.ok) {
        throw new TypeError(
          response.status === 404
            ? 'The endpoint does not expose /v1/models. Check the base URL.'
            : `The local AI endpoint returned HTTP ${response.status}.`,
        );
      }
      return parseModels(await readBoundedJson(response));
    } catch (error) {
      if (controller.signal.aborted) {
        throw new TypeError('The local AI endpoint did not respond within 8 seconds.');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private decryptApiKey(connection: StoredLocalAiConnection): string | undefined {
    return connection.encryptedApiKey
      ? this.options.credentialCipher.decrypt(connection.encryptedApiKey)
      : undefined;
  }

  private async read(): Promise<StoredLocalAiConnection | null> {
    let contents: string;
    try {
      contents = await readFile(this.options.filePath, 'utf8');
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw error;
    }
    if (Buffer.byteLength(contents, 'utf8') > MAX_CONNECTION_BYTES) {
      throw new TypeError('The saved local AI connection is too large.');
    }
    return parseStoredConnection(JSON.parse(contents) as unknown);
  }

  private async write(connection: StoredLocalAiConnection): Promise<void> {
    const directory = path.dirname(this.options.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.options.filePath}.${randomUUID()}.tmp`;
    const serialized = `${JSON.stringify(connection, null, 2)}\n`;
    const file = await open(temporaryPath, 'wx', 0o600);
    try {
      await file.writeFile(serialized, 'utf8');
      await file.sync();
      await file.close();
      await rename(temporaryPath, this.options.filePath);
    } catch (error) {
      await file.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}
