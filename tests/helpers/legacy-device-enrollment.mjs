// The product no longer exposes legacy device enrollment in Settings.
// Keep old encrypted device/repair protocol regressions reachable in fixtures.
export async function captureLegacyDeviceManager(page) {
  await page.evaluate(async () => {
    const { QuietRoomApp } = await import('/src/app.ts');
    const render = QuietRoomApp.prototype.renderDeviceManager;
    QuietRoomApp.prototype.renderDeviceManager = function (...args) {
      window.legacyDeviceTestApp = this;
      return render.apply(this, args);
    };
  });
}

export async function requestLegacyDeviceLink(page) {
  await page.evaluate(async () => {
    const button = document.createElement('button');
    button.hidden = true;
    document.querySelector('#app').append(button);
    try { await (window.legacyDeviceTestApp ?? window.app).startDeviceLink(button); }
    finally { button.remove(); }
  });
}
