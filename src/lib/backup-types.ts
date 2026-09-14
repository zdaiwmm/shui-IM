import type { GalleryCurationRecord } from './gallery-curation';
import type { Vault } from './types';

export type SealedBackup = { iv: string; ciphertext: string };
export type ArchivePart = {
  id: string;
  digest: string;
  firstSeq: number;
  lastSeq: number;
  count: number;
  /** Encrypted metadata used only for backup inventory in the admin console. */
  chatCount?: number;
  galleryCount?: number;
};
export type HistoryArchive = {
  id: string;
  key: string;
  token: string;
  parts: ArchivePart[];
  chatCount?: number;
  galleryCount?: number;
};
export type CloudRecoveryBundle = {
  v: 1;
  backupId: string;
  roomId: string;
  deviceId: string;
  checkpoint: Vault;
  /** Only Safe deletion projections; never drafts, pins or favorites. */
  galleryHidden?: GalleryCurationRecord[];
  archives: HistoryArchive[];
};
export type BackupUpload = {
  id: string;
  revision: number;
  fetchToken: string;
  sealed: SealedBackup;
  archives: { id: string; token: string; writable: boolean; chatCount?: number; galleryCount?: number }[];
  replaces?: string;
};
export type LocalBackupState = {
  v: 1;
  id: string;
  code: string;
  archives: HistoryArchive[];
  cursor: number;
  revision: number;
  syncedAt?: string;
  /** First foreground observation of an incomplete automatic history batch. */
  historyBatchStartedAt?: number;
  galleryHidden?: GalleryCurationRecord[];
  newCodePending?: boolean;
  replaces?: string;
  pending?: BackupUpload;
  pendingPart?: { archiveId: string; part: ArchivePart; sealed: SealedBackup };
};

export type RecoverySource = { backupId: string; archives: HistoryArchive[]; galleryHidden?: GalleryCurationRecord[] };
