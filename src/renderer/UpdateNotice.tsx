import { DownloadIcon, SpinnerIcon } from './icons';

export type AppUpdateNoticeState =
  | { phase: 'available'; version: string; size: number }
  | {
      phase: 'downloading';
      version: string;
      receivedBytes: number;
      totalBytes: number;
    }
  | { phase: 'preparing'; version: string }
  | { phase: 'ready'; version: string }
  | { phase: 'restarting'; version: string }
  | { phase: 'downloaded'; fileName: string; version: string }
  | { phase: 'cancelled'; version: string }
  | { phase: 'failed'; reason: string; version: string }
  | { phase: 'up-to-date'; version: string }
  | { phase: 'check-failed'; reason: string };

export const DISMISSED_UPDATE_VERSION_KEY = 'sotto:dismissed-update-version';

export const shouldOfferUpdate = (
  availableVersion: string,
  dismissedVersion: string | null,
): boolean => availableVersion !== dismissedVersion;

export const formatUpdateSize = (bytes: number): string =>
  `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;

export const formatUpdateProgress = (
  receivedBytes: number,
  totalBytes: number,
): string => {
  if (totalBytes <= 0) return 'Starting…';
  const percent = Math.min(
    100,
    Math.max(0, Math.floor((receivedBytes / totalBytes) * 100)),
  );
  return `${percent}%`;
};

export const updateProgressPercent = (
  receivedBytes: number,
  totalBytes: number,
): number | null =>
  totalBytes > 0
    ? Math.min(100, Math.max(0, Math.floor((receivedBytes / totalBytes) * 100)))
    : null;

const UPDATE_BADGE_PHASES: ReadonlySet<AppUpdateNoticeState['phase']> = new Set([
  'available',
  'downloading',
  'preparing',
  'ready',
  'restarting',
  'downloaded',
  'failed',
  'cancelled',
]);

/**
 * Compact rounded square beside the brand mark. It appears only while an
 * update flow is relevant, expands on hover to name the action, and opens
 * the update popup (starting the download when the update is still
 * pending).
 */
export const UpdateBadge = ({
  onOpen,
  state,
}: {
  onOpen: () => void;
  state: AppUpdateNoticeState;
}) => {
  if (!UPDATE_BADGE_PHASES.has(state.phase)) return null;
  const label = state.phase === 'ready' ? 'Restart' : 'Update';
  return (
    <button
      aria-label={`Sotto update: ${label}`}
      className={`update-badge${state.phase === 'ready' ? ' update-badge--ready' : ''}`}
      onClick={onOpen}
      type="button"
    >
      {state.phase === 'downloading' ||
      state.phase === 'preparing' ||
      state.phase === 'restarting' ? (
        <SpinnerIcon className="spinner" />
      ) : (
        <DownloadIcon />
      )}
      <span className="update-badge__label">{label}</span>
    </button>
  );
};

export const UpdatePopup = ({
  onCancel,
  onClose,
  onDismiss,
  onDownload,
  onInstall,
  onRevealDownloaded,
  state,
}: {
  onCancel: () => void;
  onClose: () => void;
  onDismiss: () => void;
  onDownload: () => void;
  onInstall: () => void;
  onRevealDownloaded?: () => void;
  state: AppUpdateNoticeState;
}) => {
  const percent =
    state.phase === 'downloading'
      ? updateProgressPercent(state.receivedBytes, state.totalBytes)
      : null;
  return (
    <div
      className="update-popup-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <div
        aria-label="Sotto update"
        aria-modal="true"
        className="update-popup"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        {state.phase === 'available' ? (
          <>
            <strong>Sotto {state.version} is available</strong>
            <p>{formatUpdateSize(state.size)} from your Spark server.</p>
            <div className="update-popup__actions">
              <button className="update-popup__primary" onClick={onDownload} type="button">
                Update
              </button>
              <button className="update-popup__secondary" onClick={onClose} type="button">
                Not now
              </button>
            </div>
          </>
        ) : null}
        {state.phase === 'downloading' ? (
          <>
            <strong>Updating to Sotto {state.version}</strong>
            <div
              aria-valuemax={100}
              aria-valuemin={0}
              className="update-popup__bar"
              role="progressbar"
              {...(percent === null ? {} : { 'aria-valuenow': percent })}
            >
              <span
                className="update-popup__bar-fill"
                style={{ width: `${percent ?? 4}%` }}
              />
            </div>
            <p>
              {formatUpdateProgress(state.receivedBytes, state.totalBytes)}
              {state.totalBytes > 0
                ? ` of ${formatUpdateSize(state.totalBytes)}`
                : ''}
            </p>
            <div className="update-popup__actions">
              <button className="update-popup__secondary" onClick={onCancel} type="button">
                Cancel
              </button>
            </div>
          </>
        ) : null}
        {state.phase === 'preparing' ? (
          <>
            <strong>Preparing Sotto {state.version}</strong>
            <div className="update-popup__bar" role="progressbar">
              <span className="update-popup__bar-fill update-popup__bar-fill--indeterminate" />
            </div>
            <p>Verifying the download and unpacking the new version…</p>
          </>
        ) : null}
        {state.phase === 'ready' ? (
          <>
            <strong>Restart to finish updating</strong>
            <p>Sotto {state.version} is ready. Restart now to switch to it.</p>
            <div className="update-popup__actions">
              <button className="update-popup__primary" onClick={onInstall} type="button">
                Restart now
              </button>
              <button className="update-popup__secondary" onClick={onClose} type="button">
                Later
              </button>
            </div>
          </>
        ) : null}
        {state.phase === 'restarting' ? (
          <>
            <strong>Installing Sotto {state.version}</strong>
            <div className="update-popup__bar" role="progressbar">
              <span className="update-popup__bar-fill" style={{ width: '100%' }} />
            </div>
            <p>Sotto will restart in a moment…</p>
          </>
        ) : null}
        {state.phase === 'downloaded' ? (
          <>
            <strong>Update ready to install</strong>
            <p>
              {state.fileName} is in Downloads. Quit Sotto, open the DMG, and
              replace Sotto in Applications to finish updating.
            </p>
            <div className="update-popup__actions">
              {onRevealDownloaded ? (
                <button
                  className="update-popup__primary"
                  onClick={onRevealDownloaded}
                  type="button"
                >
                  Show in Finder
                </button>
              ) : null}
              <button className="update-popup__secondary" onClick={onClose} type="button">
                Done
              </button>
            </div>
          </>
        ) : null}
        {state.phase === 'failed' ? (
          <>
            <strong>Update failed</strong>
            <p>{state.reason}</p>
            <div className="update-popup__actions">
              <button className="update-popup__primary" onClick={onDownload} type="button">
                Retry
              </button>
              <button className="update-popup__secondary" onClick={onDismiss} type="button">
                Not now
              </button>
            </div>
          </>
        ) : null}
        {state.phase === 'cancelled' ? (
          <>
            <strong>Update canceled</strong>
            <p>No changes were made. Sotto {state.version} is still available.</p>
            <div className="update-popup__actions">
              <button className="update-popup__primary" onClick={onDownload} type="button">
                Try again
              </button>
              <button className="update-popup__secondary" onClick={onDismiss} type="button">
                Not now
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
};

export const UpdateNotice = ({
  onDismiss,
  onDownload,
  onCancel,
  onInstall,
  onRevealDownloaded,
  state,
}: {
  onDismiss: () => void;
  onDownload: () => void;
  onCancel?: () => void;
  onInstall?: () => void;
  onRevealDownloaded?: () => void;
  state: AppUpdateNoticeState;
}) => (
  <aside
    aria-label="Sotto update"
    className={`update-notice${state.phase === 'failed' || state.phase === 'check-failed' ? ' update-notice--failed' : ''}`}
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
            Update
          </button>
          <button className="update-notice__dismiss" onClick={onDismiss} type="button">
            Not now
          </button>
        </div>
      </>
    ) : null}
    {state.phase === 'ready' ? (
      <>
        <div>
          <strong>Restart to finish updating</strong>
          <p>Sotto {state.version} is ready. Restart now to switch to it.</p>
        </div>
        <div className="update-notice__actions">
          <button className="update-notice__download" onClick={onInstall} type="button">
            Restart now
          </button>
          <button className="update-notice__dismiss" onClick={onDismiss} type="button">
            Later
          </button>
        </div>
      </>
    ) : null}
    {state.phase === 'restarting' ? (
      <div className="update-notice__progress">
        <SpinnerIcon className="spinner" />
        <span>Installing Sotto {state.version}…</span>
      </div>
    ) : null}
    {state.phase === 'downloading' ? (
      <>
        <div className="update-notice__progress">
          <SpinnerIcon className="spinner" />
          <span>
            Downloading Sotto {state.version}…{' '}
            {formatUpdateProgress(state.receivedBytes, state.totalBytes)}
          </span>
        </div>
        {onCancel ? (
          <div className="update-notice__actions">
            <button className="update-notice__dismiss" onClick={onCancel} type="button">
              Cancel
            </button>
          </div>
        ) : null}
      </>
    ) : null}
    {state.phase === 'preparing' ? (
      <div className="update-notice__progress">
        <SpinnerIcon className="spinner" />
        <span>Verifying and preparing Sotto {state.version}…</span>
      </div>
    ) : null}
    {state.phase === 'downloaded' ? (
      <>
        <div>
          <strong>Update ready to install</strong>
          <p>{state.fileName} is in Downloads. Quit Sotto, open the DMG, and replace Sotto in Applications to finish updating.</p>
        </div>
        <div className="update-notice__actions">
          {onRevealDownloaded ? (
            <button className="update-notice__download" onClick={onRevealDownloaded} type="button">
              Show in Finder
            </button>
          ) : null}
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
    {state.phase === 'cancelled' ? (
      <>
        <div>
          <strong>Update canceled</strong>
          <p>No changes were made. Sotto {state.version} is still available.</p>
        </div>
        <div className="update-notice__actions">
          <button className="update-notice__download" onClick={onDownload} type="button">
            Try again
          </button>
          <button className="update-notice__dismiss" onClick={onDismiss} type="button">
            Not now
          </button>
        </div>
      </>
    ) : null}
    {state.phase === 'up-to-date' ? (
      <>
        <div>
          <strong>Sotto is up to date</strong>
          <p>You are running the latest version, {state.version}.</p>
        </div>
        <div className="update-notice__actions">
          <button className="update-notice__dismiss" onClick={onDismiss} type="button">
            Done
          </button>
        </div>
      </>
    ) : null}
    {state.phase === 'check-failed' ? (
      <>
        <div>
          <strong>Could not check for updates</strong>
          <p>{state.reason}</p>
        </div>
        <div className="update-notice__actions">
          <button className="update-notice__dismiss" onClick={onDismiss} type="button">
            Done
          </button>
        </div>
      </>
    ) : null}
  </aside>
);
