// The tab strip needs enough room to expose useful context beside the fixed
// Windows/Linux titlebar reservation. Existing persisted widths remain intact;
// this only affects a new profile without a saved preference.
export const WORK_PANEL_MIN_WIDTH = 244;
export const WORK_PANEL_DEFAULT_WIDTH = 420;
export const WORK_PANEL_CHAT_MIN_WIDTH = 1040;
export const WORK_PANEL_CHAT_MAX_WIDTH = 10000;
/** Main reading pane reservation; the sidebar yields before the transcript. */
export const MAIN_PANE_MIN_WIDTH = 560;
export const MAIN_PANE_REOPEN_TARGET_WIDTH = MAIN_PANE_MIN_WIDTH + 10;
/**
 * The regular panel minimum is a presentation affordance. The sidebar reopen
 * path may temporarily spend the whole right column to preserve MainChat, so
 * a positive compact width must remain representable in persisted state.
 */
export const WORK_PANEL_COMPACT_MIN_WIDTH = 1;

export type WorkPanelChatResizeGesture = {
  startClientX: number;
  startWidth: number;
};

/** The upper bound is supplied by the live layout budget, not a pixel cap. */
export function workPanelWidthLimits(min = WORK_PANEL_MIN_WIDTH) {
  return {
    min: Math.max(WORK_PANEL_COMPACT_MIN_WIDTH, Math.round(min)),
  };
}

export function clampWorkPanelWidth(
  width: number,
  min = WORK_PANEL_MIN_WIDTH,
) {
  return Math.max(workPanelWidthLimits(min).min, width);
}

/**
 * Live bounds for a manual panel width: the compact minimum replaces the
 * regular minimum while the panel is below it, and the shared three-column
 * budget caps the growth. Pointer, keyboard, and reset paths share it so a
 * reset can never breach the MainChat floor.
 */
export function workPanelWidthBounds(
  panelMinimum = WORK_PANEL_MIN_WIDTH,
  maxPanelWidth: number,
) {
  const minimum = Math.min(panelMinimum, maxPanelWidth);
  return { minimum, maximum: Math.max(minimum, maxPanelWidth) };
}

/**
 * Double-click reset for the panel separator: the default width, clamped to
 * the live bounds, so a window narrower than the default keeps its budget cap.
 */
export function workPanelResetWidth(
  panelMinimum = WORK_PANEL_MIN_WIDTH,
  maxPanelWidth: number,
) {
  const { minimum, maximum } = workPanelWidthBounds(panelMinimum, maxPanelWidth);
  const target = Math.min(Math.max(WORK_PANEL_DEFAULT_WIDTH, minimum), maximum);
  return clampWorkPanelWidth(target, minimum);
}

export type WorkPanelLayout = {
  mainWidth: number;
  panelWidth: number;
  maxPanelWidth: number;
  shouldCollapseSidebar: boolean;
};

/** Keep the reading pane usable and the regular panel within 40% of the window. */
export function workPanelLayout({
  containerWidth,
  sidebarWidth,
  sidebarCollapsed,
  requestedPanelWidth,
  maximized = false,
}: {
  containerWidth: number;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  requestedPanelWidth: number;
  maximized?: boolean;
}): WorkPanelLayout {
  const width = Math.max(0, Math.round(containerWidth));
  const leftWidth = sidebarCollapsed ? 0 : Math.max(0, Math.round(sidebarWidth));
  // Maximized preview: MainChat is not rendered at all, so the panel takes the
  // whole client area beside the sidebar and the MainChat floor does not apply.
  if (maximized) {
    const fullWidth = Math.max(0, width - leftWidth);
    return {
      mainWidth: 0,
      panelWidth: fullWidth,
      maxPanelWidth: fullWidth,
      shouldCollapseSidebar: false,
    };
  }
  const requested = clampWorkPanelWidth(
    requestedPanelWidth,
    requestedPanelWidth < WORK_PANEL_MIN_WIDTH
      ? WORK_PANEL_COMPACT_MIN_WIDTH
      : WORK_PANEL_MIN_WIDTH,
  );
  const maxPanelWidth = Math.max(
    0,
    Math.min(width * .4, width - leftWidth - MAIN_PANE_MIN_WIDTH),
  );
  const panelWidth = Math.min(requested, maxPanelWidth);
  return {
    mainWidth: Math.max(0, width - leftWidth - panelWidth),
    panelWidth,
    maxPanelWidth,
    shouldCollapseSidebar:
      !sidebarCollapsed &&
      width - leftWidth - Math.min(requested, width * .4) < MAIN_PANE_MIN_WIDTH,
  };
}

/**
 * Computes the right-column width used while manually reopening the sidebar.
 * The right column gives up its space first, preserving the current MainChat
 * width when possible, otherwise preserving the reading pane reservation.
 */
export function workPanelWidthForSidebarReopen({
  containerWidth,
  sidebarWidth,
  currentPanelWidth,
}: {
  containerWidth: number;
  sidebarWidth: number;
  currentPanelWidth: number;
}) {
  const width = Math.max(0, Math.round(containerWidth));
  const leftWidth = Math.max(0, Math.round(sidebarWidth));
  const panelWidth = clampWorkPanelWidth(
    currentPanelWidth,
    currentPanelWidth < WORK_PANEL_MIN_WIDTH
      ? WORK_PANEL_COMPACT_MIN_WIDTH
      : WORK_PANEL_MIN_WIDTH,
  );
  const remainingAfterSidebar = width - leftWidth;
  const preservedMainWidth = remainingAfterSidebar - panelWidth;
  const targetMainWidth =
    preservedMainWidth >= MAIN_PANE_MIN_WIDTH
      ? preservedMainWidth
      : MAIN_PANE_REOPEN_TARGET_WIDTH;
  return Math.max(
    WORK_PANEL_COMPACT_MIN_WIDTH,
    Math.min(panelWidth, width * .4, remainingAfterSidebar - targetMainWidth),
  );
}

export function clampWorkPanelChatWidth(width: number) {
  return Math.max(
    WORK_PANEL_CHAT_MIN_WIDTH,
    Math.min(WORK_PANEL_CHAT_MAX_WIDTH, Math.round(width)),
  );
}

export function workPanelChatWidthFromPointer(
  gesture: WorkPanelChatResizeGesture,
  clientX: number,
) {
  return clampWorkPanelChatWidth(
    gesture.startWidth + clientX - gesture.startClientX,
  );
}

export function parseWorkPanelChatWidth(input: unknown): number | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const width = (input as { width?: unknown }).width;
  if (
    typeof width !== "number" ||
    !Number.isSafeInteger(width) ||
    width < WORK_PANEL_CHAT_MIN_WIDTH ||
    width > WORK_PANEL_CHAT_MAX_WIDTH
  ) {
    return null;
  }
  return width;
}

export function committedWorkPanelChatWidth(
  gesture: WorkPanelChatResizeGesture,
  previewWidth: number,
  commit: boolean,
) {
  if (!commit || previewWidth === gesture.startWidth) return null;
  return previewWidth;
}
