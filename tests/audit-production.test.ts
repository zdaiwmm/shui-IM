import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error Operational Node script has no TS declarations.
import { auditProduction, classifyAuditResult } from '../scripts/audit-production.mjs';

type AuditResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
  signal?: string | null;
};

function report(counts: Record<string, number> = {}, vulnerabilities: Record<string, unknown> = {}) {
  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0, ...counts },
    },
  };
}

function result(body: unknown, status = 0, stderr = ''): AuditResult {
  return { status, stdout: JSON.stringify(body), stderr };
}

function unavailable(code = 'ETIMEDOUT'): AuditResult {
  return result({ error: { code, summary: 'The audit service request failed.' } }, 1);
}

describe('production audit classification', () => {
  it('accepts a complete v2 report with no high or critical vulnerabilities', () => {
    for (const body of [report(), report({ low: 1, moderate: 1, total: 2 }, {
      'example-low': { severity: 'low' },
      'example-moderate': { severity: 'moderate' },
    })]) {
      expect(classifyAuditResult(result(body))).toEqual({ kind: 'passed', report: body });
    }
  });

  it('fails closed when an apparently successful command did not return a valid report', () => {
    for (const stdout of ['', 'found 0 vulnerabilities', '<html>Service unavailable</html>', '{']) {
      expect(classifyAuditResult({ status: 0, stdout, stderr: '' }).kind).toBe('invalid');
    }
    for (const body of [null, [], {}, { auditReportVersion: 2 }, { ...report(), vulnerabilities: [] },
      { ...report(), vulnerabilities: null }, { ...report(), metadata: {} },
      { ...report(), auditReportVersion: 1 }, { error: { code: 'ETIMEDOUT' } }]) {
      expect(classifyAuditResult(result(body)).kind).toBe('invalid');
    }
  });

  it('requires all severity counts to be present and non-negative integers', () => {
    const keys = ['info', 'low', 'moderate', 'high', 'critical', 'total'] as const;
    for (const key of keys) {
      for (const value of [undefined, null, -1, 0.5, '0']) {
        const body = report();
        Object.assign(body.metadata.vulnerabilities, { [key]: value });
        expect(classifyAuditResult(result(body)).kind).toBe('invalid');
      }
    }
  });

  it('blocks high and critical findings even if npm exits successfully or also logs a timeout', () => {
    for (const severity of ['high', 'critical']) {
      const body = report({ [severity]: 1, total: 1 }, { example: { severity } });
      for (const status of [0, 1]) {
        expect(classifyAuditResult(result(body, status, 'npm error code ETIMEDOUT')).kind).toBe('vulnerable');
      }
    }
  });

  it('never accepts high-severity entries concealed by zero aggregate counts', () => {
    for (const severity of ['high', 'critical']) {
      const classification = classifyAuditResult(result(report({}, { example: { severity } })));
      expect(['vulnerable', 'invalid']).toContain(classification.kind);
    }
  });

  it('does not accept or retry a nonzero exit with an otherwise clean complete report', () => {
    expect(classifyAuditResult(result(report(), 1)).kind).toBe('invalid');
    expect(classifyAuditResult(result(report(), 1, 'npm error code ETIMEDOUT')).kind).toBe('invalid');
  });

  it('recognizes explicit temporary network errors in npm JSON failures', () => {
    for (const code of ['FETCH_ERROR', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN',
      'ENOTFOUND', 'E503', 'E502', 'E504', 'E429']) {
      expect(classifyAuditResult(unavailable(code)).kind).toBe('unavailable');
    }
  });

  it('does not infer an audit-service failure from stderr without structured npm evidence', () => {
    expect(classifyAuditResult({
      status: 1,
      stdout: '',
      stderr: 'npm error code ETIMEDOUT\nnpm error network request to https://registry.npmjs.org/-/npm/v1/security/audits/quick failed',
    }).kind).toBe('invalid');
  });

  it('recognizes the official npm audit failure shape even when npm drops the error code', () => {
    const uri = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';
    expect(classifyAuditResult(result({ message: `network timeout at: ${uri}` }, 1)).kind).toBe('unavailable');
    for (const method of [undefined, 'POST']) {
      expect(classifyAuditResult(result({ uri, method, message: `network timeout at: ${uri}` }, 1)).kind).toBe('unavailable');
    }
    for (const statusCode of [408, 429, 500, 502, 503, 504]) {
      expect(classifyAuditResult(result({ uri, method: 'POST', statusCode, message: 'Audit service unavailable.' }, 1)).kind).toBe('unavailable');
    }
  });

  it('rejects authentication failures and timeout text for unrelated registry requests', () => {
    const uri = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';
    for (const statusCode of [401, 403]) {
      expect(classifyAuditResult(result({ uri, statusCode, message: 'Unauthorized' }, 1)).kind).toBe('invalid');
    }
    for (const otherUri of ['https://example.com/-/npm/v1/security/advisories/bulk',
      'https://registry.npmjs.org/example-package', `${uri}/unexpected`]) {
      expect(classifyAuditResult(result({ uri: otherUri, message: `network timeout at: ${otherUri}` }, 1)).kind).toBe('invalid');
    }
  });

  it('recognizes npm 11 message-only DNS and connection failures without retrying TLS errors', () => {
    const uri = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';
    for (const reason of ['read ECONNRESET', 'connect ETIMEDOUT', 'getaddrinfo EAI_AGAIN registry.npmjs.org']) {
      expect(classifyAuditResult(result({ message: `request to ${uri} failed, reason: ${reason}` }, 1)).kind).toBe('unavailable');
    }
    for (const message of [`request to ${uri} failed, reason: certificate has expired`,
      `request to ${uri}/unexpected failed, reason: read ECONNRESET`]) {
      expect(classifyAuditResult(result({ message }, 1)).kind).toBe('invalid');
    }
  });

  it('does not turn unknown failures, authentication errors, or unrelated timeout text into retryable success paths', () => {
    for (const code of ['E401', 'E403', 'EAUDITNOLOCK', 'EUSAGE', 'UNKNOWN']) {
      expect(classifyAuditResult(unavailable(code)).kind).toBe('invalid');
    }
    expect(classifyAuditResult({ status: 1, stdout: '', stderr: 'something timed out' }).kind).toBe('invalid');
  });

  it('fails closed on signals and spawn errors, including when stdout looks clean', () => {
    for (const change of [
      { status: null, signal: 'SIGTERM' },
      { status: 0, signal: 'SIGTERM' },
      { status: null, error: Object.assign(new Error('spawn failed'), { code: 'ETIMEDOUT' }) },
      { status: 0, error: new Error('spawn failed') },
    ]) {
      expect(classifyAuditResult({ ...result(report()), ...change }).kind).toBe('invalid');
    }
  });
});

