const formats = new Map<string, Intl.NumberFormat>();
export function numberFormat(locale: string): Intl.NumberFormat {
  let format = formats.get(locale);
  if (!format) { format = new Intl.NumberFormat(locale); formats.set(locale, format); }
  return format;
}
export const compactNumberFormat = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
