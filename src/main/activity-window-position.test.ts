import { describe, expect, it } from 'vitest';

import {
  activityWindowAlwaysOnTopLevel,
  activityWindowBounds,
} from './activity-window-position';

describe('activityWindowAlwaysOnTopLevel', () => {
  it('uses the full-screen-safe macOS level and a portable fallback elsewhere', () => {
    expect(activityWindowAlwaysOnTopLevel('darwin')).toBe('screen-saver');
    expect(activityWindowAlwaysOnTopLevel('win32')).toBe('floating');
  });
});

describe('activityWindowBounds', () => {
  it('centers the pill at the top of the selected display work area', () => {
    expect(
      activityWindowBounds(
        {
          bounds: { x: 1920, y: 0, width: 1920, height: 1080 },
          internal: false,
          workArea: { x: 1920, y: 25, width: 1920, height: 1055 },
        },
        { width: 520, height: 116 },
        'darwin',
      ),
    ).toEqual({ x: 2620, y: 35, width: 520, height: 116 });
  });

  it('adds camera-notch clearance on a built-in MacBook display', () => {
    expect(
      activityWindowBounds(
        {
          bounds: { x: 0, y: 0, width: 1512, height: 982 },
          internal: true,
          workArea: { x: 0, y: 38, width: 1512, height: 944 },
        },
        { width: 520, height: 116 },
        'darwin',
      ),
    ).toEqual({ x: 496, y: 54, width: 520, height: 116 });
  });

  it('does not apply notch spacing to a tall inset on another platform', () => {
    expect(
      activityWindowBounds(
        {
          bounds: { x: -1440, y: 0, width: 1440, height: 900 },
          internal: true,
          workArea: { x: -1440, y: 40, width: 1440, height: 860 },
        },
        { width: 520, height: 116 },
        'win32',
      ).y,
    ).toBe(50);
  });

  it('keeps an oversized pill inside a narrow display', () => {
    expect(
      activityWindowBounds(
        {
          bounds: { x: 0, y: 0, width: 480, height: 800 },
          internal: false,
          workArea: { x: 0, y: 24, width: 480, height: 776 },
        },
        { width: 520, height: 116 },
        'darwin',
      ),
    ).toEqual({ x: 10, y: 34, width: 460, height: 116 });
  });
});
