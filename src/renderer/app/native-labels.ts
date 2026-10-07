type TranslateLabel = (key: string) => string;

// These are reserved action labels in omp's ask tool, not user-authored answers.
const OPTION_LABEL_KEYS: Record<string, string> = {
  'Other (type your own)': 'shell.askOther',
  'Chat about this': 'shell.askChat',
  'Next →': 'shell.askNext',
};

/** Display only: callers must submit the original option value. */
export function displayExtensionOption(option: string, t: TranslateLabel): string {
  return Object.hasOwn(OPTION_LABEL_KEYS, option) ? t(OPTION_LABEL_KEYS[option]) : option;
}
