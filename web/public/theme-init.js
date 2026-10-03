// A blocking classic script that runs before the first paint. Applying the theme from React instead
// would flash the light theme on every reload in dark mode. It is a separate file, not an inline
// script, because the server's Content-Security-Policy only allows scripts from the same origin.
(() => {
  const readStoredPreference = () => {
    try {
      return window.localStorage.getItem('binsight.theme');
    } catch {
      return null;
    }
  };

  const preference = readStoredPreference();
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = preference === 'dark' || (preference !== 'light' && prefersDark);
  const root = document.documentElement;
  root.classList.toggle('dark', isDark);
  root.dataset.theme = isDark ? 'dark' : 'light';
})();
