import { SpinnerIcon } from './icons';

export type AppUpdateNoticeState =
  | { phase: 'available'; version: string; size: number }
  | { phase: 'downloading'; version: string }
  | { phase: 'downloaded'; fileName: string; version: string }
  | { phase: 'failed'; reason: string; version: string };

export const DISMISSED_UPDATE_VERSION_KEY = 'sotto:dismissed-update-version';

export const shouldOfferUpdate = (
  availableVersion: string,
  dismissedVersion: string | null,
): boolean => availableVersion !== dismissedVersion;

export const formatUpdateSize = (bytes: number): string =>
  `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;

export const UpdateNotice = ({
  onDismiss,
  onDownload,
  state,
}: {
  onDismiss: () => void;
  onDownload: () => void;
  state: AppUpdateNoticeState;
}) => (
  <aside
    aria-label="Sotto update"
    className={`update-notice${state.phase === 'failed' ? ' update-notice--failed' : ''}`}
    role="status"
  >
    {state.phase === 'available' ? (
      <>
        <div>
          <strong>Sotto {state.version} is available</strong>
          <p>{formatUpdateSize(state.size)} from your Spark server.</p>
        </div>
        <div className="update-notice__actions">
          <button className="update-notice__download" onClick={onDownload} type="button">
            Download
          </button>
          <button className="update-notice__dismiss" onClick={onDismiss} type="button">
            Not now
          </button>
        </div>
      </>
    ) : null}
    {state.phase === 'downloading' ? (
      <div className="update-notice__progress">
        <SpinnerIcon className="spinner" />
        <span>Downloading Sotto {state.version}…</span>
      </div>
    ) : null}
    {state.phase === 'downloaded' ? (
      <>
        <div>
          <strong>Update ready to install</strong>
          <p>{state.fileName} is in your Downloads folder. Quit Sotto and install it to finish updating.</p>
        </div>
        <div className="update-notice__actions">
          <button className="update-notice__dismiss" onClick={onDismiss} type="button">
            Done
          </button>
        </div>
      </>
    ) : null}
    {state.phase === 'failed' ? (
      <>
        <div>
          <strong>Update download failed</strong>
          <p>{state.reason}</p>
        </div>
        <div className="update-notice__actions">
          <button className="update-notice__download" onClick={onDownload} type="button">
            Retry
          </button>
          <button className="update-notice__dismiss" onClick={onDismiss} type="button">
            Not now
          </button>
        </div>
      </>
    ) : null}
  </aside>
);
