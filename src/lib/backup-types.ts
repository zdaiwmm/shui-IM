import type { Vault } from './types';

export type SealedBackup = { iv: string; ciphertext: string };
export type ArchivePart = { id: string; digest: string; firstSeq: number; lastSeq: number; count: number };
export type HistoryArchive = { id: string; key: string; token: string; parts: ArchivePart[] };
export type CloudRecoveryBundle = {
  v: 1;
  backupId: string;
  roomId: string;
  deviceId: string;
  checkpoint: Vault;
  archives: HistoryArchive[];
};
export type BackupUpload = {
  id: string;
  revision: number;
  fetchToken: string;
  sealed: SealedBackup;
  archives: { id: string; token: string; writable: boolean }[];
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
  newCodePending?: boolean;
  replaces?: string;
  pending?: BackupUpload;
  pendingPart?: { archiveId: string; part: ArchivePart; sealed: SealedBackup };
};

export type RecoverySource = { backupId: string; archives: HistoryArchive[] };
