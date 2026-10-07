const formatters = new Map<string, Intl.NumberFormat>();
export function formatCurrency(value: number, locale = 'en-US'): string {
  let formatter = formatters.get(locale);
  if (!formatter) { formatter = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', useGrouping: true, minimumFractionDigits: 2, maximumFractionDigits: 2 }); formatters.set(locale, formatter); }
  return value > 0 && value < 0.01 ? `<${formatter.format(0.01)}` : formatter.format(value);
}
