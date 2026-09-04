import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const endpoint = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';
const severities = ['info', 'low', 'moderate', 'high', 'critical'];
const transientCodes = new Set([
  'FETCH_ERROR', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN',
  'ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH', 'E408', 'E429', 'E500', 'E502', 'E503', 'E504',
]);
const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function classifyAuditResult(result) {
  if (result.error || result.signal || !Number.isInteger(result.status)) return { kind: 'invalid' };
  let report;
  try { report = JSON.parse(result.stdout); } catch { return { kind: 'invalid' }; }
  if (!record(report)) return { kind: 'invalid' };

  const counts = report.metadata?.vulnerabilities;
  const entries = record(report.vulnerabilities) ? Object.values(report.vulnerabilities) : [];
  // A vulnerability can never turn into an infrastructure retry, even if npm's
  // exit status or summary is inconsistent with its individual findings.
  if ((Number.isSafeInteger(counts?.high) && counts.high > 0) ||
      (Number.isSafeInteger(counts?.critical) && counts.critical > 0) ||
      entries.some(entry => entry?.severity === 'high' || entry?.severity === 'critical')) {
    return { kind: 'vulnerable', report };
  }
  if (report.auditReportVersion !== undefined) {
    const valid = report.auditReportVersion === 2 && !report.error && record(report.vulnerabilities) &&
      record(counts) && [...severities, 'total'].every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0) &&
      severities.reduce((sum, key) => sum + counts[key], 0) === counts.total &&
      entries.every(entry => record(entry) && severities.includes(entry.severity));
    return valid && result.status === 0 ? { kind: 'passed', report } : { kind: 'invalid' };
  }

  if (result.status === 0) return { kind: 'invalid' };
  // npm 11's audit-error output can omit error.code and uri on a timeout.
  // Match that exact official-endpoint message; never treat arbitrary stderr,
  // a malformed successful report, or an authentication error as success.
  const officialTimeout = report.message === `network timeout at: ${endpoint}`;
  const officialNetworkError = typeof report.message === 'string' &&
    report.message.startsWith(`request to ${endpoint} failed, reason: `) &&
    /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH)\b/.test(report.message);
  const officialHttpError = report.uri === endpoint && transientStatuses.has(report.statusCode) &&
    (report.method === undefined || report.method === 'POST');
  if (officialTimeout || officialNetworkError || officialHttpError || transientCodes.has(report.error?.code)) {
    return { kind: 'unavailable' };
  }
  return { kind: 'invalid' };
}

function runNpmAudit() {
  return spawnSync('npm', [
    'audit', '--omit=dev', '--audit-level=high', '--json',
    '--registry=https://registry.npmjs.org', '--fetch-timeout=30000', '--fetch-retries=0',
  ], { cwd: root, encoding: 'utf8', timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
}

export async function auditProduction({ run = runNpmAudit, wait = delay, log = console.log, maxAttempts = 3 } = {}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw new Error('Invalid audit attempt limit.');
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`Production dependency audit: attempt ${attempt}/${maxAttempts} (official npm registry).`);
    const result = classifyAuditResult(await run());
    if (result.kind === 'passed' || result.kind === 'vulnerable') log(JSON.stringify(result.report, null, 2));
    if (result.kind === 'passed') return result.report;
    if (result.kind === 'vulnerable') throw new Error('High or critical production dependency vulnerabilities found.');
    if (result.kind === 'invalid') throw new Error('npm audit failed without a valid report or a recognized transient service error.');
    if (attempt < maxAttempts) {
      log('Official audit service temporarily unavailable; retrying in 5 seconds.');
      await wait(5000);
    }
  }
  throw new Error('Official npm audit service unavailable after all attempts; release remains blocked.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  auditProduction().catch(error => { console.error(`AUDIT_BLOCKED: ${error.message}`); process.exitCode = 1; });
}
