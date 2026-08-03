import { recordingFailurePresentation } from './live-recording-errors';

export const CaptureFailureNotice = ({
  message,
  onDismiss,
  platform,
}: {
  message: string;
  onDismiss?: () => void;
  platform: string;
}) => {
  const presentation = recordingFailurePresentation(message, platform);
  return (
    <aside
      className={`capture-notice capture-notice--${presentation.kind}`}
      role={presentation.kind === 'recovery' ? 'status' : 'alert'}
    >
      <div>
        <strong>{presentation.title}</strong>
        <p>{message}</p>
      </div>
      {onDismiss ? (
        <button onClick={onDismiss} type="button">Dismiss</button>
      ) : null}
    </aside>
  );
};

export interface AppNotice {
  kind: 'error' | 'info';
  text: string;
}

export const HomeNotice = ({
  notice,
  onDismiss,
}: {
  notice: AppNotice;
  onDismiss?: () => void;
}) =>
  notice.kind === 'error' ? (
    <CaptureFailureNotice
      message={notice.text}
      onDismiss={onDismiss}
      platform={navigator.platform}
    />
  ) : (
    <p className="home-status" role="status" aria-live="polite">{notice.text}</p>
  );
