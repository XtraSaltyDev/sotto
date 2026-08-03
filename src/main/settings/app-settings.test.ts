import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AppSettingsStore,
  DEFAULT_APP_SETTINGS,
  listTranscriptionModels,
  resolveTranscriptionOptions,
} from './app-settings';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

const scratch = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-settings-'));
  temporaryRoots.push(root);
  return root;
};

describe('AppSettingsStore', () => {
  it('persists updates atomically and reloads them', async () => {
    const root = await scratch();
    const store = new AppSettingsStore(path.join(root, 'settings.json'));
    await store.load();
    expect(store.get()).toEqual(DEFAULT_APP_SETTINGS);

    await store.update({ transcriptionLanguage: 'de', transcriptionModelId: 'small' });
    const reloaded = new AppSettingsStore(path.join(root, 'settings.json'));
    await expect(reloaded.load()).resolves.toEqual({
      schemaVersion: 1,
      transcriptionModelId: 'small',
      transcriptionLanguage: 'de',
    });
  });

  it('falls back to defaults for corrupt or hostile settings files', async () => {
    const root = await scratch();
    const filePath = path.join(root, 'settings.json');
    await writeFile(filePath, '{not json');
    const store = new AppSettingsStore(filePath);
    await expect(store.load()).resolves.toEqual(DEFAULT_APP_SETTINGS);

    await writeFile(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        transcriptionModelId: '../../etc/passwd',
        transcriptionLanguage: 'xx',
      }),
    );
    await expect(store.load()).resolves.toEqual(DEFAULT_APP_SETTINGS);
  });
});

describe('listTranscriptionModels', () => {
  it('merges bundled and user models with user overrides winning', async () => {
    const root = await scratch();
    const bundled = path.join(root, 'bundled');
    const user = path.join(root, 'user');
    await mkdir(bundled, { recursive: true });
    await mkdir(user, { recursive: true });
    await writeFile(path.join(bundled, 'ggml-small.en.bin'), 'bundled-english');
    await writeFile(path.join(user, 'ggml-small.bin'), 'user-multilingual');
    await writeFile(path.join(user, 'ggml-small.en.bin'), 'user-english-override');
    await writeFile(path.join(user, 'notes.txt'), 'ignored');
    await writeFile(path.join(user, 'ggml-empty.bin'), '');

    const models = await listTranscriptionModels(bundled, user);
    expect(models).toEqual([
      expect.objectContaining({ id: 'small', multilingual: true, source: 'user' }),
      expect.objectContaining({
        id: 'small.en',
        multilingual: false,
        source: 'user',
      }),
    ]);
  });
});

describe('resolveTranscriptionOptions', () => {
  const models = [
    {
      id: 'small.en',
      multilingual: false,
      sizeBytes: 10,
      source: 'bundled' as const,
      path: '/models/ggml-small.en.bin',
    },
    {
      id: 'small',
      multilingual: true,
      sizeBytes: 10,
      source: 'user' as const,
      path: '/user/ggml-small.bin',
    },
  ];

  it('uses the selected multilingual model with the chosen language', () => {
    expect(
      resolveTranscriptionOptions(
        {
          schemaVersion: 1,
          transcriptionModelId: 'small',
          transcriptionLanguage: 'de',
        },
        models,
        '/models/ggml-small.en.bin',
      ),
    ).toEqual({ modelPath: '/user/ggml-small.bin', modelId: 'small', language: 'de' });
  });

  it('forces English for English-only models', () => {
    expect(
      resolveTranscriptionOptions(
        {
          schemaVersion: 1,
          transcriptionModelId: 'small.en',
          transcriptionLanguage: 'de',
        },
        models,
        '/models/ggml-small.en.bin',
      ),
    ).toEqual({
      modelPath: '/models/ggml-small.en.bin',
      modelId: 'small.en',
      language: 'en',
    });
  });

  it('falls back to the default model when the selection vanished', () => {
    expect(
      resolveTranscriptionOptions(
        {
          schemaVersion: 1,
          transcriptionModelId: 'missing',
          transcriptionLanguage: 'de',
        },
        models,
        '/models/ggml-small.en.bin',
      ),
    ).toEqual({
      modelPath: '/models/ggml-small.en.bin',
      modelId: 'small.en',
      language: 'en',
    });
  });
});
