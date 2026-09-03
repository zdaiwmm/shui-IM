import './styles.css';
import { QuietRoomApp } from './app';

const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
const syncSystemChrome = () => {
  const theme = document.querySelector<HTMLMetaElement>('#system-chrome-color');
  if (theme) theme.content = colorScheme.matches ? '#292c34' : '#f4f6fa';
};
syncSystemChrome();
colorScheme.addEventListener('change', syncSystemChrome);

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Application root is missing');

const app = new QuietRoomApp(root);
void app.start();

if ('serviceWorker' in navigator && window.isSecureContext && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // The app remains usable online if service-worker registration is unavailable.
    });
  });
} else if ('serviceWorker' in navigator && import.meta.env.DEV) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.getRegistrations().then((registrations) =>
      Promise.all(registrations.map((registration) => registration.unregister()))
    ).then(() => caches.keys()).then((keys) => Promise.all(keys.map((key) => caches.delete(key)))).catch(() => {
      // Development must remain usable even when an old service worker cannot be removed.
    });
  });
}
