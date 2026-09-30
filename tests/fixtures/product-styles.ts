/** Same cascade as src/main.ts, without booting or replacing the fixture app. */
export async function loadProductStyles(): Promise<void> {
  for (const name of ['styles', 'chat-layout', 'gallery', 'auth-recovery', 'chat-interactions', 'cover', 'voice-messages', 'call', 'motion', 'desktop', 'experience']) await import(/* @vite-ignore */ `/src/${name}.css`);
}
