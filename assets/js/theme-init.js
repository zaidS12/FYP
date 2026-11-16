/* Runs synchronously in <head> so the saved theme is applied before first paint (no flash). */
(function () {
  var t = null;
  try { t = localStorage.getItem('af.theme'); } catch (e) { /* storage blocked */ }
  if (t !== 'light' && t !== 'dark') {
    t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', t);
})();
