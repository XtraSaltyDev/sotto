import { useEffect, useMemo, useState } from 'react';

import {
  OLLAMA_OPENAI_BASE_URL,
  type LocalAiConnectionSummary,
  type LocalAiModel,
} from '../shared/contracts';
import { ModelIcon, SpinnerIcon } from './icons';

const EMPTY_CONNECTION: LocalAiConnectionSummary = {
  configured: false,
  baseUrl: '',
  selectedModel: null,
  availableModels: [],
  hasApiKey: false,
  verifiedAt: null,
};

const verifiedLabel = (value: string | null): string =>
  value
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(value))
    : 'Not verified';

export const isOllamaEndpoint = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      url.port === '11434'
    );
  } catch {
    return false;
  }
};

export const localAiConnectionMessage = (
  modelCount: number,
  selectedModel: string | null,
  ollama: boolean,
): string => {
  const modelLabel = `${modelCount} model${modelCount === 1 ? '' : 's'}`;
  const endpointLabel = ollama ? 'Ollama is connected' : 'The endpoint is connected';
  return selectedModel
    ? `${endpointLabel}. ${modelLabel} ${modelCount === 1 ? 'is' : 'are'} available; Sotto will use ${selectedModel} for summaries.`
    : `${endpointLabel}. ${modelLabel} ${modelCount === 1 ? 'is' : 'are'} available.`;
};

