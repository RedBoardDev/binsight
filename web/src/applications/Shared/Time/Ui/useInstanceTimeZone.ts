// The time zone the instance counts its days in. It will come from the server's settings; until
// that endpoint exists, the browser's own zone stands in for it.
export const useInstanceTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;
