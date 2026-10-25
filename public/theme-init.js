// Apply the saved theme before the first paint. Keep this in step with src/client/theme.ts.
// It is a file, not an inline script, so the server's `script-src 'self'` policy lets it run.
// index.html loads it with a plain <script src> in <head>: no module, async or defer, so it
// blocks rendering until the theme is set.
(function () {
  try {
    var saved = localStorage.getItem('fulldots-theme');
    var dark =
      saved === 'dark' ||
      (saved !== 'light' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);
    var theme = dark ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#14171b' : '#f8f7f4');
  } catch (error) {
    /* localStorage can be blocked; the light theme still renders. */
  }
})();
