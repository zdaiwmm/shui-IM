import type { LocalBackupState, RecoverySource } from './backup-types';

export type PublicBundle = {
  deviceId: string;
  encryptionKey: JsonWebKey;
  signingKey: JsonWebKey;
  mlsKeyPackage?: string;
};

export type RoomMember = PublicBundle & {
  role: 'creator' | 'joiner';
  joinProof: string | null;
  deviceName?: string;
  status?: 'pending' | 'active' | 'revoked';
  addedBy?: string | null;
  joinSeq?: number;
  joinReceiptSeq?: number;
  lastSeenAt?: string;
  revokedAt?: string | null;
  capabilities?: string[];
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

export type MlsMembershipEnvelope = {
  v: 1;
  protocol: 'mls-rfc9420';
  roomId: string;
  eventId: string;
  previousEventSeq: number;
  action: 'add' | 'remove' | 'replace';
  senderId: string;
  targetId: string;
  target?: RoomMember;
  replacedDeviceId?: string;
  recoveryRequest?: RecoveryRequest;
  commit: string;
  welcome?: string;
  signature: string;
};

export type RecoveryRequest = {
  v: 1;
  protocol: 'mls-rfc9420';
  roomId: string;
  requestId: string;
  sourceDeviceId: string;
  replacement: PublicBundle;
  tokenHash: string;
  expiresAt: string;
  signature: string;
};

export type ServerMlsMembershipEvent = {
  eventSeq: number;
  event: MlsMembershipEnvelope;
  acceptedAt: string;
};

export type MlsVaultState = {
  protocol: 'mls-rfc9420';
  phase: 'awaiting-peer' | 'awaiting-welcome' | 'active';
  groupState?: string;
  pendingWelcome?: MlsWelcomeEnvelope;
  lastEventSeq?: number;
  pendingMembership?: {
    event: MlsMembershipEnvelope;
    nextGroupState: string;
  };
};

export type PendingDeviceLink = {
  linkId: string;
  secret: string;
  expiresAt: string;
  createdAt: string;
};

export type Vault = {
  v: 1 | 2 | 3;
  roomId: string;
  accessToken: string;
  /** Initial one-time invitation credential. Removed after the second participant joins. */
  inviteToken?: string;
  role: 'creator' | 'joiner';
  pairingSecret: string;
  creatorFingerprint: string;
  identity: PrivateIdentity;
  members: RoomMember[];
  lastSeq: number;
  lastReceiptSeq?: number;
  pairingState?: 'joining' | 'linking' | 'recovering' | 'ready';
  pendingRecovery?: {
    request: RecoveryRequest;
    checkpointMembers: RoomMember[];
    checkpointEventSeq: number;
  };
  recoveryExportedAt?: string;
  /** Device-local secrets. Never include in a recovery checkpoint or API request. */
  backup?: LocalBackupState;
  /** Only carried through an explicitly decrypted device recovery. */
  recoverySource?: RecoverySource;
  historyUnavailableBeforeSeq?: number;
  createdAt: string;
  protocol?: 'legacy-v1' | 'mls-rfc9420';
  mls?: MlsVaultState;
  pendingDeviceLinks?: PendingDeviceLink[];
  pendingDeviceLinkId?: string;
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
  /** Version 2 combines a gesture with PRF output. Version 3 uses PRF only. */
  v: 2 | 3;
  unlockMethod: 'platform';
  kdf?: VaultKdf;
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
  v: 2 | 3;
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

export type ReplyReference = {
  clientMsgId: string;
  serverSeq: number;
  senderId: string;
  kind: 'text' | 'image' | 'audio' | 'file';
  preview: string;
};

export type TextPayload = {
  v: 1 | 2;
  kind: 'text';
  text: string;
  sentAt: string;
  replyTo?: ReplyReference;
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

/** Any local file uses the same encrypted, integrity-checked chunk transport. */
export type FileManifest = ImageManifest;

export type FilePayload = {
  v: 1 | 2;
  kind: 'file';
  file: FileManifest;
  sentAt: string;
  replyTo?: ReplyReference;
};

export type GalleryFilePayload = {
  v: 1;
  kind: 'gallery-file';
  file: FileManifest;
  sentAt: string;
};

export type ImagePayload = {
  v: 1 | 2;
  kind: 'image';
  image: ImageManifest;
  sentAt: string;
  replyTo?: ReplyReference;
};

export type GalleryImagePayload = {
  v: 1;
  kind: 'gallery-image';
  image: ImageManifest;
  sentAt: string;
};

export type ImageAlbumPayload =
  | {
      v: 1;
      kind: 'image-album';
      images: ImageManifest[];
      sentAt: string;
      replyTo?: never;
    }
  | {
      v: 2;
      kind: 'image-album';
      images: ImageManifest[];
      sentAt: string;
      replyTo: ReplyReference;
    };

/** Shares the opaque encrypted attachment transport, not the image gallery. */
export type AudioManifest = ImageManifest;

export type AudioPayload = {
  v: 1 | 2;
  kind: 'audio';
  audio: AudioManifest;
  durationMs: number;
  waveform: number[];
  sentAt: string;
  replyTo?: ReplyReference;
};

export type ReactionEmoji = '❤️' | '👍' | '👎' | '😂' | '‼️' | '❓';

/** Stable identity of one confirmed chat message. */
export type MessageTarget = {
  clientMsgId: string;
  serverSeq: number;
  senderId: string;
};

/** Encrypted event; one current reaction per participant, even across linked devices. */
export type ReactionPayload = {
  v: 1;
  kind: 'reaction';
  sentAt: string;
  target: MessageTarget;
  /** Null removes the participant's current reaction. */
  emoji: ReactionEmoji | null;
};

/** Encrypted, irreversible request to hide one confirmed chat message for everyone. */
export type MessageDeletePayload = {
  v: 1;
  kind: 'message-delete';
  sentAt: string;
  target: MessageTarget;
};

export type MessagePayload = TextPayload | ImagePayload | GalleryImagePayload | ImageAlbumPayload | AudioPayload | FilePayload | GalleryFilePayload | ReactionPayload | MessageDeletePayload;

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
  acceptedAt: string;
} & (
  | { receipt: DeliveryReceipt; skipped?: false }
  | { skipped: true; receipt?: never }
);

export type OutboxItem = {
  clientMsgId: string;
  payload: MessagePayload;
  createdAt: string;
  envelope?: MessageEnvelope;
};

export type LegacyImageUploadPlan = {
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

export type ImageUploadPlanV2 = Omit<LegacyImageUploadPlan, 'v'> & {
  v: 2;
  plaintextSha256: string;
};

export type ImageUploadPlan = LegacyImageUploadPlan | ImageUploadPlanV2;

export type RoomState = {
  roomId: string;
  nextSeq: number;
  nextReceiptSeq?: number;
  sealedAt: string | null;
  protocol: 'legacy-v1' | 'mls-rfc9420';
  members: RoomMember[];
  mlsWelcome?: MlsWelcomeEnvelope | null;
  nextMlsEventSeq?: number;
  mlsEvents?: ServerMlsMembershipEvent[];
  recoveryRequests?: RecoveryRequest[];
};
