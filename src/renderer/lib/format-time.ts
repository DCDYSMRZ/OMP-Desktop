const formats = new Map<string, { exact: Intl.DateTimeFormat; time: Intl.DateTimeFormat; date: Intl.DateTimeFormat; year: Intl.DateTimeFormat }>();
export function timeFormats(language: string) {
  let value = formats.get(language);
  if (!value) {
    const clock = { hour: '2-digit', minute: '2-digit' } as const;
    value = { exact: new Intl.DateTimeFormat(language, { dateStyle: 'full', timeStyle: 'long' }), time: new Intl.DateTimeFormat(language, clock), date: new Intl.DateTimeFormat(language, { ...clock, month: 'short', day: 'numeric' }), year: new Intl.DateTimeFormat(language, { ...clock, month: 'short', day: 'numeric', year: 'numeric' }) };
    formats.set(language, value);
  }
  return value;
}
