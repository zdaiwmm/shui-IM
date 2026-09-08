import './styles.css';
import './chat-layout.css';
import './gallery.css';
import './auth-recovery.css';
import './chat-interactions.css';
import './cover.css';
import './voice-messages.css';
import './call.css';
import { QuietRoomApp } from './app';
import { startReleaseUpdateDetection } from './lib/release-update';
import { mountSystemChrome } from './lib/system-chrome';

// Keep zooming inside purpose-built media viewers instead of allowing a
// double tap/click to scale the whole browser page. The viewport declaration
// and touch-action CSS provide the mobile path; this covers emitted dblclicks.
document.addEventListener('dblclick', (event) => {
  if (!(event.target instanceof Element && event.target.closest('.is-selecting-text, video'))) event.preventDefault();
}, {
  capture: true,
  passive: false,
});

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Application root is missing');
mountSystemChrome();

const app = new QuietRoomApp(root);
void app.start();

if ('serviceWorker' in navigator && window.isSecureContext && import.meta.env.PROD) {
  startReleaseUpdateDetection();
} else if ('serviceWorker' in navigator && import.meta.env.DEV) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.getRegistrations().then((registrations) =>
      Promise.all(registrations.map((registration) => registration.unregister()))
    ).then(() => caches.keys()).then((keys) => Promise.all(keys.map((key) => caches.delete(key)))).catch(() => {
      // Development must remain usable even when an old service worker cannot be removed.
    });
  });
}
