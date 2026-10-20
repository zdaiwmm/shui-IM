// Same real product journey under a touch/mobile UA, DPR and viewport.
process.env.QR_MOBILE='1';
await import('./new-room-flows.e2e.mjs');
