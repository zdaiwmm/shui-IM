// Only the Tokyo deployment supplies both public pixel installation values.
export function leadPixelConfig(env) {
  const connection = env.LEAD_PIXEL_CONNECTION;
  const key = env.LEAD_PIXEL_KEY;
  if (!connection && !key) return null;
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(connection ?? '')
    || !/^pixel-v1\.[a-f0-9]{64}$/.test(key ?? '')) {
    throw new Error('Invalid Lead pixel environment configuration');
  }
  return {
    collector: `https://shui.click/collect/${connection}`,
    bootstrap: `if (location.origin === 'https://mijiu.cloud' && !document.getElementById('mijiu-lead-pixel')) {
  window.leadq ||= function () {
    const args = arguments;
    const pending = new Promise((resolve, reject) => {
      (window.leadq.queue ||= []).push({ args, resolve, reject });
    });
    pending.catch(() => {});
    return pending;
  };

  const script = document.createElement('script');
  script.id = 'mijiu-lead-pixel';
  script.async = true;
  script.src = 'https://shui.click/lead.js';
  script.dataset.connection = ${JSON.stringify(connection)};
  script.dataset.key = ${JSON.stringify(key)};
  document.head.append(script);
}`,
  };
}
