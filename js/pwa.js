(function registerPWA() {
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', async () => {
    try {
      await navigator.serviceWorker.register('./sw.js?v=20260308-1');
      console.log('Service Worker registered');
    } catch (err) {
      console.error('Service Worker registration failed:', err);
    }
  });
})();
