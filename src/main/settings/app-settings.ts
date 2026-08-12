import { mkdir, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

import {
  SUPPORTED_TRANSCRIPTION_LANGUAGES,
  type TranscriptionModelSummary,
} from '../../shared/contracts';
import { DEFAULT_TRANSCRIPTION_MODEL } from '../../shared/default-transcription-model';

export interface AppSettings {
  schemaVersion: 2;
  /** ggml model id such as 'large-v3-turbo'; null selects the managed default. */
  transcriptionModelId: string | null;
  /** Language code from SUPPORTED_TRANSCRIPTION_LANGUAGES, or 'auto'. */
  transcriptionLanguage: string;
  /** Terms are fed to the local speech engine as an initial prompt. */
  customVocabulary: string[];
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  schemaVersion: 2,
  transcriptionModelId: null,
  transcriptionLanguage: 'en',
  customVocabulary: [],
};

const MAX_SETTINGS_BYTES = 64 * 1024;
const MODEL_FILE_PATTERN = /^ggml-([a-z0-9][a-z0-9.-]{0,60})\.bin$/u;
export const MAX_CUSTOM_VOCABULARY_TERMS = 100;
export const MAX_CUSTOM_VOCABULARY_TERM_CHARACTERS = 80;
export const MAX_CUSTOM_VOCABULARY_PROMPT_CHARACTERS = 4_000;

export interface TranscriptionModelChoice extends TranscriptionModelSummary {
  path: string;
}

export const isSupportedTranscriptionLanguage = (value: string): boolean =>
  SUPPORTED_TRANSCRIPTION_LANGUAGES.some((language) => language.id === value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const normalizeCustomVocabulary = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length > MAX_CUSTOM_VOCABULARY_TERMS) {
    throw new TypeError(
      `Custom vocabulary must contain at most ${MAX_CUSTOM_VOCABULARY_TERMS} terms.`,
    );
  }
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    if (typeof candidate !== 'string') {
      throw new TypeError(`Custom vocabulary term ${index + 1} must be text.`);
    }
    const term = candidate.replace(/\s+/gu, ' ').trim();
    if (
      term.length === 0 ||
      term.length > MAX_CUSTOM_VOCABULARY_TERM_CHARACTERS ||
      /[\0\r\n]/u.test(term)
    ) {
      throw new TypeError(
        `Custom vocabulary terms must be 1–${MAX_CUSTOM_VOCABULARY_TERM_CHARACTERS} characters.`,
      );
    }
    const key = term.toLocaleLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      terms.push(term);
    }
  }
  if (terms.join(', ').length > MAX_CUSTOM_VOCABULARY_PROMPT_CHARACTERS) {
    throw new TypeError(
      `Custom vocabulary must fit within ${MAX_CUSTOM_VOCABULARY_PROMPT_CHARACTERS} characters.`,
    );
  }
  return terms;
};

const parseSettings = (value: unknown): AppSettings => {
  if (
    !isRecord(value) ||
    (value.schemaVersion !== 1 && value.schemaVersion !== 2)
  ) {
    return { ...DEFAULT_APP_SETTINGS };
  }
  const transcriptionModelId =
    typeof value.transcriptionModelId === 'string' &&
    /^[a-z0-9][a-z0-9.-]{0,60}$/u.test(value.transcriptionModelId)
      ? value.transcriptionModelId
      : null;
  const transcriptionLanguage =
    typeof value.transcriptionLanguage === 'string' &&
    isSupportedTranscriptionLanguage(value.transcriptionLanguage)
      ? value.transcriptionLanguage
      : DEFAULT_APP_SETTINGS.transcriptionLanguage;
  let customVocabulary: string[] = [];
  try {
    customVocabulary = normalizeCustomVocabulary(value.customVocabulary ?? []);
  } catch {
    customVocabulary = [];
  }
  return { schemaVersion: 2, transcriptionModelId, transcriptionLanguage, customVocabulary };
};

/**
 * Small, atomic, corruption-tolerant preference store. Settings are
 * reconstructible, so an unreadable file falls back to defaults instead
 * of failing startup.
 */
export class AppSettingsStore {
  private settings: AppSettings = { ...DEFAULT_APP_SETTINGS };

  constructor(private readonly filePath: string) {
    if (!path.isAbsolute(filePath)) {
      throw new TypeError('The settings path must be absolute.');
    }
  }

  async load(): Promise<AppSettings> {
    try {
      const contents = await readFile(this.filePath, 'utf8');
      if (Buffer.byteLength(contents, 'utf8') <= MAX_SETTINGS_BYTES) {
        this.settings = parseSettings(JSON.parse(contents) as unknown);
      }
    } catch {
      this.settings = { ...DEFAULT_APP_SETTINGS };
    }
    return this.get();
  }

  get(): AppSettings {
    return { ...this.settings };
  }

  async update(partial: Partial<Omit<AppSettings, 'schemaVersion'>>): Promise<AppSettings> {
    const next = parseSettings({ ...this.settings, ...partial, schemaVersion: 2 });
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    const file = await open(temporaryPath, 'w', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(next, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    this.settings = next;
    return this.get();
  }
}

const scanModelsDirectory = async (
  directory: string,
  source: TranscriptionModelSummary['source'],
): Promise<TranscriptionModelChoice[]> => {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }
  const models: TranscriptionModelChoice[] = [];
  for (const entry of entries) {
    const match = MODEL_FILE_PATTERN.exec(entry);
    if (!match) continue;
    const filePath = path.join(directory, entry);
    try {
      const fileStats = await stat(filePath);
      if (!fileStats.isFile() || fileStats.size === 0) continue;
      models.push({
        id: match[1],
        multilingual: !match[1].endsWith('.en'),
        sizeBytes: fileStats.size,
        source,
        path: filePath,
      });
    } catch {
      // Unreadable entries are simply not offered.
    }
  }
  return models;
};

/**
 * Whisper ggml models available to this install: the managed default plus
 * any the user drops into their own models directory. A user model with
 * the same id as the default one wins, so users can override the default.
 */
export const listTranscriptionModels = async (
  bundledModelsDirectory: string,
  userModelsDirectory: string,
): Promise<TranscriptionModelChoice[]> => {
  const bundled = await scanModelsDirectory(bundledModelsDirectory, 'bundled');
  const user = await scanModelsDirectory(userModelsDirectory, 'user');
  const byId = new Map<string, TranscriptionModelChoice>();
  for (const model of [...bundled, ...user]) byId.set(model.id, model);
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
};

export interface ResolvedTranscriptionOptions {
  modelPath: string;
  modelId: string;
  language: string;
}

/**
 * Chooses the effective model and language for a new transcription. A
 * missing or vanished selection falls back to the managed default model, and an
 * English-only model always forces English regardless of the language
 * preference.
 */
export const resolveTranscriptionOptions = (
  settings: AppSettings,
  models: readonly TranscriptionModelChoice[],
  defaultModelPath: string,
): ResolvedTranscriptionOptions => {
  const selected =
    (settings.transcriptionModelId
      ? models.find((model) => model.id === settings.transcriptionModelId)
      : undefined) ??
    models.find((model) => model.path === defaultModelPath);
  if (!selected) {
    return {
      modelPath: defaultModelPath,
      modelId: DEFAULT_TRANSCRIPTION_MODEL.id,
      language: 'en',
    };
  }
  const language =
    selected.multilingual &&
    isSupportedTranscriptionLanguage(settings.transcriptionLanguage)
      ? settings.transcriptionLanguage
      : 'en';
  return { modelPath: selected.path, modelId: selected.id, language };
};
