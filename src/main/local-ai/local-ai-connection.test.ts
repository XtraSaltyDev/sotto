import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LocalAiConnectionService,
  normalizeLocalAiBaseUrl,
} from './local-ai-connection';

const roots: string[] = [];
const cipher = {
  encrypt: (value: string) => Buffer.from(`protected:${value}`).toString('base64'),
  decrypt: (value: string) =>
    Buffer.from(value, 'base64').toString('utf8').replace(/^protected:/u, ''),
};

const modelResponse = (models = ['llama3.2', 'qwen3:8b']): Response =>
  new Response(
    JSON.stringify({
      object: 'list',
      data: models.map((id) => ({ id, object: 'model', owned_by: 'library' })),
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );

const setup = async (fetcher: typeof fetch) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-local-ai-'));
  roots.push(root);
  const filePath = path.join(root, 'local-ai', 'connection.json');
  return {
    filePath,
    service: new LocalAiConnectionService({
      filePath,
      credentialCipher: cipher,
      fetcher,
      now: () => new Date('2026-07-29T20:00:00.000Z'),
    }),
  };
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe('normalizeLocalAiBaseUrl', () => {
  it.each([
    ['http://localhost:11434', 'http://localhost:11434/v1'],
    ['http://127.0.0.1:11434/v1/', 'http://127.0.0.1:11434/v1'],
    ['http://10.1.2.3:8080', 'http://10.1.2.3:8080/v1'],
    ['https://spark-01.local/openai/v1/', 'https://spark-01.local/openai/v1'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeLocalAiBaseUrl(input)).toBe(expected);
  });

  it.each([
    'https://api.openai.com/v1',
    'file:///tmp/models',
    'http://user:secret@localhost:11434/v1',
    'http://localhost:11434/v1?key=secret',
  ])('rejects non-local or unsafe endpoint %s', (input) => {
    expect(() => normalizeLocalAiBaseUrl(input)).toThrow();
  });
});

describe('LocalAiConnectionService', () => {
  it('discovers, selects, and atomically saves an Ollama-compatible model list', async () => {
    const fetcher = vi.fn(async () => modelResponse());
    const { filePath, service } = await setup(fetcher as typeof fetch);

    await expect(
      service.connect({
        baseUrl: 'http://127.0.0.1:11434',
        selectedModel: 'qwen3:8b',
      }),
    ).resolves.toMatchObject({
      outcome: 'connected',
      connection: {
        configured: true,
        baseUrl: 'http://127.0.0.1:11434/v1',
        selectedModel: 'qwen3:8b',
        hasApiKey: false,
      },
      models: [{ id: 'llama3.2' }, { id: 'qwen3:8b' }],
    });
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/v1/models',
      expect.objectContaining({ redirect: 'error' }),
    );
    await expect(service.getSummary()).resolves.toMatchObject({
      configured: true,
      selectedModel: 'qwen3:8b',
    });
    expect(await readFile(filePath, 'utf8')).not.toContain('apiKey');
  });

  it('sends and encrypts a bearer key for an authenticated private endpoint', async () => {
    const fetcher = vi.fn(async (_url, init) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe(
        'Bearer local-secret',
      );
      return modelResponse(['gemma-local']);
    });
    const { filePath, service } = await setup(fetcher as typeof fetch);

    await expect(
      service.connect({
        baseUrl: 'http://10.1.2.3:8080',
        apiKey: 'local-secret',
      }),
    ).resolves.toMatchObject({
      outcome: 'connected',
      connection: { hasApiKey: true, selectedModel: 'gemma-local' },
    });
    const stored = await readFile(filePath, 'utf8');
    expect(stored).not.toContain('local-secret');
    expect(stored).toContain('encryptedApiKey');
  });

  it('retains the saved key when reconnecting to the same endpoint', async () => {
    const authorizations: Array<string | null> = [];
    const fetcher = vi.fn(async (_url, init) => {
      authorizations.push(new Headers(init?.headers).get('Authorization'));
      return modelResponse(['gemma-local']);
    });
    const { service } = await setup(fetcher as typeof fetch);
    await service.connect({
      baseUrl: 'http://10.1.2.3:8080',
      apiKey: 'local-secret',
    });
    await service.connect({ baseUrl: 'http://10.1.2.3:8080/v1' });

    expect(authorizations).toEqual([
      'Bearer local-secret',
      'Bearer local-secret',
    ]);
  });

  it('does not save a failed authentication attempt', async () => {
    const { service } = await setup(
      (async () => new Response('{}', { status: 401 })) as typeof fetch,
    );

    await expect(
      service.connect({
        baseUrl: 'http://127.0.0.1:11434/v1',
        apiKey: 'wrong',
      }),
    ).resolves.toEqual({
      outcome: 'rejected',
      reason: 'The endpoint rejected the API key.',
    });
    await expect(service.getSummary()).resolves.toMatchObject({ configured: false });
  });

  it('disconnects without failing when already disconnected', async () => {
    const { service } = await setup((async () => modelResponse()) as typeof fetch);
    await service.connect({ baseUrl: 'http://localhost:11434' });
    await service.disconnect();
    await service.disconnect();
    await expect(service.getSummary()).resolves.toMatchObject({ configured: false });
  });
});