export const LocalAiSettings = () => {
  const [connection, setConnection] =
    useState<LocalAiConnectionSummary>(EMPTY_CONNECTION);
  const [baseUrl, setBaseUrl] = useState(OLLAMA_OPENAI_BASE_URL);
  const [apiKey, setApiKey] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [models, setModels] = useState<LocalAiModel[]>([]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [busy, setBusy] =
    useState<'loading' | 'connecting' | 'disconnecting' | null>('loading');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!window.sotto) {
      setBusy('loading');
      setMessage('Sotto must run in its desktop window.');
      return undefined;
    }
    window.sotto
      .getLocalAiConnection()
      .then((saved) => {
        if (cancelled) return;
        setConnection(saved);
        setBaseUrl(saved.baseUrl || OLLAMA_OPENAI_BASE_URL);
        setSelectedModel(saved.selectedModel ?? '');
        setModels(saved.availableModels ?? []);
        setAdvancedOpen(saved.configured && !isOllamaEndpoint(saved.baseUrl));
      })
      .catch(() => {
        if (!cancelled) setMessage('Sotto could not read the saved Local AI connection.');
      })
      .finally(() => {
        if (!cancelled) setBusy(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const availableModels = useMemo(() => {
    if (
      selectedModel &&
      !models.some((model) => model.id === selectedModel)
    ) {
      return [{ id: selectedModel, ownedBy: null }, ...models];
    }
    return models;
  }, [models, selectedModel]);

  const connect = async (override?: {
    baseUrl: string;
    apiKey?: string;
    selectedModel?: string;
  }) => {
    const nextBaseUrl = override?.baseUrl ?? baseUrl;
    const nextApiKey = override?.apiKey ?? apiKey;
    const nextSelectedModel = override?.selectedModel ?? selectedModel;
    if (!window.sotto || busy !== null || !nextBaseUrl.trim()) return;
    setBusy('connecting');
    setMessage(null);
    try {
      const result = await window.sotto.connectLocalAi({
        baseUrl: nextBaseUrl,
        ...(nextApiKey.trim() ? { apiKey: nextApiKey } : {}),
        ...(nextSelectedModel ? { selectedModel: nextSelectedModel } : {}),
      });
      if (result.outcome === 'rejected') {
        setMessage(result.reason);
        return;
      }
      setConnection(result.connection);
      setAdvancedOpen(!isOllamaEndpoint(result.connection.baseUrl));
      setBaseUrl(result.connection.baseUrl);
      setModels(result.models);
      setSelectedModel(result.connection.selectedModel ?? '');
      setApiKey('');
      setMessage(localAiConnectionMessage(
        result.models.length,
        result.connection.selectedModel,
        isOllamaEndpoint(result.connection.baseUrl),
      ));
    } catch {
      setMessage('Sotto could not connect to that local AI endpoint.');
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    if (!window.sotto || busy !== null) return;
    setBusy('disconnecting');
    setMessage(null);
    try {
      await window.sotto.disconnectLocalAi();
      setConnection(EMPTY_CONNECTION);
      setAdvancedOpen(false);
      setModels([]);
      setSelectedModel('');
      setApiKey('');
      setMessage('The Local AI connection was removed.');
    } catch {
      setMessage('Sotto could not remove the Local AI connection.');
    } finally {
      setBusy(null);
    }
  };

  const isBusy = busy !== null;
  const connectedToOllama =
    connection.configured && isOllamaEndpoint(connection.baseUrl);

  return (
    <main className="workspace local-ai-workspace">
      <header className="topbar"><h1>Local AI</h1></header>
      <section className="local-ai-page" aria-labelledby="local-ai-title">
        <div className="local-ai-page__intro">
          <h2 id="local-ai-title">Improve summaries with a model you control.</h2>
          <p>
            Sotto already creates Key Points, Decisions, and Action Items. A local
            model adds stronger context and more natural wording without sending
            the transcript to a cloud service.
          </p>
        </div>

        <div className="local-ai-grid">
          <div className="local-ai-card local-ai-setup">
            <section className="local-ai-quick" aria-labelledby="ollama-title">
              <div className="local-ai-card__heading">
                <ModelIcon />
                <span>
                  <strong id="ollama-title">Ollama on this computer</strong>
                  <small>Recommended · no API key needed</small>
                </span>
              </div>
              <p>
                If Ollama is running, Sotto will find its installed models and
                select one automatically. Nothing is sent outside this computer.
              </p>
              <code>{OLLAMA_OPENAI_BASE_URL}</code>
              <button
                className="button button--primary local-ai-quick__button"
                disabled={isBusy}
                onClick={() => void connect({
                  apiKey: '',
                  baseUrl: OLLAMA_OPENAI_BASE_URL,
                  selectedModel:
                    connectedToOllama && connection.selectedModel
                      ? connection.selectedModel
                      : '',
                })}
                type="button"
              >
                {busy === 'connecting' ? <SpinnerIcon className="spinner" /> : <ModelIcon />}
                <span>
                  {busy === 'connecting'
                    ? 'Looking for Ollama…'
                    : connectedToOllama
                      ? 'Check Ollama connection'
                      : 'Connect Ollama'}
                </span>
              </button>
              {!connectedToOllama ? (
                <p className="local-ai-quick__help">
                  Start Ollama first. If no model is installed, download a small
                  model in Ollama, then return here.
                </p>
              ) : null}
              {connectedToOllama && availableModels.length > 0 ? (
                <div className="local-ai-models" aria-labelledby="ollama-models-title">
                  <div className="local-ai-models__heading">
                    <strong id="ollama-models-title">Models on this connection</strong>
                    <span>{availableModels.length} available</span>
                  </div>
                  <div className="local-ai-models__list" role="group" aria-label="Choose the model Sotto uses for summaries">
                    {availableModels.map((model) => {
                      const isSelected = model.id === selectedModel;
                      return (
                        <button
                          aria-pressed={isSelected}
                          disabled={isBusy}
                          key={model.id}
                          onClick={() => void connect({
                            apiKey: '',
                            baseUrl: connection.baseUrl,
                            selectedModel: model.id,
                          })}
                          title={model.id}
                          type="button"
                        >
                          <span>{model.id}</span>
                          <small>{isSelected ? 'Used for summaries' : 'Available'}</small>
                        </button>
                      );
                    })}
                  </div>
                  {(connection.availableModels?.length ?? 0) <= 1 ? (
                    <p>Check the Ollama connection to refresh the installed model list.</p>
                  ) : null}
                </div>
              ) : null}
            </section>

            <details
              className="local-ai-advanced"
              onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
              open={advancedOpen}
            >
              <summary>Connect another OpenAI-compatible endpoint</summary>
              <form
                className="local-ai-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void connect();
                }}
              >
                <label className="local-ai-field">
                  <span>Base URL</span>
                  <input
                    autoCapitalize="off"
                    autoCorrect="off"
                    disabled={isBusy}
                    onChange={(event) => {
                      setBaseUrl(event.target.value);
                      setModels([]);
                      setSelectedModel('');
                      setMessage(null);
                    }}
                    placeholder={OLLAMA_OPENAI_BASE_URL}
                    spellCheck={false}
                    type="url"
                    value={baseUrl}
                  />
                  <small>A root URL automatically receives <code>/v1</code>.</small>
                </label>

                <label className="local-ai-field">
                  <span>API key <em>Optional</em></span>
                  <input
                    autoComplete="off"
                    disabled={isBusy}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={connection.hasApiKey ? 'Saved securely · leave blank to keep it' : 'Only when your endpoint requires one'}
                    type="password"
                    value={apiKey}
                  />
                  <small>Keys are encrypted by the operating system and are never shown again.</small>
                </label>

                {availableModels.length > 0 ? (
                  <label className="local-ai-field">
                    <span>Model</span>
                    <select
                      disabled={isBusy}
                      onChange={(event) => setSelectedModel(event.target.value)}
                      value={selectedModel}
                    >
                      {availableModels.map((model) => (
                        <option key={model.id} value={model.id}>{model.id}</option>
                      ))}
                    </select>
                    <small>Verify again after choosing a different model.</small>
                  </label>
                ) : null}

                <div className="local-ai-actions">
                  <button className="button button--primary" disabled={isBusy || !baseUrl.trim()} type="submit">
                    {busy === 'connecting' ? <SpinnerIcon className="spinner" /> : <ModelIcon />}
                    <span>{busy === 'connecting' ? 'Checking endpoint…' : connection.configured ? 'Verify and save' : 'Connect and find models'}</span>
                  </button>
                </div>
              </form>
            </details>
            {message ? (
              <p
                aria-live="polite"
                className="local-ai-message"
                role={/could not|rejected|invalid|no available/iu.test(message) ? 'alert' : 'status'}
              >
                {message}
              </p>
            ) : null}
          </div>

          <aside className="local-ai-card local-ai-status" aria-label="Local AI connection status">
            <span className={`local-ai-status__dot${connection.configured ? ' local-ai-status__dot--connected' : ''}`} />
            <p className="eyebrow">{connection.configured ? 'Connected endpoint' : 'Connection'}</p>
            <h3>{connectedToOllama ? 'Ollama ready' : connection.configured ? 'Ready for meeting summaries' : 'Not connected'}</h3>
            <dl>
              <div><dt>Endpoint</dt><dd>{connection.baseUrl || 'None saved'}</dd></div>
              <div><dt>Summary model</dt><dd>{connection.selectedModel || 'None selected'}</dd></div>
              <div><dt>Available models</dt><dd>{models.length > 0 ? models.length : 'Check connection'}</dd></div>
              <div><dt>API key</dt><dd>{connection.hasApiKey ? 'Stored securely' : 'Not stored'}</dd></div>
              <div><dt>Verified</dt><dd>{verifiedLabel(connection.verifiedAt)}</dd></div>
            </dl>
            <p className="local-ai-status__note">
              Transcription still runs through Sotto. Transcript text is sent
              to this endpoint only when you choose Improve with Local AI on a
              meeting summary.
            </p>
            {connection.configured ? (
              <button className="local-ai-disconnect" disabled={isBusy} onClick={() => void disconnect()} type="button">
                {busy === 'disconnecting' ? 'Removing connection…' : 'Disconnect endpoint'}
              </button>
            ) : null}
          </aside>
        </div>
      </section>
    </main>
  );
};
