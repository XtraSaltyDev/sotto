import React from 'react';

/**
 * Shown when a summary is requested while another is already running. Sotto
 * sends one at a time, so the choice is to review this one now and let it
 * wait its turn, or to leave it alone.
 */
export const LocalAiBusyNotice = ({
  onCancel,
  onQueue,
  runningTitle,
}: {
  onCancel: () => void;
  onQueue: () => void;
  runningTitle: string | null;
}) => (
  <div
    className="local-ai-preview-backdrop"
    onClick={onCancel}
    role="presentation"
  >
    <div
      aria-labelledby="local-ai-busy-title"
      aria-modal="true"
      className="local-ai-busy"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onCancel();
      }}
      role="dialog"
    >
      <h2 id="local-ai-busy-title">A summary is already being generated</h2>
      <p>
        {runningTitle
          ? `Sotto is finishing the summary for “${runningTitle}”.`
          : 'Sotto is finishing another summary.'}{' '}
        It works on one at a time.
      </p>
      <div className="local-ai-preview__actions">
        <button
          className="local-ai-preview__primary"
          onClick={onQueue}
          type="button"
        >
          Review and queue
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
