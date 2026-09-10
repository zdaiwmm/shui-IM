import { describe, expect, it } from 'vitest';
import { createCallDiagnostics, recordCallPath, transitionCallStage } from '../src/lib/call-connection';

describe('call connection diagnostics', () => {
  it('keeps stages and errors independent and redacted', () => {
    let s = createCallDiagnostics({ callIdHash: 'hash', kind: 'audio', role: 'caller' }, 10);
    s = transitionCallStage(s, 'ice-checking', 20, { code: 'timeout' });
    s = recordCallPath(s, { type: 'relay', protocol: 'tcp' });
    expect(s).toMatchObject({ stage: 'ice-checking', failureStage: 'ice-checking', errorCode: 'ice-checking:timeout', candidateType: 'relay', candidateProtocol: 'tcp', relay: true });
    expect(JSON.stringify(s)).not.toMatch(/sdp|candidate:/i);
  });
});
