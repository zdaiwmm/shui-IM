import { vi } from 'vitest';
import * as capacity from '../../scripts/backup-capacity.mjs';

const GiB = 1024 ** 3;
export const availableBackupSpace = Object.freeze({
  bsize: 1, blocks: 128 * GiB, bfree: 64 * GiB, bavail: 64 * GiB,
  files: 1000, ffree: 900,
});

// These fixtures exercise real files, SQLite, hashes and stream publication.
// Fix only their disk-admission precondition; run the real policy on every call.
// Production code and its default statfs probe have no test bypass or new option.
export function useAvailableBackupSpace() {
  return vi.spyOn(capacity, 'checkBackupCapacity').mockImplementation(async (_root, options) => {
    capacity.assertBackupCapacity(availableBackupSpace, options);
  });
}
