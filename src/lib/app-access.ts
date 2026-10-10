type InstallPrompt = Event & { prompt(): Promise<{ outcome: 'accepted' | 'dismissed' }>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };
type RelatedNavigator = Navigator & { getInstalledRelatedApps?: () => Promise<Array<{ platform: string; id?: string; url?: string }>> };
export type AppAccessState = 'standalone' | 'installable' | 'installed' | 'guidance';

/** Installation evidence stays in this page; a stored flag cannot prove an app exists. */
export class AppAccess {
  private prompt: InstallPrompt | null = null;
  private installed = false;
  private listeners = new Set<() => void>();
  constructor() {
    window.addEventListener('beforeinstallprompt', event => {
      event.preventDefault(); this.prompt = event as InstallPrompt; this.changed();
    });
    window.addEventListener('appinstalled', () => { this.installed = true; this.prompt = null; this.changed(); });
    matchMedia('(display-mode: standalone), (display-mode: window-controls-overlay), (display-mode: minimal-ui)')
      .addEventListener('change', () => this.changed());
    void this.detectInstalled();
  }
  private async detectInstalled(): Promise<void> {
    try {
      const apps = await (navigator as RelatedNavigator).getInstalledRelatedApps?.();
      const manifest = new URL('/manifest.webmanifest', location.origin).href;
      this.installed ||= Boolean(apps?.some(app => app.platform === 'webapp' && app.url === manifest));
      this.changed();
    } catch { /* Browser installation UI remains available without this optional API. */ }
  }
  get state(): AppAccessState {
    if (matchMedia('(display-mode: standalone), (display-mode: window-controls-overlay), (display-mode: minimal-ui)').matches) return 'standalone';
    return this.installed ? 'installed' : this.prompt ? 'installable' : 'guidance';
  }
  subscribe(listener: () => void, signal: AbortSignal): void {
    if (signal.aborted) return;
    this.listeners.add(listener);
    signal.addEventListener('abort', () => this.listeners.delete(listener), { once: true });
  }
  private changed(): void { for (const listener of this.listeners) listener(); }
  async install(): Promise<boolean> {
    const prompt = this.prompt;
    if (!prompt) return false;
    this.prompt = null; this.changed();
    try { const result = await prompt.prompt(); return (result ?? await prompt.userChoice).outcome === 'accepted'; }
    finally { this.changed(); }
  }
}
