import type { CallIceConfiguration, CallIceRoute } from './call-types';
import { NetworkOperationError } from './network-operation';
const invalid = (): never => { throw new NetworkOperationError('CALL_CONFIG_INVALID', '通话网络配置无效'); };

export function parseIceUrl(value: unknown): CallIceRoute {
  if (typeof value !== 'string' || value.length > 512) return invalid();
  const match = /^(stun|stuns|turn|turns):((?:\[[0-9a-fA-F:]+\])|(?:[a-zA-Z0-9.-]+))(?::([0-9]{1,5}))?(?:\?transport=(udp|tcp))?$/.exec(value);
  if (!match) return invalid();
  const [, scheme, rawHost, rawPort, transport] = match;
  const host = rawHost!.toLowerCase();
  const turn = scheme!.startsWith('turn');
  if ((!turn && transport) || (scheme === 'turns' && transport === 'udp')) return invalid();
  if (host.startsWith('[')) {
    try { new URL(`https://${host}/`); } catch { return invalid(); }
  } else if (host.length > 253 || !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      (/^[0-9.]+$/.test(host) && (host.split('.').length !== 4 || host.split('.').some(part => Number(part) > 255 || String(Number(part)) !== part)))) return invalid();
  const port = rawPort ? Number(rawPort) : scheme!.endsWith('s') ? 5349 : 3478;
  if (port < 1 || port > 65535) return invalid();
  const protocol = scheme!.endsWith('s') ? 'tls' : transport ?? 'udp';
  return { url: `${scheme}:${host}:${port}${turn ? `?transport=${protocol === 'tls' ? 'tcp' : protocol}` : ''}`, kind: turn ? 'turn' : 'stun', protocol: protocol as CallIceRoute['protocol'] };
}

/** A server-supplied verifiedPeerIds field is deliberately discarded. */
export function validateCallConfiguration(raw: unknown, now = Date.now()): CallIceConfiguration {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid();
  const data = raw as Record<string, unknown>;
  if (!Array.isArray(data.iceServers) || data.iceServers.length > 16 || !['all', 'relay'].includes(String(data.iceTransportPolicy)) || typeof data.relayConfigured !== 'boolean') return invalid();
  const seen = new Set<string>();
  const routes: CallIceRoute[] = [];
  const iceServers: RTCIceServer[] = [];
  for (const entry of data.iceServers) {
    if (!entry || typeof entry !== 'object') return invalid();
    const server = entry as Record<string, unknown>;
    const values = typeof server.urls === 'string' ? [server.urls] : server.urls;
    if (!Array.isArray(values) || !values.length || values.length > 16) return invalid();
    const urls: string[] = [];
    let turn = false;
    for (const value of values) {
      const route = parseIceUrl(value);
      turn ||= route.kind === 'turn';
      if (!seen.has(route.url)) { seen.add(route.url); urls.push(route.url); routes.push(route); }
    }
    if (seen.size > 32) return invalid();
    if (turn && (typeof server.username !== 'string' || !server.username || server.username.length > 512 || typeof server.credential !== 'string' || !server.credential || server.credential.length > 1024)) return invalid();
    if (urls.length) iceServers.push({ urls, ...(turn ? { username: server.username as string, credential: server.credential as string } : {}) });
  }
  const hasTurn = routes.some(route => route.kind === 'turn');
  if (data.relayConfigured !== hasTurn || (data.iceTransportPolicy === 'relay' && !hasTurn)) return invalid();
  if (hasTurn && (!Number.isSafeInteger(data.expiresAt) || Number(data.expiresAt) <= now + 30_000 || Number(data.expiresAt) > now + 24 * 60 * 60_000)) return invalid();
  if (data.iceRoutes !== undefined) {
    if (!Array.isArray(data.iceRoutes) || data.iceRoutes.length > 32) return invalid();
    for (const entry of data.iceRoutes) {
      if (!entry || typeof entry !== 'object') return invalid();
      const route = routes.find(item => item.url === parseIceUrl(entry.url).url);
      if (!route || (entry.region !== undefined && (typeof entry.region !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(entry.region)))) return invalid();
      if (entry.region) route.region = entry.region;
    }
  }
  return { iceServers, iceTransportPolicy: data.iceTransportPolicy as RTCIceTransportPolicy, relayConfigured: hasTurn,
    ...(hasTurn ? { expiresAt: Number(data.expiresAt) } : {}), iceRoutes: routes, callIdentities: data.callIdentities };
}
