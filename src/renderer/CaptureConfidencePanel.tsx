import type {
  CapturePermissionState,
  LiveCaptureHealth,
  LiveCaptureSourceHealth,
  RecordingKind,
} from '../shared/contracts';
import {
  captureSourceGuidance,
  captureSourceLabel,
  captureSourceStatus,
  sourceHealth,
} from './capture-confidence';

type CaptureConfidencePanelProps = {
  kind: RecordingKind;
  health: LiveCaptureHealth | null;
  microphonePermission: CapturePermissionState;
  systemPermission: CapturePermissionState;
  compact?: boolean;
};

const healthForPermission = (
  permission: CapturePermissionState,
): LiveCaptureSourceHealth => sourceHealth(permission, 'unknown', 'unknown');

export const CaptureConfidencePanel = ({
  kind,
  health,
  microphonePermission,
  systemPermission,
  compact = false,
}: CaptureConfidencePanelProps) => {
  const sources: Array<{
    id: 'desktop' | 'microphone';
    health: LiveCaptureSourceHealth;
  }> = [
    {
      id: 'desktop',
      health:
        kind === 'meeting'
          ? health?.desktop ?? healthForPermission(systemPermission)
          : sourceHealth('not-used', 'not-used', 'not-used'),
    },
    {
      id: 'microphone',
      health: health?.microphone ?? healthForPermission(microphonePermission),
    },
  ];

  return (
    <section
      aria-label="Capture confidence"
      className={`capture-confidence${compact ? ' capture-confidence--compact' : ''}`}
    >
      <div className="capture-confidence__heading">
        <strong>Capture check</strong>
        <span>{health ? 'Watching live tracks and signal' : 'Permission status before recording'}</span>
      </div>
      <div className="capture-confidence__sources">
        {sources.map(({ id, health: source }) => {
          const status = captureSourceStatus(source);
          const guidance = captureSourceGuidance(id, source, kind);
          return (
            <div className="capture-confidence__source" key={id}>
              <div className="capture-confidence__source-heading">
                <span>{captureSourceLabel(id)}</span>
                <span className={`capture-confidence__state capture-confidence__state--${status.tone}`}>
                  <span aria-hidden="true" className="capture-confidence__dot" />
                  {status.label}
                </span>
              </div>
              {guidance ? <p>{guidance}</p> : null}
            </div>
          );
        })}
      </div>
      {!compact ? (
        <p className="capture-confidence__note">
          A ready track may be quiet until someone speaks or meeting audio plays. Sotto keeps the channels separate while it watches.
        </p>
      ) : null}
    </section>
  );
};
