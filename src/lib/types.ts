export type PublicBundle = {
  deviceId: string;
  encryptionKey: JsonWebKey;
  signingKey: JsonWebKey;
  mlsKeyPackage?: string;
};

export type RoomMember = PublicBundle & {
  role: 'creator' | 'joiner';
  joinProof: string | null;
  createdAt?: string;
};

export type PrivateIdentity = {
  publicBundle: PublicBundle;
  encryptionPrivateKey: JsonWebKey;
  signingPrivateKey: JsonWebKey;
  mlsPrivatePackage?: {
    initPrivateKey: string;
    hpkePrivateKey: string;
    signaturePrivateKey: string;
  };
};

export type MlsWelcomeEnvelope = {
  v: 1;
  protocol: 'mls-rfc9420';
  roomId: string;
  senderId: string;
  recipientId: string;
  welcome: string;
  signature: string;
};

export type MlsVaultState = {
  protocol: 'mls-rfc9420';
  phase: 'awaiting-peer' | 'awaiting-welcome' | 'active';
  groupState?: string;
  pendingWelcome?: MlsWelcomeEnvelope;
};

export type Vault = {
  v: 1 | 2;
  roomId: string;
  accessToken: string;
  role: 'creator' | 'joiner';
  pairingSecret: string;
  creatorFingerprint: string;
  identity: PrivateIdentity;
  members: RoomMember[];
  lastSeq: number;
  lastReceiptSeq?: number;
  pairingState?: 'joining' | 'ready';
  recoveryExportedAt?: string;
  historyUnavailableBeforeSeq?: number;
  createdAt: string;
  protocol?: 'legacy-v1' | 'mls-rfc9420';
  mls?: MlsVaultState;
};

export type VaultKdf = {
  name: 'argon2id';
  memorySize: number;
  iterations: number;
  parallelism: number;
  salt: string;
};

export type LegacyStoredVault = {
  v: 1;
  unlockMethod?: 'password' | 'gesture';
  kdf: VaultKdf;
  iv: string;
  ciphertext: string;
};

export type PlatformCredentialRecord = {
  credentialId: string;
  /** The RP ID used at registration. Optional only for pre-migration vaults. */
  rpId?: string;
  origin?: string;
  prfSalt: string;
  transports: AuthenticatorTransport[];
  authenticatorAttachment: AuthenticatorAttachment | null;
  backupEligible: boolean;
  createdAt: string;
};

export type StoredPlatformVault = {
  v: 2;
  unlockMethod: 'platform';
  kdf: VaultKdf;
  platform: PlatformCredentialRecord;
  wrappedKey: {
    iv: string;
    ciphertext: string;
  };
  payload: {
    iv: string;
    ciphertext: string;
  };
};

export type StoredRecoveryVault = {
  v: 2;
  unlockMethod: 'recovery';
  exportedAt: string;
  payload: StoredPlatformVault['payload'];
  recovery: {
    salt: string;
    iv: string;
    ciphertext: string;
  };
};

export type StoredVault = LegacyStoredVault | StoredPlatformVault | StoredRecoveryVault;

export type RecoveryExport = {
  exportedAt: string;
  recoveryCode: string;
};

export type TextPayload = {
  v: 1;
  kind: 'text';
  text: string;
  sentAt: string;
};

export type ImageManifest = {
  v: 1;
  blobId: string;
  key: string;
  ivPrefix: string;
  chunkSize: number;
  chunkCount: number;
  originalSize: number;
  originalName: string;
  mimeType: string;
  lastModified: number;
  sha256: string;
};

export type ImagePayload = {
  v: 1;
  kind: 'image';
  image: ImageManifest;
  sentAt: string;
};

export type GalleryImagePayload = {
  v: 1;
  kind: 'gallery-image';
  image: ImageManifest;
  sentAt: string;
};

export type MessagePayload = TextPayload | ImagePayload | GalleryImagePayload;

export type RecipientWrap = {
  deviceId: string;
  salt: string;
  iv: string;
  wrappedKey: string;
};

export type LegacyMessageEnvelope = {
  v: 1;
  roomId: string;
  clientMsgId: string;
  senderId: string;
  ephemeralPublicKey: JsonWebKey;
  content: {
    iv: string;
    ciphertext: string;
  };
  recipients: RecipientWrap[];
  signature: string;
};

export type MlsMessageEnvelope = {
  v: 2;
  protocol: 'mls-rfc9420';
  roomId: string;
  clientMsgId: string;
  senderId: string;
  ciphertext: string;
  signature: string;
};

export type MessageEnvelope = LegacyMessageEnvelope | MlsMessageEnvelope;

export type ServerMessage = {
  seq: number;
  envelope: MessageEnvelope;
  acceptedAt: string;
};

export type DecryptedMessage = {
  seq: number;
  clientMsgId: string;
  senderId: string;
  payload: MessagePayload;
  acceptedAt: string;
  status: 'sent' | 'pending' | 'stored' | 'delivered' | 'failed';
};

export type DeliveryReceipt = {
  v: 1;
  roomId: string;
  clientMsgId: string;
  seq: number;
  receiverId: string;
  receivedAt: string;
  signature: string;
};

export type ServerReceipt = {
  receiptSeq: number;
  receipt: DeliveryReceipt;
  acceptedAt: string;
};

export type OutboxItem = {
  clientMsgId: string;
  payload: MessagePayload;
  createdAt: string;
  envelope?: MessageEnvelope;
};

export type ImageUploadPlan = {
  v: 1;
  blobId: string;
  key: string;
  ivPrefix: string;
  chunkCount: number;
  encryptedSize: number;
  originalSize: number;
  originalName: string;
  mimeType: string;
  lastModified: number;
};

export type RoomState = {
  roomId: string;
  nextSeq: number;
  nextReceiptSeq?: number;
  sealedAt: string | null;
  protocol: 'legacy-v1' | 'mls-rfc9420';
  members: RoomMember[];
  mlsWelcome?: MlsWelcomeEnvelope | null;
};
