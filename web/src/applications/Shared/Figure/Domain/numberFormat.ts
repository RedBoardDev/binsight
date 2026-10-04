// Building an Intl.NumberFormat is costly and a list formats thousands of figures: one formatter
// per (language, options) is built once and reused. The set of options the app uses is small.
const formatters = new Map<string, Intl.NumberFormat>();

export const numberFormat = (
  languageTag: string,
  options: Intl.NumberFormatOptions,
): Intl.NumberFormat => {
  const key = `${languageTag}|${JSON.stringify(options)}`;
  const cached = formatters.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const formatter = new Intl.NumberFormat(languageTag, options);
  formatters.set(key, formatter);
  return formatter;
};
