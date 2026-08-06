import { useEffect, useState } from 'react';

import {
  SUPPORTED_TRANSCRIPTION_LANGUAGES,
  type AppSettingsSummary,
} from '../shared/contracts';
import { DEFAULT_TRANSCRIPTION_MODEL } from '../shared/default-transcription-model';

const EMPTY_SETTINGS: AppSettingsSummary = {
  transcriptionModelId: DEFAULT_TRANSCRIPTION_MODEL.id,
  transcriptionLanguage: 'en',
  customVocabulary: [],
  availableModels: [],
  userModelsDirectory: '',
  dictationShortcut: '',
};

export const formatModelSize = (bytes: number): string =>
  `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;

export const modelDescription = (model: {
  multilingual: boolean;
  source: 'bundled' | 'user';
}): string =>
  [
    model.multilingual ? 'Multilingual' : 'English only',
    model.source === 'bundled' ? 'included with Sotto' : 'added by you',
  ].join(' · ');

export const SettingsPage = () => {
  const [settings, setSettings] = useState<AppSettingsSummary>(EMPTY_SETTINGS);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [vocabularyDraft, setVocabularyDraft] = useState('');

  useEffect(() => {
    if (!window.sotto?.getAppSettings) {
      setBusy(false);
      return undefined;
    }
    let cancelled = false;
    window.sotto
      .getAppSettings()
      .then((loaded) => {
        if (!cancelled) {
          setSettings(loaded);
          setVocabularyDraft(loaded.customVocabulary.join('\n'));
        }
      })
      .catch(() => {
        if (!cancelled) setMessage('Sotto could not read its settings.');
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const applyUpdate = async (input: {
    transcriptionModelId?: string;
    transcriptionLanguage?: string;
    customVocabulary?: string[];
  }) => {
    if (!window.sotto || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await window.sotto.updateAppSettings(input);
      if (result.outcome === 'updated') {
        setSettings(result.settings);
        setVocabularyDraft(result.settings.customVocabulary.join('\n'));
        setMessage('Saved. New transcriptions use this setting.');
      } else {
        setMessage(result.reason);
      }
    } catch {
      setMessage('Sotto could not save that setting.');
    } finally {
      setBusy(false);
    }
  };

  const saveVocabulary = () => {
    const terms = vocabularyDraft
      .split(/\r?\n/gu)
      .map((term) => term.trim())
      .filter(Boolean);
    void applyUpdate({ customVocabulary: terms });
  };

  const selectedModel = settings.availableModels.find(
    (model) => model.id === settings.transcriptionModelId,
  );
  const languageLocked = selectedModel ? !selectedModel.multilingual : true;

  return (
    <main className="workspace settings-workspace">
      <header className="topbar"><h1>Settings</h1></header>
      <section className="settings-page" aria-labelledby="settings-title">
        <div className="settings-page__intro">
          <h2 id="settings-title">Tune how Sotto works on this computer.</h2>
          <p>
            Everything here stays local. Settings apply to new transcriptions;
            saved transcripts are never changed.
          </p>
        </div>

        <div className="settings-card" aria-labelledby="settings-transcription-title">
          <h3 id="settings-transcription-title">Transcription</h3>
          <label className="settings-field">
            <span>Model</span>
            <select
              disabled={busy || settings.availableModels.length === 0}
              onChange={(event) =>
                void applyUpdate({ transcriptionModelId: event.target.value })
              }
              value={settings.transcriptionModelId}
            >
              {settings.availableModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.id} — {modelDescription(model)} ({formatModelSize(model.sizeBytes)})
                </option>
              ))}
            </select>
            <small>
              Add more Whisper models (files named like
              {' '}<code>ggml-small.bin</code>) to your models folder and they
              appear here.
            </small>
          </label>
          <label className="settings-field">
            <span>Spoken language</span>
            <select
              disabled={busy || languageLocked}
              onChange={(event) =>
                void applyUpdate({ transcriptionLanguage: event.target.value })
              }
              value={languageLocked ? 'en' : settings.transcriptionLanguage}
            >
              {SUPPORTED_TRANSCRIPTION_LANGUAGES.map((language) => (
                <option key={language.id} value={language.id}>
                  {language.label}
                </option>
              ))}
            </select>
            <small>
              {languageLocked
                ? 'The selected model understands English only. Choose a multilingual model to transcribe other languages.'
                : 'Auto-detect works well for single-language recordings.'}
            </small>
          </label>
          <button
            className="settings-link"
            disabled={busy}
            onClick={() => void window.sotto?.revealModelsFolder()}
            type="button"
          >
            Open the models folder
          </button>
          <label className="settings-field">
            <span>Custom vocabulary</span>
            <textarea
              aria-describedby="settings-vocabulary-help"
              disabled={busy}
              onChange={(event) => setVocabularyDraft(event.target.value)}
              placeholder={'One name, product, or specialist term per line'}
              rows={5}
              value={vocabularyDraft}
            />
            <small id="settings-vocabulary-help">
              These terms are used as a local speech-model hint for new
              transcriptions. They do not rewrite saved transcripts or leave
              this computer.
            </small>
          </label>
          <button
            className="settings-link"
            disabled={busy}
            onClick={saveVocabulary}
            type="button"
          >
            Save vocabulary
          </button>
        </div>

        <div className="settings-card" aria-labelledby="settings-data-title">
          <h3 id="settings-data-title">Your data</h3>
          <p>
            Recordings, transcripts, and summaries live only in Sotto&apos;s
            private folder on this computer. Copy that folder to another disk
            to make a full backup.
          </p>
          <button
            className="settings-link"
            disabled={busy}
            onClick={() => void window.sotto?.revealTranscriptsFolder()}
            type="button"
          >
            Open the transcripts folder
          </button>
        </div>

        <div className="settings-card" aria-labelledby="settings-shortcuts-title">
          <h3 id="settings-shortcuts-title">Shortcuts</h3>
          <p>
            Start or stop dictation from any app with{' '}
            <strong>{settings.dictationShortcut || '⌘⇧D'}</strong> while Sotto
            is running.
          </p>
        </div>

        {message ? (
          <p aria-live="polite" className="settings-message" role="status">
            {message}
          </p>
        ) : null}
      </section>
    </main>
  );
};
