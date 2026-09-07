import { describe, expect, it } from 'vitest';
// @ts-expect-error Operational script has no declaration file.
import { lanEnvironment, parseLanArguments, validateLanCertificate } from '../scripts/dev-lan.mjs';

describe('LAN HTTPS development configuration', () => {
  it('normalizes a DNS hostname and provides ignored default certificate paths', () => {
    const options = parseLanArguments(['--host', 'Quiet-Room-Mac.local.']);
    expect(options.host).toBe('quiet-room-mac.local');
    expect(options.port).toBe(5173);
    expect(options.cert).toMatch(/\.keys\/lan\/quiet-room-mac\.local\.pem$/);
    expect(options.key).toMatch(/\.keys\/lan\/quiet-room-mac\.local-key\.pem$/);
  });

  it('supports explicit certificate paths and ports', () => {
    const options = parseLanArguments(['--host', 'quiet.test', '--cert', 'cert.pem', '--key', 'key.pem', '--port', '5443']);
    expect(options.port).toBe(5443);
    expect(options.cert).toMatch(/cert\.pem$/);
    expect(lanEnvironment(options, { FIXTURE: 'yes' })).toMatchObject({
      FIXTURE: 'yes', QUIET_ROOM_LAN_HOSTNAME: 'quiet.test', QUIET_ROOM_LAN_PORT: '5443',
    });
  });

  it.each(['localhost', '192.168.1.20', 'quietroom', '-bad.local', 'bad_.local'])(
    'rejects unsafe or invalid RP hostname %s', host => {
      expect(() => parseLanArguments(['--host', host])).toThrow('valid LAN hostname');
    },
  );

  it('rejects missing files before starting either server', () => {
    expect(() => validateLanCertificate({
      host: 'quiet.test', cert: '/definitely/missing/quiet-cert.pem', key: '/definitely/missing/quiet-key.pem',
    })).toThrow('Certificate not found');
  });

  it('rejects missing values, unknown options, and invalid ports', () => {
    expect(() => parseLanArguments(['--host'])).toThrow('requires a value');
    expect(() => parseLanArguments(['--host', 'quiet.test', '--unknown'])).toThrow('Unknown option');
    expect(() => parseLanArguments(['--host', 'quiet.test', '--port', '0'])).toThrow('integer');
  });
});
