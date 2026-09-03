import './styles.css';
import { QuietRoomApp } from './app';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Application root is missing');

const app = new QuietRoomApp(root);
void app.start();

if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // The app remains usable online if service-worker registration is unavailable.
    });
  });
}
