import { useEffect, useState } from 'react';

import {
  SUPPORTED_TRANSCRIPTION_LANGUAGES,
  type AppSettingsSummary,
} from '../shared/contracts';
import { DEFAULT_TRANSCRIPTION_MODEL } from '../shared/default-transcription-model';
import {
  CheckCircleIcon,
  ChevronDownIcon,
  DownloadIcon,
  FolderIcon,
  KeyboardIcon,
  ModelIcon,
  MoonIcon,
  SunIcon,
} from './icons';
import { type AppTheme } from './theme';
import type { AppUpdateNoticeState } from './UpdateNotice';

export type SettingsSection =
  | 'appearance'
  | 'transcription'
  | 'storage'
  | 'shortcuts'
  | 'about';

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
    model.source === 'bundled' ? 'default Sotto model' : 'added by you',
  ].join(' · ');

const NOOP = () => undefined;

export const settingsUpdateStatus = (
  currentVersion: string | null,
  update: AppUpdateNoticeState | null,
): string => {
  if (!update) {
    return currentVersion
      ? `Sotto ${currentVersion} is installed.`
      : 'Sotto could not read its installed version.';
  }
  switch (update.phase) {
    case 'available':
      return `Sotto ${update.version} is available.`;
    case 'downloading':
      return `Sotto ${update.version} is downloading.`;
    case 'preparing':
      return `Sotto ${update.version} is being verified and prepared.`;
    case 'ready':
      return `Sotto ${update.version} is ready. Restart to finish installing it.`;
    case 'restarting':
      return `Sotto ${update.version} is being installed.`;
    case 'downloaded':
      return `Sotto ${update.version} is downloaded and ready for manual installation.`;
    case 'cancelled':
      return `The Sotto ${update.version} download was canceled.`;
    case 'failed':
    case 'check-failed':
      return update.reason;
    case 'up-to-date':
      return `Sotto ${update.version} is up to date.`;
  }
};

