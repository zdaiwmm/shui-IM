import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('preserves live directory identity and rejects unsafe archives, overwrites, rollback and premature retirement', () => {
  const result = spawnSync('python3', ['tests/storage-maintenance-boundaries.py', '-q'], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
});
