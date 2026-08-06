import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { LiveCaptureHealth } from '../shared/contracts';
import { CaptureConfidencePanel } from './CaptureConfidencePanel';

const health: LiveCaptureHealth = {
  recordingId: '32ce6fee-8f3e-4f03-a266-46d6c00ef08c',
  kind: 'meeting',
  desktop: { permission: 'granted', track: 'ready', signal: 'detected' },
  microphone: { permission: 'granted', track: 'ready', signal: 'silent' },
};

describe('CaptureConfidencePanel', () => {
  it('shows separate live states and recovery guidance', () => {
    const markup = renderToStaticMarkup(
      <CaptureConfidencePanel
        kind="meeting"
        health={health}
        microphonePermission="granted"
        systemPermission="granted"
      />,
    );

    expect(markup).toContain('System audio');
    expect(markup).toContain('Signal detected');
    expect(markup).toContain('Microphone');
    expect(markup).toContain('No signal yet');
    expect(markup).toContain('Speak for a moment');
  });

  it('explains the preflight state before a recording starts', () => {
    const markup = renderToStaticMarkup(
      <CaptureConfidencePanel
        kind="meeting"
        health={null}
        microphonePermission="unknown"
        systemPermission="denied"
      />,
    );

    expect(markup).toContain('Permission status before recording');
    expect(markup).toContain('Permission needed');
    expect(markup).toContain('Allow System Audio Recording');
  });
});
