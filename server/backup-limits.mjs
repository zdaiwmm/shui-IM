// SQLite includes ciphertext archives as well as message and recovery indexes.
// Keep disk/stream bounds distinct from per-attachment and process-memory bounds.
export const MAX_BACKUP_DATABASE_BYTES = 20 * 1024 ** 3;
export const MAX_BACKUP_TOTAL_BYTES = 32 * 1024 ** 3;
export const backupFileLimit = name => name === 'quiet-room.sqlite' ? MAX_BACKUP_DATABASE_BYTES : 256 * 1024 ** 2;
