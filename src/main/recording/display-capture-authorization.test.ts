import { describe, expect, it } from 'vitest';

import {
  DISPLAY_CAPTURE_AUTHORIZATION_WINDOW_MS,
  DisplayCaptureAuthorization,
} from './display-capture-authorization';

describe('DisplayCaptureAuthorization', () => {
  const request = (frame: object) => ({
    audioRequested: true,
    frame,
    userGesture: true,
    videoRequested: true,
  });

  it('consumes one trusted, user-initiated meeting capture', () => {
    const frame = {};
    const authorization = new DisplayCaptureAuthorization(() => 1_000);
    authorization.authorize(frame);

    expect(authorization.consume(request(frame), frame)).toBe(true);
    expect(authorization.consume(request(frame), frame)).toBe(false);
  });

  it('rejects expired, untrusted, incomplete, and script-only requests', () => {
    const frame = {};
    let now = 1_000;
    const authorization = new DisplayCaptureAuthorization(() => now);

    authorization.authorize(frame);
    expect(
      authorization.consume({ ...request(frame), userGesture: false }, frame),
    ).toBe(false);

    authorization.authorize(frame);
    expect(authorization.consume(request({}), frame)).toBe(false);

    authorization.authorize(frame);
    expect(
      authorization.consume({ ...request(frame), audioRequested: false }, frame),
    ).toBe(false);

    authorization.authorize(frame);
    now += DISPLAY_CAPTURE_AUTHORIZATION_WINDOW_MS + 1;
    expect(authorization.consume(request(frame), frame)).toBe(false);
  });
});
