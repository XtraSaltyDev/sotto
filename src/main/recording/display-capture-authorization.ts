export interface DisplayCaptureRequest {
  readonly audioRequested: boolean;
  readonly frame: object | null;
  readonly userGesture: boolean;
  readonly videoRequested: boolean;
}

export const DISPLAY_CAPTURE_AUTHORIZATION_WINDOW_MS = 5_000;

/** One-shot main-frame capability for a user-initiated meeting capture. */
export class DisplayCaptureAuthorization {
  private expiresAt = 0;
  private frame: object | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  authorize(frame: object): void {
    this.frame = frame;
    this.expiresAt = this.now() + DISPLAY_CAPTURE_AUTHORIZATION_WINDOW_MS;
  }

  consume(request: DisplayCaptureRequest, expectedFrame: object | null): boolean {
    const authorized =
      expectedFrame !== null &&
      request.frame === expectedFrame &&
      this.frame === expectedFrame &&
      request.userGesture &&
      request.audioRequested &&
      request.videoRequested &&
      this.now() <= this.expiresAt;

    this.clear();
    return authorized;
  }

  clear(): void {
    this.frame = null;
    this.expiresAt = 0;
  }
}
