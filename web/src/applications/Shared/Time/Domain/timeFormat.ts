// A list formats thousands of dates and durations: one Intl formatter per (language, options) is
// built once and reused, as numberFormat does for figures.
const cached = <Formatter>(build: (languageTag: string, options: object) => Formatter) => {
  const formatters = new Map<string, Formatter>();
  return (languageTag: string, options: object): Formatter => {
    const key = `${languageTag}|${JSON.stringify(options)}`;
    const existing = formatters.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const formatter = build(languageTag, options);
    formatters.set(key, formatter);
    return formatter;
  };
};

export const dateTimeFormat: (
  languageTag: string,
  options: Intl.DateTimeFormatOptions,
) => Intl.DateTimeFormat = cached(
  (languageTag, options) => new Intl.DateTimeFormat(languageTag, options),
);

export const relativeTimeFormat: (
  languageTag: string,
  options: Intl.RelativeTimeFormatOptions,
) => Intl.RelativeTimeFormat = cached(
  (languageTag, options) => new Intl.RelativeTimeFormat(languageTag, options),
);

export const durationFormat: (
  languageTag: string,
  options: Intl.DurationFormatOptions,
) => Intl.DurationFormat = cached(
  (languageTag, options) => new Intl.DurationFormat(languageTag, options),
);
