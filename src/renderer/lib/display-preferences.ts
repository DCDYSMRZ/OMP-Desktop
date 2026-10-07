import { createContext, useContext } from 'react';
import type { DurationStyle } from './format-duration';

/** Renderer display choices backed by desktop preferences (defaults apply until preferences load). */
export interface DisplayPreferences {
  /** Assistant message footer (time · model · tokens · cost): always visible, or on hover/focus only. */
  messageMeta: 'always' | 'hover';
  /** Elapsed durations: promoted units (default) or unbounded mm:ss. */
  durationStyle: DurationStyle;
}

export const DEFAULT_DISPLAY_PREFERENCES: DisplayPreferences = { messageMeta: 'always', durationStyle: 'units' };

export const DisplayPreferencesContext = createContext<DisplayPreferences>(DEFAULT_DISPLAY_PREFERENCES);

export function useDisplayPreferences(): DisplayPreferences {
  return useContext(DisplayPreferencesContext);
}
