import React from 'react';

import type { LocalAiSummaryPreview } from '../shared/contracts';
import { formatDuration } from './app-format';
import {
  describeLocalAiRequestCount,
  describeLocalAiSendScope,
  describeLocalAiSpeakers,
  localAiPreviewDocuments,
  localAiTranscriptLines,
  LOCAL_AI_CONSOLIDATION_NOTE,
} from './local-ai-send-preview';

/**
 * The consent step for the one action that moves transcript content off the
 * device. It leads with a readable rendering of what is going out, and keeps
 * the literal request text one disclosure away, so an ordinary reader is not
 * asked to audit JSON to answer "what is being sent?".
 */
export const LocalAiSendPreview = ({
  onCancel,
  onConfirm,
  preview,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  preview: LocalAiSummaryPreview;
}) => {
  const lines = localAiTranscriptLines(preview);
  const requestCount = describeLocalAiRequestCount(preview);
  return (
    <div
      className="local-ai-preview-backdrop"
      onClick={onCancel}
      role="presentation"
    >
      <div
        aria-labelledby="local-ai-preview-title"
        aria-modal="true"
        className="local-ai-preview"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.stopPropagation();
          onCancel();
        }}
        role="dialog"
      >
        <header className="local-ai-preview__header">
          <h2 id="local-ai-preview-title">Send this transcript to {preview.model}?</h2>
          <p>
            Everything else in Sotto stays on this device. This is the only
            action that sends transcript content to the model you connected.
          </p>
        </header>

        <dl className="local-ai-preview__facts">
          <div>
            <dt>Goes to</dt>
            <dd>
              {preview.model}
              <span className="local-ai-preview__endpoint">{preview.endpoint}</span>
            </dd>
          </div>
          <div>
            <dt>Includes</dt>
            <dd>{describeLocalAiSendScope(preview)}</dd>
          </div>
          <div>
            <dt>Speaker names</dt>
            <dd>{describeLocalAiSpeakers(preview)}</dd>
          </div>
          {preview.sendsApiKey ? (
            <div>
              <dt>API key</dt>
              <dd>Your saved key is sent with the request.</dd>
            </div>
          ) : null}
        </dl>

        <div className="local-ai-preview__documents" tabIndex={0}>
          {lines.length ? (
            <ol className="local-ai-preview__lines">
              {lines.map((line, index) => (
                <li key={`${line.startMs}-${index}`}>
                  <span className="local-ai-preview__time">
                    {formatDuration(line.startMs)}
                  </span>
                  {line.speaker ? (
                    <span className="local-ai-preview__speaker">{line.speaker}</span>
                  ) : null}
                  <span className="local-ai-preview__text">{line.text}</span>
                </li>
              ))}
            </ol>
          ) : (
            // Only reachable if the request format changes; never claim the
            // transcript is empty when the exact text below says otherwise.
            <p className="local-ai-preview__note">
              Sotto could not lay this request out as transcript lines. Use
              <strong> Show the exact request text</strong> to review it.
            </p>
          )}
        </div>

        {requestCount ? (
          <p className="local-ai-preview__note">{requestCount}</p>
        ) : null}

        <details className="local-ai-preview__exact">
          <summary>Show the exact request text</summary>
          <div className="local-ai-preview__documents" tabIndex={0}>
            {localAiPreviewDocuments(preview).map((document) => (
              <section key={document.label}>
                <h3>{document.label}</h3>
                <pre>{document.body}</pre>
              </section>
            ))}
            {preview.needsConsolidationRequest ? (
              <p className="local-ai-preview__note">{LOCAL_AI_CONSOLIDATION_NOTE}</p>
            ) : null}
          </div>
        </details>

        <div className="local-ai-preview__actions">
          <button
            className="local-ai-preview__primary"
            onClick={onConfirm}
            type="button"
          >
            Send
          </button>
          <button
            className="local-ai-preview__secondary"
            onClick={onCancel}
            type="button"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};