describe('production audit retry policy', () => {
  it('returns the verified report without waiting when the first attempt passes', async () => {
    const body = report();
    const run = vi.fn(() => result(body));
    const wait = vi.fn(async () => {});
    await expect(auditProduction({ run, wait, log: vi.fn() })).resolves.toEqual(body);
    expect(run).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it('waits five seconds after a network failure and verifies the next response before returning', async () => {
    const body = report();
    const events: string[] = [];
    const responses = [unavailable(), result(body)];
    const run = vi.fn(() => { events.push('audit'); return responses.shift()!; });
    const wait = vi.fn(async (ms: number) => { events.push(`wait:${ms}`); });
    await expect(auditProduction({ run, wait, log: vi.fn() })).resolves.toEqual(body);
    expect(events).toEqual(['audit', 'wait:5000', 'audit']);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('fails after three unavailable responses without sleeping after the final attempt', async () => {
    const run = vi.fn(() => unavailable());
    const wait = vi.fn(async () => {});
    await expect(auditProduction({ run, wait, log: vi.fn() })).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[5000], [5000]]);
  });

  it('honors an explicitly shorter attempt budget', async () => {
    const run = vi.fn(() => unavailable());
    const wait = vi.fn(async () => {});
    await expect(auditProduction({ run, wait, log: vi.fn(), maxAttempts: 1 })).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it('cannot disable the audit or expand its bounded retry budget through invalid attempt limits', async () => {
    for (const maxAttempts of [0, -1, 1.5, 4, Number.POSITIVE_INFINITY]) {
      const run = vi.fn(() => result(report()));
      await expect(auditProduction({ run, wait: vi.fn(), log: vi.fn(), maxAttempts })).rejects.toThrow();
      expect(run).not.toHaveBeenCalled();
    }
  });

  it('rejects findings and invalid output immediately without trying a later clean response', async () => {
    const blocked = [
      result(report({ high: 1, total: 1 }, { example: { severity: 'high' } }), 1),
      result(report({ critical: 1, total: 1 }, { example: { severity: 'critical' } })),
      result({}),
      { status: 0, stdout: 'not JSON', stderr: '' },
      { ...result(report()), status: null, signal: 'SIGTERM' },
      unavailable('E403'),
    ];
    for (const first of blocked) {
      const run = vi.fn().mockReturnValueOnce(first).mockReturnValue(result(report()));
      const wait = vi.fn(async () => {});
      await expect(auditProduction({ run, wait, log: vi.fn() })).rejects.toThrow();
      expect(run).toHaveBeenCalledTimes(1);
      expect(wait).not.toHaveBeenCalled();
    }
  });

  it('stops retrying if a later response contains a vulnerability or an invalid report', async () => {
    for (const next of [
      result(report({ high: 1, total: 1 }, { example: { severity: 'high' } }), 1),
      result({}),
    ]) {
      const run = vi.fn()
        .mockReturnValueOnce(unavailable())
        .mockReturnValueOnce(next)
        .mockReturnValue(result(report()));
      const wait = vi.fn(async () => {});
      await expect(auditProduction({ run, wait, log: vi.fn() })).rejects.toThrow();
      expect(run).toHaveBeenCalledTimes(2);
      expect(wait.mock.calls).toEqual([[5000]]);
    }
  });
});
