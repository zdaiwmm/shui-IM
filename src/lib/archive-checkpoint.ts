import type { ArchiveObject } from './room-archive-crypto';

/** The reference is authenticated inside the vault. The object is encrypted
 * separately, under the local master key and this immutable vault slot. */
export type ArchiveCheckpointRef = { v: 1; id: string; hash: string };
export type ArchiveCheckpoint = ArchiveObject | ArchiveCheckpointRef;

export function isArchiveCheckpointRef(value: ArchiveCheckpoint): value is ArchiveCheckpointRef {
  return value.v === 1;
}
