import type { ModelProvisioningStatus } from '../shared/contracts';

const formatModelBytes = (bytes: number): string => {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

export const modelProvisioningLabel = (
  status: ModelProvisioningStatus,
): string => {
  if (status.state === 'checking') return 'Checking for a verified local model…';
  if (status.state === 'required') {
    return 'Model setup is required before transcription can start.';
  }
  if (status.state === 'downloading') {
    return `Downloading ${formatModelBytes(status.receivedBytes ?? 0)} of ${formatModelBytes(status.totalBytes ?? 0)}…`;
  }
  if (status.state === 'verifying') return 'Verifying the downloaded model…';
  return status.message;
};

export const ModelProvisioningNotice = ({
  status,
  onRetry,
  onCancel,
  onImport,
}: {
  status: ModelProvisioningStatus;
  onRetry: () => void;
  onCancel: () => void;
  onImport: () => void;
}) => (
  <aside className="home-message model-setup" aria-live="polite">
    <div>
      <strong>Set up local transcription</strong>
      <p>{modelProvisioningLabel(status)}</p>
      <p className="model-setup__privacy">
        The approximately 1.5 GB model is downloaded to this computer.
        Recordings and transcripts stay here; Sotto does not upload them.
      </p>
      {status.state === 'downloading' ? (
        <div
          className="progress-track"
          aria-label="Model download progress"
          aria-valuemax={status.totalBytes ?? 0}
          aria-valuemin={0}
          aria-valuenow={status.receivedBytes ?? 0}
          role="progressbar"
        >
          <span
            style={{
              width: `${Math.min(
                100,
                ((status.receivedBytes ?? 0) /
                  Math.max(1, status.totalBytes ?? 1)) *
                  100,
              )}%`,
            }}
          />
        </div>
      ) : null}
    </div>
    <div className="model-setup__actions">
      {status.state === 'downloading' ? (
        <button className="text-button" onClick={onCancel} type="button">
          Cancel
        </button>
      ) : null}
      {['required', 'failed', 'cancelled'].includes(status.state) ? (
        <>
          <button className="text-button" onClick={onRetry} type="button">
            Retry download
          </button>
          <button className="text-button" onClick={onImport} type="button">
            Import matching model
          </button>
        </>
      ) : null}
    </div>
  </aside>
);