export const SettingsPage = ({
  appUpdate = null,
  appVersion = null,
  initialSection = 'appearance',
  isCheckingForUpdate = false,
  onCheckForUpdates = NOOP,
  onToggleTheme = NOOP,
  theme = 'light',
}: {
  appUpdate?: AppUpdateNoticeState | null;
  appVersion?: string | null;
  initialSection?: SettingsSection;
  isCheckingForUpdate?: boolean;
  onCheckForUpdates?: () => void | Promise<void>;
  onToggleTheme?: () => void;
  theme?: AppTheme;
}) => {
  const [settings, setSettings] = useState<AppSettingsSummary>(EMPTY_SETTINGS);
  const [activeSection, setActiveSection] =
    useState<SettingsSection>(initialSection);
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
  const updateInProgress =
    appUpdate?.phase === 'downloading' ||
    appUpdate?.phase === 'preparing' ||
    appUpdate?.phase === 'ready' ||
    appUpdate?.phase === 'restarting';

  const selectSection = (section: SettingsSection) => {
    setActiveSection(section);
    setMessage(null);
  };

  return (
    <main className="workspace settings-workspace">
      <header className="topbar"><h1>Settings</h1></header>
      <section className="settings-page" aria-labelledby="settings-title">
        <div className="settings-page__intro">
          <h2 id="settings-title">Make Sotto work your way.</h2>
          <p>
            Choose how Sotto looks, transcribes, and stores your work on this
            computer.
          </p>
        </div>

        <div className="settings-layout">
          <nav
            aria-label="Settings sections"
            className="settings-sections"
            role="tablist"
          >
            <button
              aria-controls="settings-panel-appearance"
              aria-selected={activeSection === 'appearance'}
              className={activeSection === 'appearance' ? 'settings-section--active' : undefined}
              id="settings-tab-appearance"
              onClick={() => selectSection('appearance')}
              role="tab"
              type="button"
            >
              <SunIcon />
              <span><strong>Appearance</strong><small>Theme and display</small></span>
            </button>
            <button
              aria-controls="settings-panel-transcription"
              aria-selected={activeSection === 'transcription'}
              className={activeSection === 'transcription' ? 'settings-section--active' : undefined}
              id="settings-tab-transcription"
              onClick={() => selectSection('transcription')}
              role="tab"
              type="button"
            >
              <ModelIcon />
              <span><strong>Transcription</strong><small>Model and language</small></span>
            </button>
            <button
              aria-controls="settings-panel-storage"
              aria-selected={activeSection === 'storage'}
              className={activeSection === 'storage' ? 'settings-section--active' : undefined}
              id="settings-tab-storage"
              onClick={() => selectSection('storage')}
              role="tab"
              type="button"
            >
              <FolderIcon />
              <span><strong>Storage</strong><small>Local files and models</small></span>
            </button>
            <button
              aria-controls="settings-panel-shortcuts"
              aria-selected={activeSection === 'shortcuts'}
              className={activeSection === 'shortcuts' ? 'settings-section--active' : undefined}
              id="settings-tab-shortcuts"
              onClick={() => selectSection('shortcuts')}
              role="tab"
              type="button"
            >
              <KeyboardIcon />
              <span><strong>Shortcuts</strong><small>Keyboard controls</small></span>
            </button>
            <button
              aria-controls="settings-panel-about"
              aria-selected={activeSection === 'about'}
              className={activeSection === 'about' ? 'settings-section--active' : undefined}
              id="settings-tab-about"
              onClick={() => selectSection('about')}
              role="tab"
              type="button"
            >
              <DownloadIcon />
              <span><strong>About</strong><small>Version and updates</small></span>
            </button>
          </nav>

          <div className="settings-panel-wrap">
            {activeSection === 'appearance' ? (
              <section
                aria-labelledby="settings-tab-appearance"
                className="settings-panel"
                id="settings-panel-appearance"
                role="tabpanel"
              >
                <header className="settings-panel__header">
                  <span>Appearance</span>
                  <h2>Choose how Sotto looks.</h2>
                  <p>Your theme changes immediately and stays selected on this computer.</p>
                </header>
                <div className="settings-theme-options" role="group" aria-label="Choose appearance">
                  <button
                    aria-pressed={theme === 'light'}
                    className={theme === 'light' ? 'settings-theme-card settings-theme-card--active' : 'settings-theme-card'}
                    onClick={() => {
                      if (theme !== 'light') onToggleTheme();
                    }}
                    type="button"
                  >
                    <span className="settings-theme-card__preview settings-theme-card__preview--light">
                      <span /><span /><span />
                    </span>
                    <span className="settings-theme-card__label"><SunIcon /><strong>Light</strong></span>
                    {theme === 'light' ? <CheckCircleIcon /> : null}
                  </button>
                  <button
                    aria-pressed={theme === 'dark'}
                    className={theme === 'dark' ? 'settings-theme-card settings-theme-card--active' : 'settings-theme-card'}
                    onClick={() => {
                      if (theme !== 'dark') onToggleTheme();
                    }}
                    type="button"
                  >
                    <span className="settings-theme-card__preview settings-theme-card__preview--dark">
                      <span /><span /><span />
                    </span>
                    <span className="settings-theme-card__label"><MoonIcon /><strong>Dark</strong></span>
                    {theme === 'dark' ? <CheckCircleIcon /> : null}
                  </button>
                </div>
              </section>
            ) : null}

            {activeSection === 'transcription' ? (
              <section
                aria-labelledby="settings-tab-transcription"
                className="settings-panel"
                id="settings-panel-transcription"
                role="tabpanel"
              >
                <header className="settings-panel__header">
                  <span>Transcription</span>
                  <h2>Shape the words Sotto hears.</h2>
                  <p>These choices apply to new transcriptions. Saved transcripts never change.</p>
                </header>
                <div className="settings-card">
                  <label className="settings-field">
                    <span>Speech model</span>
                    <span className="settings-select">
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
                      <ChevronDownIcon />
                    </span>
                    <small>Add and manage Whisper model files from the Storage section.</small>
                  </label>
                  <label className="settings-field">
                    <span>Spoken language</span>
                    <span className="settings-select">
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
                      <ChevronDownIcon />
                    </span>
                    <small>
                      {languageLocked
                        ? 'The selected model understands English only. Choose a multilingual model for other languages.'
                        : 'Auto-detect works well for recordings that use one language.'}
                    </small>
                  </label>
                </div>
                <div className="settings-card">
                  <label className="settings-field settings-field--flush">
                    <span>Custom vocabulary</span>
                    <textarea
                      aria-describedby="settings-vocabulary-help"
                      disabled={busy}
                      onChange={(event) => setVocabularyDraft(event.target.value)}
                      placeholder="One name, product, or specialist term per line"
                      rows={6}
                      value={vocabularyDraft}
                    />
                    <small id="settings-vocabulary-help">
                      Give the local speech model a hint for names and specialist terms. Nothing leaves this computer.
                    </small>
                  </label>
                  <button
                    className="settings-link settings-link--primary"
                    disabled={busy}
                    onClick={saveVocabulary}
                    type="button"
                  >
                    Save vocabulary
                  </button>
                </div>
              </section>
            ) : null}

            {activeSection === 'storage' ? (
              <section
                aria-labelledby="settings-tab-storage"
                className="settings-panel"
                id="settings-panel-storage"
                role="tabpanel"
              >
                <header className="settings-panel__header">
                  <span>Storage</span>
                  <h2>Your files stay close.</h2>
                  <p>Recordings, transcripts, summaries, and speech models remain on this computer.</p>
                </header>
                <div className="settings-storage-list">
                  <article className="settings-storage-card">
                    <span className="settings-storage-card__icon"><FolderIcon /></span>
                    <div>
                      <h3>Transcripts and recordings</h3>
                      <p>Open Sotto&apos;s private data folder to review or back up your meeting files.</p>
                      <button
                        className="settings-link"
                        disabled={busy}
                        onClick={() => void window.sotto?.revealTranscriptsFolder()}
                        type="button"
                      >
                        Open transcripts folder
                      </button>
                    </div>
                  </article>
                  <article className="settings-storage-card">
                    <span className="settings-storage-card__icon"><ModelIcon /></span>
                    <div>
                      <h3>Speech models</h3>
                      <p>Add Whisper files named like <code>ggml-small.bin</code> here to make them available for transcription.</p>
                      {settings.userModelsDirectory ? (
                        <code className="settings-path">{settings.userModelsDirectory}</code>
                      ) : null}
                      <button
                        className="settings-link"
                        disabled={busy}
                        onClick={() => void window.sotto?.revealModelsFolder()}
                        type="button"
                      >
                        Open models folder
                      </button>
                    </div>
                  </article>
                </div>
              </section>
            ) : null}

            {activeSection === 'shortcuts' ? (
              <section
                aria-labelledby="settings-tab-shortcuts"
                className="settings-panel"
                id="settings-panel-shortcuts"
                role="tabpanel"
              >
                <header className="settings-panel__header">
                  <span>Shortcuts</span>
                  <h2>Keep dictation within reach.</h2>
                  <p>The global shortcut works from any app while Sotto is running.</p>
                </header>
                <div className="settings-shortcut-card">
                  <span className="settings-shortcut-card__icon"><KeyboardIcon /></span>
                  <div>
                    <h3>Start or stop dictation</h3>
                    <p>Capture your microphone without switching windows.</p>
                  </div>
                  <kbd>{settings.dictationShortcut || '⌘⇧D'}</kbd>
                </div>
              </section>
            ) : null}

            {activeSection === 'about' ? (
              <section
                aria-labelledby="settings-tab-about"
                className="settings-panel"
                id="settings-panel-about"
                role="tabpanel"
              >
                <header className="settings-panel__header">
                  <span>About</span>
                  <h2>Sotto on this computer.</h2>
                  <p>See the installed version and check the trusted internal release channel.</p>
                </header>
                <div className="settings-card">
                  <div className="settings-version">
                    <div>
                      <span>Installed version</span>
                      <strong>{appVersion ? `Sotto ${appVersion}` : 'Version unavailable'}</strong>
                    </div>
                    <CheckCircleIcon />
                  </div>
                  <p aria-live="polite" role="status">
                    {isCheckingForUpdate
                      ? 'Checking for updates…'
                      : settingsUpdateStatus(appVersion, appUpdate)}
                  </p>
                  <button
                    className="settings-link settings-link--primary"
                    disabled={isCheckingForUpdate || updateInProgress}
                    onClick={() => void onCheckForUpdates()}
                    type="button"
                  >
                    {isCheckingForUpdate
                      ? 'Checking…'
                      : updateInProgress
                        ? 'Update in progress'
                        : 'Check for updates'}
                  </button>
                </div>
                <div className="settings-card">
                  <h3>Manual macOS updates</h3>
                  <p>
                    Large updates download as a signed DMG. Sotto will show it in Finder;
                    quit the app, open the DMG, and replace Sotto in Applications.
                    Your settings, recordings, and transcripts remain outside the app bundle.
                  </p>
                </div>
              </section>
            ) : null}

            {message ? (
              <p aria-live="polite" className="settings-message" role="status">
                {message}
              </p>
            ) : null}
          </div>
        </div>
      </section>
    </main>
  );
};
