// sensor.js — external (CSP-friendly) hover handler for the invisible sensor strip.
// Kept out of sensor.html so a strict script-src 'self' policy doesn't block it.
const sensor = document.getElementById('sensor');
sensor.addEventListener('mouseenter', () => {
  // Tauri's internal IPC bridge is injected automatically into every webview.
  if (window.__TAURI_INTERNALS__) {
    window.__TAURI_INTERNALS__.invoke('sensor_hover');
  }
});
