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

export const LocalAiSettings = () => {
  const [connection, setConnection] =
    useState<LocalAiConnectionSummary>(EMPTY_CONNECTION);
  const [baseUrl, setBaseUrl] = useState(OLLAMA_OPENAI_BASE_URL);
  const [apiKey, setApiKey] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [models, setModels] = useState<LocalAiModel[]>([]);
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

  const connect = async () => {
    if (!window.sotto || busy !== null || !baseUrl.trim()) return;
    setBusy('connecting');
    setMessage(null);
    try {
      const result = await window.sotto.connectLocalAi({
        baseUrl,
        ...(apiKey.trim() ? { apiKey } : {}),
        ...(selectedModel ? { selectedModel } : {}),
      });
      if (result.outcome === 'rejected') {
        setMessage(result.reason);
        return;
      }
      setConnection(result.connection);
      setBaseUrl(result.connection.baseUrl);
      setModels(result.models);
      setSelectedModel(result.connection.selectedModel ?? '');
      setApiKey('');
      setMessage(
        `Connected to ${result.models.length} local model${result.models.length === 1 ? '' : 's'}.`,
      );
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

  return (
    <main className="workspace local-ai-workspace">
      <header className="topbar"><h1>Local AI</h1></header>
      <section className="local-ai-page" aria-labelledby="local-ai-title">
        <div className="local-ai-page__intro">
          <p className="eyebrow">Optional local intelligence</p>
          <h2 id="local-ai-title">Connect a model you control.</h2>
          <p>
            Use Ollama or another OpenAI-compatible endpoint on this computer or
            your private network. Sotto verifies the connection through{' '}
            <code>/v1/models</code> before saving it. A connected model can create
            richer meeting summaries when you explicitly ask for one.
          </p>
        </div>

        <div className="local-ai-grid">
          <form
            className="local-ai-card local-ai-form"
            onSubmit={(event) => {
              event.preventDefault();
              void connect();
            }}
          >
            <div className="local-ai-card__heading">
              <ModelIcon />
              <span><strong>OpenAI-compatible endpoint</strong><small>Local or private-network connections only</small></span>
            </div>

            <button
              className="local-ai-ollama"
              disabled={isBusy}
              onClick={() => {
                setBaseUrl(OLLAMA_OPENAI_BASE_URL);
                setApiKey('');
                setSelectedModel('');
                setModels([]);
                setMessage(null);
              }}
              type="button"
            >
              Use Ollama default
              <span>{OLLAMA_OPENAI_BASE_URL}</span>
            </button>

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
                placeholder={connection.hasApiKey ? 'Saved securely · leave blank to keep it' : 'Not required by default Ollama'}
                type="password"
                value={apiKey}
              />
              <small>Keys are encrypted with the operating system and are never shown again.</small>
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
                <small>Reconnect after changing the model to verify and save it.</small>
              </label>
            ) : null}

            <div className="local-ai-actions">
              <button className="button button--primary" disabled={isBusy || !baseUrl.trim()} type="submit">
                {busy === 'connecting' ? <SpinnerIcon className="spinner" /> : <ModelIcon />}
                <span>{busy === 'connecting' ? 'Checking endpoint…' : connection.configured ? 'Verify and save' : 'Connect and find models'}</span>
              </button>
              {connection.configured ? (
                <button className="local-ai-disconnect" disabled={isBusy} onClick={() => void disconnect()} type="button">
                  {busy === 'disconnecting' ? 'Removing…' : 'Disconnect'}
                </button>
              ) : null}
            </div>
            {message ? <p className="local-ai-message" role="status">{message}</p> : null}
          </form>

          <aside className="local-ai-card local-ai-status" aria-label="Local AI connection status">
            <span className={`local-ai-status__dot${connection.configured ? ' local-ai-status__dot--connected' : ''}`} />
            <p className="eyebrow">Connection</p>
            <h3>{connection.configured ? 'Ready for meeting summaries' : 'Not connected'}</h3>
            <dl>
              <div><dt>Endpoint</dt><dd>{connection.baseUrl || 'None saved'}</dd></div>
              <div><dt>Model</dt><dd>{connection.selectedModel || 'None selected'}</dd></div>
              <div><dt>API key</dt><dd>{connection.hasApiKey ? 'Stored securely' : 'Not stored'}</dd></div>
              <div><dt>Verified</dt><dd>{verifiedLabel(connection.verifiedAt)}</dd></div>
            </dl>
            <p className="local-ai-status__note">
              Transcription still runs through Sotto. Transcript text is sent
              to this endpoint only when you choose Improve with Local AI on a
              meeting summary.
            </p>
          </aside>
        </div>
      </section>
    </main>
  );
};
