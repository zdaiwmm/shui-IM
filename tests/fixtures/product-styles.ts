/** Same cascade as src/main.ts, without booting or replacing the fixture app. */
export async function loadProductStyles(): Promise<void> {
  for (const name of ['styles', 'chat-layout', 'gallery', 'auth-recovery', 'chat-interactions', 'cover', 'voice-messages', 'call']) await import(/* @vite-ignore */ `/src/${name}.css`);
  // App-owned styles precede the final motion, desktop and experience overrides.
  await import('/src/app');
  for (const name of ['motion', 'desktop', 'experience']) await import(/* @vite-ignore */ `/src/${name}.css`);
}
