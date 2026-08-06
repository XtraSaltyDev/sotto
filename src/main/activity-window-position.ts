export interface ActivityWindowRectangle {
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface ActivityWindowDisplay {
  bounds: ActivityWindowRectangle;
  internal: boolean;
  workArea: ActivityWindowRectangle;
}

export interface ActivityWindowSize {
  height: number;
  width: number;
}

const EDGE_GAP = 10;
const NOTCH_SAFE_GAP = 16;
const NOTCH_MENU_BAR_HEIGHT = 30;

export const activityWindowAlwaysOnTopLevel = (
  platform: NodeJS.Platform,
): 'floating' | 'screen-saver' =>
  platform === 'darwin' ? 'screen-saver' : 'floating';

/**
 * Centers the activity pill inside the display's usable area. macOS reports a
 * taller work-area inset on notched built-in displays; an additional gap keeps
 * the pill visually clear of the camera housing and menu-bar edge.
 */
export const activityWindowBounds = (
  display: ActivityWindowDisplay,
  size: ActivityWindowSize,
  platform: NodeJS.Platform,
): ActivityWindowRectangle => {
  const { bounds, workArea } = display;
  const topInset = Math.max(0, workArea.y - bounds.y);
  const hasMacBookNotch =
    platform === 'darwin' &&
    display.internal &&
    topInset >= NOTCH_MENU_BAR_HEIGHT;
  const topGap = hasMacBookNotch ? NOTCH_SAFE_GAP : EDGE_GAP;
  const width = Math.min(size.width, Math.max(100, workArea.width - EDGE_GAP * 2));
  const height = Math.min(
    size.height,
    Math.max(72, workArea.height - topGap - EDGE_GAP),
  );
  const centeredX = workArea.x + Math.round((workArea.width - width) / 2);

  return {
    height,
    width,
    x: Math.max(
      workArea.x + EDGE_GAP,
      Math.min(centeredX, workArea.x + workArea.width - width - EDGE_GAP),
    ),
    y: workArea.y + topGap,
  };
};
