const LAST_RELOAD_KEY = 'binsight.staleChunkReloadAt';
const MIN_RELOAD_INTERVAL_MS = 10_000;

// A chunk fails to load when the server was updated under an open tab: its old chunk names are
// gone. One reload fetches the new version. A second failure within the interval means the
// reload did not help: let the error reach the error screen instead of reloading in a loop.
export const shouldReloadForStaleChunk = (lastReloadAt: string | null, now: number): boolean => {
  const last = lastReloadAt === null ? Number.NaN : Number(lastReloadAt);
  return Number.isNaN(last) || now - last >= MIN_RELOAD_INTERVAL_MS;
};

const readLastReload = (): string | null => {
  try {
    return window.sessionStorage.getItem(LAST_RELOAD_KEY);
  } catch {
    return null;
  }
};

const recordReload = (now: number): void => {
  try {
    window.sessionStorage.setItem(LAST_RELOAD_KEY, String(now));
  } catch {
    // Without storage, the next failure cannot be told from this one: it reaches the error screen.
  }
};

export const registerStaleChunkReload = (): void => {
  window.addEventListener('vite:preloadError', (event) => {
    const now = Date.now();
    if (!shouldReloadForStaleChunk(readLastReload(), now)) {
      return;
    }
    event.preventDefault();
    recordReload(now);
    window.location.reload();
  });
};
