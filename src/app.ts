import { voiceRequest, confirmVoiceUpload, VOICE_FAILURE_TEXT } from './lib/voice-network';
import QRCode from 'qrcode';
import { PresenceCircuit, presenceCircuitMarkup } from './lib/presence-circuit';
import './presence-circuit.css';
import { closeDialog, mountDialog } from './lib/dialog';
import { createMemePickerCache, MemePicker, memeIcons } from './lib/meme-picker';
import { isExpressionPayload } from './lib/expression-media';
import { loadStickerPacks, installStickerPack, removeStickerPack, reorderStickerPacks } from './lib/vault';
import './memes.css';
import './chat-tools.css';
import './design-system.css';
import { normalizeAttachmentFavorites, sortFavoriteAssets } from './lib/attachment-favorites';
import { validateMemeFile, MEME_TYPES } from './lib/meme-media';
import { loadMemeFavorites, loadMemeFavoriteFile, saveMemeFavorite, removeMemeFavorite } from './lib/vault';
import {
  ApiError,
  completeBlob,
  claimDeviceLink,
  createDeviceLink,
  createRoom,
  deleteRoom,
  fetchBlobChunk,
  getBlobStatus,
  getDeviceLinkStatus,
  getRoomState,
  getCallConfiguration,
  joinRoom,
  listDeviceLinks,
  publishMlsMembership,
  publishMlsWelcome,
  requestRecovery,
  recoveryStatus,
  reserveBlob,
  RoomSocket,
  uploadBlobChunk,
} from './lib/api';
import { randomBase64Url } from './lib/base64';
import { canonicalStringify } from './lib/canonical';
import {
  bundleFingerprint,
  createDeliveryReceipt,
  createJoinProof,
  decryptMessage,
  encryptMessage,
  generateIdentity,
  verifyDeliveryReceipt,
  verifyJoinProof,
} from './lib/crypto';
import { decryptAudioFile, encryptAudioFile, decryptImageFile, encryptImageFile, encryptFileAttachment, decryptFileAttachment, MAX_IMAGE_BYTES } from './lib/file-crypto';
import { VoiceRecorder } from './lib/voice-recorder';
import { bindVoiceInputGesture } from './lib/voice-gesture';
import { bindImageViewerGestures } from './lib/image-viewer-gestures';
import { prepareImageMotion, type ImageMotion } from './lib/image-animation';
import { createConcealedImage } from './lib/concealed-image';
import { mountPhotoDetails } from './lib/photo-details';
import { createElement, Info, Pause, Play, Plus, Camera, Maximize, Volume2, VolumeX } from 'lucide';
import { isReadableChatMessage, readMessageIds } from './lib/message-read';
import { isChatMedia } from './lib/media-read';
import { bindChatImageConcealGesture } from './lib/chat-image-conceal-gesture';
import { CHAT_LATEST_GAP, mountChatBottomControl } from './lib/chat-bottom-control';
import { CHAT_KEYBOARD_LAYOUT_MS, chatKeyboardLayoutProgress, createChatKeyboardLayout } from './lib/chat-keyboard-layout';
import { bindChatKeyboardGesture, CHAT_VIEWPORT_SETTLE_MS, createChatViewportMotion } from './lib/chat-viewport-motion';
import { bindReplySwipe, replySwipeMaxOffset } from './lib/reply-swipe';
import {
  classifyInviteHash,
  makeDeviceInviteUrl,
  makeParticipantInviteUrl,
  parseInviteText,
  type DeviceInvite,
  type ParticipantInvite as Invite,
} from './lib/invite-link';
import { messageLocalDay } from './lib/message-date';
import { VoicePlayback, VoicePlayer } from './lib/voice-player';
import { CallController } from './lib/call-controller';
import { CallView } from './lib/call-view';
import { createAuthenticatedCallVault, assertAuthenticatedRoomRoster, signCallIdentityAttestation, verifyCallIdentityAttestations } from './lib/call-membership';
import { CALL_CAPABILITY, type CallKind, type CallState } from './lib/call-types';
import { voiceIcons, voiceTime } from './lib/voice-audio';
import { UnreadCounter } from './lib/unread-counter';
import {
  currentRelease,
  releaseLog,
  pendingReleaseNotes,
  hasPendingReleaseNotes,
  markReleaseNotesSeen,
  pendingReleaseUpdate,
  subscribeReleaseUpdate,
} from './lib/release-update';
import { REACTION_EMOJIS, reduceMessageReactions } from './lib/reactions';
import { reduceMessageDeletions } from './lib/message-deletions';
import {
  curateGalleryAssets,
  galleryCurationKey,
  normalizeGalleryCurationRecords,
  type GalleryCurationAsset,
  type GalleryCurationRecord,
  type GalleryCurationTarget,
} from './lib/gallery-curation';
import { batchAttachmentFiles } from './lib/image-batches';
import { isVideoFile, videoMimeType } from './lib/video-media';
import { createVideoPoster } from './lib/video-poster';
import { VideoUploadView } from './lib/video-upload-view';
import { downloadBlob } from './lib/download';
import { DocumentReader, documentReaderMimeType, documentReaderLimit } from './lib/document-reader';
import { createFileFormatIcon } from './lib/file-format';
import { observeEpubCover } from './lib/epub-cover';
import { gestureSecret, GesturePad } from './lib/gesture';
import {
  createCreatorMlsState,
  decryptMlsApplication,
  encryptMlsApplication,
  joinMlsGroup,
  joinMlsMembership,
  prepareCreatorWelcome,
  prepareMlsMembership,
  processMlsMembership,
  prepareMlsRecoveryReplacement,
  verifyRecoveryMembershipChain,
} from './lib/mls';
import {
  backgroundNotificationStatus,
  disableBackgroundNotifications,
  enableBackgroundNotifications,
} from './lib/push';
import {
  createPlatformCredential,
  isPlatformVaultCancellation,
  unlockPlatformCredential,
  type PlatformCredentialResult,
} from './lib/platform-vault';
import type {
  DecryptedMessage,
  DeliveryReceipt,
  FileManifest,
  ImageManifest,
  ImageUploadPlan,
  MessageEnvelope,
  MessagePayload,
  ReactionEmoji,
  OutboxItem,
  PlatformCredentialRecord,
  ReplyReference,
  RoomMember,
  RoomState,
  ServerMessage,
  ServerReceipt,
  StoredVault,
  Vault,
} from './lib/types';
import {
  createVault,
  commitMlsReceive,
  commitMlsSend,
  deleteOutboxItem,
  deleteCachedMediaBlob,
  deleteCurrentVault,
  downloadVaultDiagnostic,
  deletePendingReceipt,
  deleteUploadPlan,
  hasStoredVault,
  bindRecoveredVaultToPlatform,
  loadHistoryPage,
  loadHistoryPageAfter,
  loadHistoryMessage,
  loadMessageEventHistory,
  loadMediaHistoryPage,
  loadOutbox,
  loadPendingReceipts,
  loadUploadPlans,
  loadUiPreferences,
  loadCachedMediaChunk,
  migrateVaultToPlatform,
  readStoredVault,
  resumeVaultSession,
  saveOutboxItem,
  saveCachedMediaChunk,
  savePendingReceipt,
  saveHistoryMessage,
  saveUploadPlan,
  saveUiPreferences,
  saveVault,
  withVaultMutation,
  finishVaultRecovery,
  unlockRecoveryVault,
  unlockVault,
  type VaultSession,
  type ChatScrollAnchor,
  type UiPreferences,
  type VaultMutation,
} from './lib/vault';
import { recoverFromCloud, restoreCloudHistory, syncCloudBackup } from './lib/cloud-backup';
import './backup.css';

const CLIENT_CAPABILITIES = ['mls-multidevice-v1', 'reply-v2', 'passkey-only-v3', 'image-album-v1', 'expression-image-v1', 'recovery-replace-v1', 'voice-message-v1', 'message-reactions-v1', 'message-delete-v1', 'media-read-v1', 'message-read-v1', 'file-message-v1', 'media-dimensions-v1', CALL_CAPABILITY];
// Safari may briefly move window focus into its native keyboard surface after
// a direct textarea tap. Keep this exception short, one-use and independent
// from chooser/media handoffs so every hard lifecycle signal still locks.
const KEYBOARD_NATIVE_HANDOFF_MS = 1_200;
// Tapping the expression toggle may dismiss the iOS keyboard through a short
// visible window blur before the panel's click handler runs.
const MEME_PANEL_HANDOFF_MS = 2_500;
const CHAT_COMPOSER_MOTION_MS = 280;
const CHAT_KEYBOARD_DISMISS_MS = 420;
const CHAT_COMPOSER_VIEWPORT_SETTLE_MS = 500;

type CachedImage = { blob: Blob; url: string; bytes: number; lastUsedAt: number; width?: number; height?: number; posterUrl?: string; posterPromise?: Promise<void>; posterUnavailable?: boolean; concealedUrl?: string; concealedPromise?: Promise<void> };
const MAX_IMAGE_CACHE_BYTES = 96 * 1024 * 1024;

const encoder = new TextEncoder();
const DEVICE_VERIFICATION_FOCUS_RETURN_MS = 1_500;

class SecurityViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityViolation';
  }
}

const icons = {
  video: '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="5" width="12" height="14" rx="3"/><path d="m15 9 6-4v14l-6-4"/></svg>',
  phone: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m7 3 3 5-3 3a15 15 0 0 0 6 6l3-3 5 3c1 5-3 5-5 4A24 24 0 0 1 3 8C2 5 3 2 7 3Z"/></svg>',
  back: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>',
  image: '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m21 15-5-5L5 20"/></svg>',
  safe: '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="12" cy="12" r="4"/><path d="M12 8v2m0 4v2m-4-4h2m4 0h2M6 8v2m0 4v2"/></svg>',
  eye: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m3 3 18 18M10.5 5.1A12 12 0 0 1 12 5c6.5 0 10 7 10 7a20 20 0 0 1-3.2 4.1M6.1 6.1A20 20 0 0 0 2 12s3.5 7 10 7a11 11 0 0 0 5.2-1.3M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
  file: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></svg>',
  upload: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 16V4"/><path d="m8 8 4-4 4 4"/><path d="M5 20h14"/></svg>',
  pin: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m9 3 6 1-1 5 4 4-5 2-2 6-2-6-5-2 4-4Z"/><path d="M11 15 8 22"/></svg>',
  more: '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>',
  send: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>',
  lock: '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
  download: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M5 21h14"/></svg>',
  bell: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg>',
  reply: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m9 17-5-5 5-5"/><path d="M4 12h9a7 7 0 0 1 7 7"/></svg>',
  trash: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 10v7M14 10v7"/></svg>',
  close: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>',
};

type GalleryAsset = GalleryCurationAsset & { manifest: ImageManifest; sentAt: string; source: DecryptedMessage };
type GalleryFileAsset = GalleryCurationAsset & { manifest: FileManifest; sentAt: string; source: DecryptedMessage };
type GalleryTab = 'images' | 'files';

function formPassword(form: HTMLFormElement): string {
  return String(new FormData(form).get('password') ?? '');
}

function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android 设备';
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows 电脑';
  if (/Linux/i.test(ua)) return 'Linux 电脑';
  return '浏览器设备';
}

async function deviceLinkSafetyCode(linkId: string, authorizer: RoomMember, target: RoomMember): Promise<string> {
  const material = canonicalStringify({
    v: 1,
    linkId,
    authorizer: memberBundle(authorizer),
    target: memberBundle(target),
  });
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(material)));
  const digits = (digest[0]! << 16) | (digest[1]! << 8) | digest[2]!;
  return String(digits % 1_000_000).padStart(6, '0').replace(/(\d{3})(\d{3})/, '$1 $2');
}

function timeLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date);
}

function memberBundle(member: RoomMember) {
  return {
    deviceId: member.deviceId,
    encryptionKey: member.encryptionKey,
    signingKey: member.signingKey,
    ...(member.mlsKeyPackage ? { mlsKeyPackage: member.mlsKeyPackage } : {}),
  };
}

function setBusy(button: HTMLButtonElement, busy: boolean, busyLabel = '处理中…'): void {
  if (!button.dataset.label) button.dataset.label = button.textContent ?? '';
  button.disabled = busy;
  button.textContent = busy ? busyLabel : button.dataset.label;
}

function isDesktopBrowser(): boolean {
  const agent = navigator as Navigator & { userAgentData?: { mobile?: boolean }; standalone?: boolean };
  // Screen size and an attached keyboard do not identify a desktop browser.
  // iPad desktop mode also reports Macintosh, but retains touch capabilities.
  if (agent.userAgentData?.mobile || /Android|iPhone|iPad|iPod|Mobile|Tablet/i.test(agent.userAgent)) return false;
  if (/Macintosh/i.test(agent.userAgent) && agent.maxTouchPoints > 1) return false;
  if (agent.standalone || matchMedia('(display-mode: standalone), (display-mode: minimal-ui), (display-mode: fullscreen)').matches) return false;
  return /Windows NT|Macintosh|X11|CrOS/i.test(agent.userAgent);
}

export class QuietRoomApp {
  private session: VaultSession | null = null;
  private readonly desktopBrowser = isDesktopBrowser();
  private readonly appleWebKit = navigator.vendor.includes('Apple')
    && CSS.supports('-webkit-touch-callout', 'none');
  // iOS reports client rectangles against its moving visual viewport. A desktop
  // WebKit window (including a mobile UA without touch) keeps layout coordinates.
  private readonly visualClientCoordinates = this.appleWebKit && !this.desktopBrowser && navigator.maxTouchPoints > 0;
  private readonly usesListScrolling = this.visualClientCoordinates;
  private availableReleaseId = pendingReleaseUpdate();
  // Memory only. Cover teardown still clears media, rendered history and sockets.
  private retainedSession: VaultSession | null = null;
  private coverEntryEpoch = 0;
  private gatewayRenderEpoch = 0;
  private idleDeadline = 0;
  private idleMonotonicDeadline = 0;
  private socket: RoomSocket | null = null;
  private messages = new Map<number, DecryptedMessage>();
  private messageEventHistory = new Map<number, DecryptedMessage>();
  private readCompatibility = '';
  private videoUploads = new Map<string, { view: VideoUploadView; file: File; reply: DecryptedMessage | null; sentAt: string; busy: boolean }>();
  private selectedMessageId: string | null = null;
  private privacyCurtain: HTMLElement;
  private unreadCounter: UnreadCounter;
  private pending = new Map<string, DecryptedMessage>();
  private outbox = new Map<string, OutboxItem>();
  private pendingReceipts = new Map<string, DeliveryReceipt>();
  private serverQueue = new Map<number, ServerMessage>();
  private livePresenceMessages = new WeakSet<ServerMessage>();
  private receiptQueue = new Map<number, ServerReceipt>();
  private uploadPlans: ImageUploadPlan[] = [];
  private imageCache = new Map<string, CachedImage>();
  private memeCache = createMemePickerCache();
  private memePicker: MemePicker | null = null;
  private imageLoadPromises = new Map<string, Promise<CachedImage>>();
  private imageLoadStatus = new Map<string, { stage: 'queued' | 'download' | 'decrypt' | 'decode'; ratio?: number }>();
  private imageManifestSignatures = new Map<string, string>();
  private activeImageLoads = 0;
  private imageLoadWaiters: Array<() => void> = [];
  private imageCacheBytes = 0;
  private connectionState: 'connecting' | 'connected' | 'disconnected' = 'disconnected';
  private rolePresence: { creator: boolean; joiner: boolean } | null = null;
  private activeSurface: 'away' | 'chat' = 'away';
  private draining = false;
  private receiptDraining = false;
  private coverTimer: number | null = null;
  private coverRevealTimer: number | null = null;
  private coverHoldCommitted = false;
  private coverStoredVault: StoredVault | null = null;
  private coverStoredVaultPreparation = 0;
  private idleTimer: number | null = null;
  private blurLockTimer: number | null = null;
  private sendingTextDrafts = new Set<string>();
  private chatPinnedToBottom = true;
  private chatViewportTop = 0;
  private chatViewportHeight = 0;
  private chatBottomFollowPending = false;
  private chatViewportFollowUntil = 0;
  private chatLastScrollY = 0;
  private nativeChatFollow: { list: HTMLElement; offset: number; top: string; padding: string; priority: string } | null = null;
  private nativeKeyboardDismiss: { started: number; row: HTMLElement; height: number; distance: number;
    offset: number; scroll: number; animation: Animation } | null = null;
  private nativeClosedViewportHeight = 0;
  private nativeClosedComposer: { minHeight: number; paddingBottom: number } | null = null;
  private nativeKeyboardOpening = false;
  private listKeyboardLayout = createChatKeyboardLayout();
  private chatKeyboardSurfaceMotion: { started: number; target: number; animations: Animation[] } | null = null;
  private chatResumeBottomOnFocus = false;
  private chatScrollFrame: number | null = null;
  private chatScrollBookkeepingPending = false;
  private chatScrollDocumentMovedPending = false;
  private chatMessageAnimations = new Set<Animation>();
  private chatMessageTranslations = new Set<HTMLElement>();
  private composerHeightMotion: {
    targetHeight: number;
    frame: number | null;
  } | null = null;
  private composerViewportSettleUntil = 0;
  private chatBottomControl: ReturnType<typeof mountChatBottomControl> | null = null;
  private chatViewportMotion: ReturnType<typeof createChatViewportMotion> | null = null;
  private chatKeyboardGesture: ReturnType<typeof bindChatKeyboardGesture> | null = null;
  private galleryViewportHeader: HTMLElement | null = null;
  private syncViewport: () => void = () => {};
  private trackChatViewport: (follow?: boolean) => void = () => {};
  private syncChatLayout: (position?: boolean) => void = () => {};
  private cancelViewportWork: () => void = () => {};
  private chatLayoutGeneration = 0;
  private visualViewportGeometryGeneration = 0;
  private pendingChatViewportGeometry: {
    generation: number;
    paddingBottom: string;
    minHeight: string;
  } | null = null;
  private chatLayoutElements: {
    shell: HTMLElement;
    list: HTMLElement;
    header: HTMLElement;
    fixedOrigin: HTMLElement;
    fixedBottom: HTMLElement;
    composer: HTMLElement;
    notices: HTMLElement;
    notice: HTMLElement;
  } | null = null;
  private chatScrollIntent: 'up' | 'down' | null = null;
  private chatRestoreAnchor: ChatScrollAnchor | null = null;
  private sendChain: Promise<void> = Promise.resolve();
  private membershipChain: Promise<void> = Promise.resolve();
  private sending = new Set<string>();
  private outboxReencryptions = new Map<string, Promise<void>>();
  private retryTimers = new Map<string, number>();
  private retryCounts = new Map<string, number>();
  private deferredCapabilityItems = new Set<string>();
  private renderedMessages = new Map<string, { payload: MessagePayload; status: DecryptedMessage['status']; acceptedAt: string; element: HTMLElement }>();
  private renderedMessageOrder: HTMLElement[] = [];
  private renderedMessageDates = new Map<string, HTMLElement>();
  private renderedMessageSeq = new Map<string, number>();
  private gesturePad: GesturePad | null = null;
  private privacyCovered = true;
  private runtimeAbort: AbortController | null = null;
  private runtimeEpoch = 0;
  private filePickerActive = false;
  private imagePickerActive = false;
  private imagePickerInput: HTMLInputElement | null = null;
  private imageBatchUploading = false;
  private imagePickerResetTimer: number | null = null;
  private imagePickerFocusReturnTimer: number | null = null;
  private deferredImageUpload: { roomId: string; deviceId: string; files: File[]; destination: 'chat' | 'gallery' } | null = null;
  private unlocking = false;
  private gatewayUnlockAbort: AbortController | null = null;
  private gatewayFocusAbort: AbortController | null = null;
  private deviceVerificationActive = false;
  private systemSurfaceTokens = new Set<symbol>();
  private nativeHandoff: {
    kind: 'picker' | 'microphone' | 'camera';
    deadline: number;
    wallDeadline: number;
    blurred: boolean;
    timer: number;
    settling?: Promise<boolean>;
    settle?: (invalidated: boolean) => void;
  } | null = null;
  private keyboardHandoff: {
    deadline: number;
    wallDeadline: number;
    blurred: boolean;
    runtimeEpoch: number;
    session: VaultSession;
    input: HTMLTextAreaElement | HTMLInputElement;
    viewportGeneration: number;
    baselineViewportHeight: number;
    baselineLayoutHeight: number;
    openingEvidence: boolean;
    timer: number;
  } | null = null;
  private memePanelHandoff: {
    deadline: number;
    wallDeadline: number;
    blurred: boolean;
    runtimeEpoch: number;
    session: VaultSession;
    button: HTMLButtonElement;
    timer: number;
  } | null = null;
  private deviceVerificationToken: symbol | null = null;
  private deviceVerificationDeadline = 0;
  private deviceVerificationWallDeadline = 0;
  private deviceVerificationFocusSettle: ((valid: boolean) => void) | null = null;
  private galleryObserver: IntersectionObserver | null = null;
  private chatImageObserver: IntersectionObserver | null = null;
  private historyHasMore = false;
  private historyHasNewer = false;
  private historyForwardCursor = 0;
  private historyLoading = false;
  private fileExportActive = false;
  private fileExportResetTimer: number | null = null;
  private restoreComposerFocusAfterPicker = false;
  private keepComposerKeyboard = false;
  private bottomControlRetainsKeyboard = false;
  private composerSelection: { start: number; end: number } | null = null;
  private noticeTimer: number | null = null;
  private noticeRemovalTimer: number | null = null;
  private pageTransitionTimer: number | null = null;
  private preferenceSaveTimer: number | null = null;
  private preferenceSaveChain: Promise<void> = Promise.resolve();
  private clipboardWriteChain: Promise<void> = Promise.resolve();
  private deviceInviteGeneration = 0;
  private uiPreferences: UiPreferences = {};
  private uiPreferencesHydrated = false;
  private restoreChatAnchorOnNextRender = true;
  private galleryScrollTop: Record<GalleryTab, number> = { images: 0, files: 0 };
  private galleryMode: 'safe' | 'favorites' = 'safe';
  private galleryRevealedAssets = new Set<string>();
  private chatRevealedAssets = new Set<string>();
  private chatExplicitlyConcealedAssets = new Set<string>();
  private mediaReadQueued = new Set<string>();
  private messageReadQueued = new Set<string>();
  private readMessageIds = new Set<string>();
  private chatConcealedExpressions = new Set<string>();
  private chatImageConcealGesture: ReturnType<typeof bindChatImageConcealGesture> | null = null;
  private galleryKnownCounts: Partial<Record<GalleryTab, { keys: Set<string>; complete: boolean }>> = {};
  private galleryRefreshPending: GalleryTab | null = null;
  private chatLayoutObserver: ResizeObserver | null = null;
  private presenceRefreshTimer: number | null = null;
  private presenceCircuit: PresenceCircuit | null = null;
  private recoveryPollTimer: number | null = null;
  private backupTimer: number | null = null;
  private backupRun: Promise<void> | null = null;
  private backupError = '';
  private roleLastSeen: { creator: number | null; joiner: number | null } = { creator: null, joiner: null };
  private viewerMediaCleanup: (() => void) | null = null;
  private viewerDetailsCleanup: ((animate?: boolean) => void) | null = null;
  private viewerWorkAbort: AbortController | null = null;
  private documentReader: { view: DocumentReader; previous: 'chat' | 'away'; returnFocus: HTMLElement; source?: DecryptedMessage } | null = null;
  private viewerGestureCleanup: (() => void) | null = null;
  private viewerKeyHandler: ((event: KeyboardEvent) => void) | null = null;
  private viewerReturnFocus: HTMLElement | null = null;
  private viewerPreviousSurface: 'away' | 'chat' = 'away';
  private viewerProjectionSources: DecryptedMessage[] = [];
  private replyTarget: DecryptedMessage | null = null;
  private messageHoldTimer: number | null = null;
  private messageHoldStart: { x: number; y: number } | null = null;
  private suppressMediaClickUntil = 0;
  private messageHighlightTimer: number | null = null;
  private replyJumpVersion = 0;
  private voiceRecorder: VoiceRecorder | null = null;
  private voiceGesture: ReturnType<typeof bindVoiceInputGesture> | null = null;
  private microphonePromptActive = false;
  private voicePlayback = new VoicePlayback();
  private callController: CallController | null = null;
  private callVault: Vault | null = null;
  private callView: CallView | null = null;
  private callPermissionActive = false;
  private callReturnFocus: HTMLElement | null = null;

  constructor(private readonly root: HTMLElement) {
    root.inert = root.classList.contains('portrait-blocked');
    root.addEventListener('portraitvisibilitychange', () => {
      root.inert = root.classList.contains('portrait-blocked') || Boolean(this.callView);
      this.socket?.setChatPresence(this.activeSurface === 'chat' && !root.classList.contains('portrait-blocked'));
      if (!root.classList.contains('portrait-blocked')) this.markVisibleMessagesRead();
    });
    subscribeReleaseUpdate(releaseId => {
      this.availableReleaseId = releaseId;
      this.renderReleaseUpdateBanner();
    });
    this.unreadCounter = new UnreadCounter(count => {
      document.querySelectorAll<HTMLElement>('.cover-unread').forEach(label => { label.textContent = String(count); });
    });
    this.privacyCurtain = document.createElement('div');
    this.privacyCurtain.className = 'privacy-curtain';
    this.privacyCurtain.setAttribute('aria-hidden', 'true');
    this.privacyCurtain.innerHTML = this.coverErrorMarkup();
    document.body.append(this.privacyCurtain);
    const refreshUnread = () => {
      if (document.hidden) return;
      // A visible chat may have nothing new to acknowledge. Keep its cached
      // cover count current too, including while the unlock gateway has no session.
      void this.unreadCounter.refresh();
      if (this.privacyCovered) return;
      const session = this.session;
      const epoch = this.runtimeEpoch;
      if (!session || (session.vault.pairingState && session.vault.pairingState !== 'ready')) return;
      void this.unreadCounter.ensureConfigured(session.vault, this.runtimeAbort?.signal).then(ready => {
        if (!ready || !this.isRuntimeActive(epoch, session)) return;
        this.markVisibleMessagesRead();
      });
    };
    window.setInterval(refreshUnread, 5_000);
    window.addEventListener('online', refreshUnread);
    const isNativeVideo = (event: Event) => event.target instanceof HTMLVideoElement
      || document.fullscreenElement instanceof HTMLVideoElement;
    const preventZoom = (event: Event) => { if (!isNativeVideo(event)) event.preventDefault(); };
    let viewportFrame: number | null = null;
    let nativeViewportFrame: number | null = null;
    let trackingFrame: number | null = null;
    let trackingUntil = 0;
    let trackingHardUntil = 0;
    let previousViewportHeight = 0;
    let previousLayoutHeight = 0;
    let previousViewportTop = -1;
    let previousViewportWidth = 0;
    let previousChatGeneration = -1;
    let viewportWidthChanged = false;
    const finishViewportSync = () => {
      viewportFrame = null;
      const reflowSelection = viewportWidthChanged;
      viewportWidthChanged = false;
      if (this.activeSurface !== 'chat') return;
      const selection = this.root.querySelector<HTMLTextAreaElement>('.message-text-selection');
      if (selection && reflowSelection) {
        selection.style.height = '0px';
        selection.style.height = `${selection.scrollHeight}px`;
      }
      const actions = this.root.querySelector<HTMLElement>('.message-actions:not(.is-closing)');
      if (actions) {
        const source = this.root.querySelector<HTMLElement>(`.message[data-client-msg-id="${CSS.escape(actions.dataset.sourceId ?? '')}"]`);
        if (source) this.positionMessageActions(actions, source);
        else this.closeMessageActions(false, false);
      }
    };
    const setStyle = (style: CSSStyleDeclaration, property: string, value: string) => {
      if (style.getPropertyValue(property) !== value) style.setProperty(property, value);
    };
    const syncVisualViewport = () => {
      const viewport = window.visualViewport;
      // Fixed controls and document scrolling use the layout viewport. Safari
      // can report a keyboard-sized innerHeight while that viewport stays tall.
      const layoutHeight = document.documentElement.clientHeight || window.innerHeight;
      // Toolbar collapse can expose more than clientHeight before WebKit
      // updates its layout viewport. Never clip that newly visible area.
      const viewportHeight = Math.max(1, viewport?.height ?? window.innerHeight);
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const keyboardSpace = Math.max(0, layoutHeight - viewportHeight);
      // Discard rubber-band and stale dismissal offsets once the full viewport
      // is visible. Panning never contributes to the document's keyboard space.
      const viewportTop = Math.max(0, Math.min(viewport?.offsetTop ?? 0, keyboardSpace));
      const chat = this.activeSurface === 'chat' && this.chatLayoutElements?.shell.isConnected ? this.chatLayoutElements : null;
      const chatGeneration = chat ? this.chatLayoutGeneration : 0;
      const resized = previousViewportHeight !== viewportHeight || previousLayoutHeight !== layoutHeight;
      const widthChanged = previousViewportWidth !== viewportWidth;
      const viewportGeometryChanged = resized || widthChanged || previousViewportTop !== viewportTop;
      if (viewportGeometryChanged) this.visualViewportGeometryGeneration += 1;
      const generationChanged = previousChatGeneration !== chatGeneration;
      const keyboardOpen = keyboardSpace > 120;
      const keyboardGeometry = keyboardSpace <= 120
        ? 'closed'
        : keyboardSpace >= Math.max(180, layoutHeight * 0.28)
          ? 'open'
          : 'intermediate';
      const previousKeyboardOpen = Math.max(0, previousLayoutHeight - previousViewportHeight) > 120;
      if (chat && this.visualClientCoordinates && previousKeyboardOpen && viewportHeight > previousViewportHeight + 72) {
        this.beginNativeKeyboardDismiss(previousViewportHeight);
      }
      if (chat && this.visualClientCoordinates && !keyboardOpen && !this.nativeKeyboardDismiss) {
        this.nativeClosedViewportHeight = viewportHeight;
        if (resized || generationChanged) {
          const style = getComputedStyle(chat.composer);
          this.nativeClosedComposer = { minHeight: parseFloat(style.minHeight) || 0,
            paddingBottom: parseFloat(style.paddingBottom) || 0 };
        }
      }
      const composerInput = chat?.composer.querySelector<HTMLTextAreaElement>('#message-input');
      const composerResizeOwnsGeometry = Boolean(chat
        && (this.composerHeightMotion || this.sendingTextDrafts.size > 0
          || performance.now() < this.composerViewportSettleUntil
          // With a settled open keyboard, an offset-only change while the
          // textarea retains focus is Safari's caret/document pan. Real
          // keyboard motion changes height; history gestures are tracked
          // separately and must continue through the conceal gate.
          || previousViewportHeight === viewportHeight && previousViewportTop !== viewportTop)
        && document.activeElement === composerInput && previousChatGeneration === chatGeneration
        && previousKeyboardOpen && keyboardOpen && keyboardGeometry === 'open'
        && previousViewportWidth === viewportWidth && previousLayoutHeight === layoutHeight
        && !this.chatViewportMotion?.moving);
      // Composer-owned caret pans still move Safari's visual viewport. They
      // must not enter the conceal gate, but fixed chrome must follow their
      // current geometry instead of remaining at an earlier offset.
      this.chatViewportTop = this.visualClientCoordinates ? 0 : viewportTop;
      this.chatViewportHeight = viewportHeight;
      if (keyboardOpen) this.completeKeyboardHandoffFromViewport({
        generation: this.visualViewportGeometryGeneration,
        viewportHeight,
        layoutHeight,
      });
      // Invalidating a consumed owner can synchronously lock and replace the
      // chat. Do not repopulate pending geometry or write to that detached DOM.
      if (chat && (this.privacyCovered || this.activeSurface !== 'chat' || !chat.shell.isConnected)) {
        this.pendingChatViewportGeometry = null;
        return false;
      }
      const keyboardState = String(keyboardOpen);
      if (document.documentElement.dataset.keyboardOpen !== keyboardState) {
        document.documentElement.dataset.keyboardOpen = keyboardState;
      }
      if (chat && !this.usesListScrolling && (resized || generationChanged) && !composerResizeOwnsGeometry) {
        this.pendingChatViewportGeometry = {
          generation: chatGeneration,
          paddingBottom: `calc(var(--chat-bottom-space) + ${keyboardSpace}px)`,
          // Short conversations need the same scrollable keyboard space as
          // long ones. Commit it once, at the stable viewport endpoint.
          minHeight: `${Math.max(layoutHeight, viewportHeight) + keyboardSpace}px`,
        };
      } else if (!chat) this.pendingChatViewportGeometry = null;
      // Put fixed chrome at this snapshot before the motion state can commit
      // document geometry or reveal. This matters when a long hard fallback
      // expires on the same sample as a final unusual keyboard movement.
      if (chat && (viewportGeometryChanged || generationChanged || this.visualClientCoordinates)) {
        const priorShellHeight = chat.shell.style.height;
        this.positionChatChrome(viewportTop, viewportHeight, layoutHeight);
        if (this.usesListScrolling && (resized || priorShellHeight !== chat.shell.style.height)
          && this.chatPinnedToBottom && this.chatScrollIntent !== 'up'
          && !this.chatBottomControl?.scrolling) this.setChatScrollTop(this.chatBottomScrollTop());
        const openMenu = chat.header.querySelector<HTMLDetailsElement>('.more-menu[open]');
        if (openMenu) setStyle(openMenu.style, '--app-height', `${viewportHeight}px`);
      }
      const motion = chat ? this.chatViewportMotion : null;
      if (this.nativeKeyboardOpening && keyboardOpen && chat
        && document.activeElement === composerInput && this.chatPinnedToBottom && this.chatScrollIntent !== 'up') {
        this.alignNativeChatContents();
      }
      this.sampleNativeKeyboardDismiss();
      const motionSettled = motion?.sample({
        height: viewportHeight,
        width: viewportWidth,
        top: viewportTop,
        layoutHeight,
        scrollY: this.chatScrollTop,
        keyboardOpen,
        keyboardGeometry,
        composerResize: composerResizeOwnsGeometry,
      }) ?? false;
      if (!resized && !widthChanged && previousViewportTop === viewportTop && previousChatGeneration === chatGeneration) {
        // A WebKit viewport event can arrive without geometry changes while
        // the initial chat motion is still settling. Keep the bounded sampler
        // alive so a quiet endpoint can reveal the composer.
        if (motion?.moving) this.trackChatViewport(false);
        return motionSettled;
      }
      // Keep frame-by-frame position updates local to the four floating
      // controls. Inherited root variables invalidate every historical row.
      if (!chat) {
        setStyle(document.documentElement.style, '--app-height', `${viewportHeight}px`);
        setStyle(document.documentElement.style, '--app-top', `${viewportTop}px`);
      }
      previousViewportHeight = viewportHeight;
      previousLayoutHeight = layoutHeight;
      previousViewportTop = viewportTop;
      previousViewportWidth = viewportWidth;
      previousChatGeneration = chatGeneration;
      if (composerResizeOwnsGeometry) return motionSettled;
      if (chat) {
        // During keyboard/toolbar movement only the fixed chrome follows the
        // visual viewport. Message-document geometry, bottom alignment and
        // control measurements are committed together by the settled callback.
        if (!motion?.moving && !motionSettled) this.commitChatViewportGeometry();
        if (resized || widthChanged) this.trackChatViewport(false);
        if (!motion?.moving && !motionSettled) this.updateChatBottomControl();
      }
      viewportWidthChanged ||= widthChanged;
      if (viewportFrame === null) viewportFrame = requestAnimationFrame(finishViewportSync);
      return motionSettled;
    };
    this.syncViewport = () => {
      if (nativeViewportFrame !== null) cancelAnimationFrame(nativeViewportFrame);
      nativeViewportFrame = null;
      syncVisualViewport();
    };
    const scheduleVisualViewportSync = () => {
      // A caret pan can be reported between input and the next frame. Keep
      // settled, focused typing synchronous; the same positioning function
      // owns both this correction and the continuous native-origin sampler.
      const focusedComposer = this.chatLayoutElements?.composer.querySelector('#message-input') === document.activeElement;
      if (this.visualClientCoordinates && this.activeSurface === 'chat'
        || focusedComposer && document.documentElement.dataset.keyboardOpen === 'true') {
        syncVisualViewport();
        return;
      }
      if (nativeViewportFrame !== null) return;
      nativeViewportFrame = requestAnimationFrame(() => {
        nativeViewportFrame = null;
        syncVisualViewport();
      });
    };
    const sampleViewport = () => {
      trackingFrame = null;
      const chat = this.activeSurface === 'chat' && this.chatLayoutElements?.shell.isConnected;
      const gallery = this.activeSurface === 'away' && this.galleryViewportHeader?.isConnected;
      if (this.privacyCovered || !chat && !gallery) return;
      const motionSettled = syncVisualViewport();
      if (chat && !motionSettled && !this.chatViewportMotion?.moving) {
        if (this.chatBottomFollowPending && this.chatScrollIntent !== 'up') this.alignChatBottom();
        this.chatBottomControl?.update(false);
      }
      const keepSamplingNativeChrome = Boolean(chat && this.visualClientCoordinates);
      const now = performance.now();
      if (now >= trackingUntil) {
        this.chatBottomFollowPending = false;
        this.chatViewportFollowUntil = 0;
        if ((!keepSamplingNativeChrome && !this.chatViewportMotion?.moving) || now >= trackingHardUntil) return;
        // Viewport events start a fresh bounded sampling window when Safari
        // cannot deliver every native toolbar frame. Do not keep a permanent
        // animation loop alive while the page is idle. Native fixed chrome
        // gets the same longer, still bounded window because WebKit can move
        // its origin after the keyboard motion itself has settled.
      }
      // Safari can withhold viewport events during native toolbar movement.
      // Keep this cheap geometry sample alive only during the bounded window;
      // unchanged samples return before reading messages or writing any styles.
      if (trackingFrame === null) trackingFrame = requestAnimationFrame(sampleViewport);
    };
    this.trackChatViewport = (follow = false) => {
      const chat = this.activeSurface === 'chat' && this.chatLayoutElements?.shell.isConnected;
      const gallery = this.activeSurface === 'away' && this.galleryViewportHeader?.isConnected;
      if (this.privacyCovered || !chat && !gallery) return;
      // Following browser focus scrolls is bounded. A moving viewport may use
      // the longer motion bound, while idle pages never keep this frame alive.
      trackingUntil = performance.now() + 900;
      trackingHardUntil = performance.now() + 2_200;
      if (follow) this.chatViewportFollowUntil = trackingUntil;
      if (trackingFrame === null) trackingFrame = requestAnimationFrame(sampleViewport);
    };
    this.cancelViewportWork = () => {
      this.galleryViewportHeader = null;
      this.listKeyboardLayout.reset();
      this.cancelListKeyboardSurfaceMotion();
      if (this.composerHeightMotion?.frame != null) cancelAnimationFrame(this.composerHeightMotion.frame);
      const input = this.chatLayoutElements?.composer.querySelector<HTMLTextAreaElement>('#message-input');
      if (input && this.composerHeightMotion) input.style.height = `${this.composerHeightMotion.targetHeight}px`;
      this.composerHeightMotion = null;
      this.composerViewportSettleUntil = 0;
      this.cancelNativeKeyboardDismiss();
      this.nativeKeyboardOpening = false;
      this.chatViewportMotion?.suspend();
      this.chatKeyboardGesture?.reset();
      this.chatBottomControl?.cancel();
      this.cancelChatMessageMotion();
      if (viewportFrame !== null) cancelAnimationFrame(viewportFrame);
      if (nativeViewportFrame !== null) cancelAnimationFrame(nativeViewportFrame);
      if (trackingFrame !== null) cancelAnimationFrame(trackingFrame);
      viewportFrame = null;
      nativeViewportFrame = null;
      trackingFrame = null;
      trackingUntil = 0;
      trackingHardUntil = 0;
      viewportWidthChanged = false;
      this.chatBottomFollowPending = false;
      this.chatViewportFollowUntil = 0;
      this.chatResumeBottomOnFocus = false;
      this.chatScrollBookkeepingPending = false;
      this.chatScrollDocumentMovedPending = false;
      this.pendingChatViewportGeometry = null;
    };
    syncVisualViewport();
    window.visualViewport?.addEventListener('resize', scheduleVisualViewportSync, { passive: true });
    window.visualViewport?.addEventListener('scroll', scheduleVisualViewportSync, { passive: true });
    window.visualViewport?.addEventListener('scrollend', scheduleVisualViewportSync, { passive: true });
    window.addEventListener('scrollend', scheduleVisualViewportSync, { passive: true });
    window.addEventListener('resize', scheduleVisualViewportSync, { passive: true });
    window.addEventListener('scroll', () => {
      // WebKit may defer visualViewport.scroll until a gesture ends, while
      // window.scroll already exposes the new viewport position.
      scheduleVisualViewportSync();
      this.scheduleChatScroll();
    }, { passive: true });
    document.addEventListener('gesturestart', preventZoom, { passive: false });
    document.addEventListener('gesturechange', preventZoom, { passive: false });
    document.addEventListener('gestureend', preventZoom, { passive: false });
    document.addEventListener('dblclick', event => {
      if (!(event.target instanceof Element && event.target.closest('.is-selecting-text'))) preventZoom(event);
    }, { capture: true, passive: false });
    document.addEventListener('wheel', (event) => {
      if ((event.ctrlKey || event.metaKey) && !isNativeVideo(event)) event.preventDefault();
    }, { passive: false });
    // App surfaces own their long-press actions. Explicit text selection is
    // still available from the message menu; an incidental hold opens no OS menu.
    document.addEventListener('contextmenu', event => {
      if (!(event.target instanceof Element && event.target.closest('.is-selecting-text'))) event.preventDefault();
    }, { capture: true });
    document.addEventListener('selectstart', event => {
      if (!(event.target instanceof Element && event.target.closest('input, textarea, .is-selecting-text'))) event.preventDefault();
    }, { capture: true });
    const recordActivity = (event: Event) => {
      if (!this.desktopBrowser && event.type !== 'pointerdown' && event.type !== 'keydown') return;
      // A delayed background timer must not let the first input renew an expired session.
      if (this.expireIdleSession()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (event.isTrusted && !document.hidden && document.hasFocus() && !this.privacyCovered &&
          !document.documentElement.classList.contains('privacy-obscured')) this.resetIdleLock();
    };
    for (const type of ['pointerdown', 'keydown', 'wheel', 'touchmove', 'input']) {
      document.addEventListener(type, recordActivity, { capture: true });
    }
    document.addEventListener('pointerdown', (event) => {
      const menu = this.root.querySelector<HTMLDetailsElement>('.more-menu[open]');
      if (menu && event.target instanceof Node && !menu.contains(event.target)) this.closeMoreMenu(menu);
      const composer = this.root.querySelector<HTMLElement>('#composer');
      const textarea = this.root.querySelector<HTMLTextAreaElement>('#message-input');
      const keyboardGesture = event.pointerType === 'touch' && event.target instanceof Element
        && this.root.contains(event.target) && !!event.target.closest('#message-list')
        && this.chatKeyboardGesture?.start(event);
      if (
        textarea && document.activeElement === textarea && composer &&
        event.target instanceof Node && !composer.contains(event.target) && !keyboardGesture
      ) {
        this.bottomControlRetainsKeyboard = false;
        this.keepComposerKeyboard = false;
        textarea.blur();
      }
      const selecting = this.selectedMessageId && this.root.querySelector<HTMLElement>(`.message[data-client-msg-id="${CSS.escape(this.selectedMessageId)}"]`);
      if (selecting && event.target instanceof Node && !selecting.contains(event.target)) this.clearMessageTextSelection();
      const messageActions = this.root.querySelector<HTMLElement>('.message-actions');
      if (messageActions && event.target instanceof Node && !messageActions.contains(event.target)) {
        // The release that dismisses a long-press menu must not immediately
        // activate the media underneath it.
        this.suppressMediaClickUntil = Math.max(this.suppressMediaClickUntil, Date.now() + 500);
        this.closeMessageActions();
      }
    }, { capture: true, passive: false });
    document.addEventListener('keydown', (event) => {
      if (this.privacyCovered) {
        if (!this.desktopBrowser) return;
        if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
          this.cancelCoverTimer();
          return;
        }
        if (event.key.toLowerCase() === 'f' && event.isTrusted && !event.repeat &&
            !(event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]'))) {
          event.preventDefault();
          this.beginCoverHold(2000);
        }
        return;
      }
      if (event.key !== 'Escape') return;
      if (this.selectedMessageId) { event.preventDefault(); this.clearMessageTextSelection(); return; }
      if (this.voiceRecorder) {
        event.preventDefault();
        if (this.root.querySelector('.voice-recorder')?.getAttribute('data-state') !== 'sending') this.closeVoiceRecorder(true);
        return;
      }
      if (this.root.querySelector('.image-viewer')) {
        event.preventDefault();
        const closeDetails = this.root.querySelector<HTMLButtonElement>('[data-photo-details-close]');
        if (closeDetails) { closeDetails.click(); return; }
        this.closeImageViewer();
        return;
      }
      if (this.root.querySelector('.message-actions')) {
        event.preventDefault();
        this.closeMessageActions(true);
        return;
      }
      if (this.replyTarget) {
        event.preventDefault();
        this.replyTarget = null;
        this.renderReplyDraft();
        return;
      }
      const menu = this.root.querySelector<HTMLDetailsElement>('.more-menu[open]');
      if (!menu) return;
      this.closeMoreMenu(menu, true);
    }, { capture: true });
    document.addEventListener('keyup', event => {
      if (this.desktopBrowser && (event.key.toLowerCase() === 'f' || event.code === 'KeyF')) this.cancelCoverTimer();
    }, { capture: true });
    document.addEventListener('compositionstart', () => this.cancelCoverTimer(), { capture: true });
    document.addEventListener('visibilitychange', () => {
      this.cancelCoverTimer();
      if (this.expireDeviceVerification()) return;
      if (document.hidden) {
        this.coverEntryEpoch += 1;
        this.clearKeyboardHandoff();
        this.clearMemePanelHandoff();
        this.abandonImagePicker();
      }
      if (document.hidden) this.obscurePrivacySurface();
      else { this.expireIdleSession(); this.revealPrivacySurface(); refreshUnread(); }
      if (document.hidden && !this.deviceVerificationActive) {
        this.coverOnDeparture();
      }
    }, { capture: true });
    window.addEventListener('blur', event => {
      // Capture must not confuse an input/button losing focus with the
      // browser window leaving the foreground.
      if (event.target !== window) return;
      // A foreground chooser or permission sheet can take window focus while
      // the document remains visible. Only the operation that we just opened
      // owns this bounded departure; hidden/pagehide/freeze still lock below.
      if (this.consumeMemePanelHandoffBlur()) return;
      if (this.consumeKeyboardHandoffBlur()) return;
      if (this.consumeNativeHandoffBlur()) return;
      this.coverEntryEpoch += 1;
      this.cancelCoverTimer();
      this.obscurePrivacySurface();
      if (this.deviceVerificationActive) return;
      // A later or unowned departure is not covered by the foreground handoff.
      // Detach the chooser owner so a stale system sheet cannot survive above
      // the cover, and never keep its late file selection for a new session.
      if (this.imagePickerActive || this.filePickerActive || this.fileExportActive || this.microphonePromptActive || this.callPermissionActive || this.systemSurfaceTokens.size > 0) {
        this.abandonImagePicker();
        this.lockNow({ preserveFilePicker: false });
        return;
      }
      if (this.desktopBrowser) {
        this.coverOnDeparture();
        return;
      }
      if (this.blurLockTimer !== null) window.clearTimeout(this.blurLockTimer);
      this.blurLockTimer = window.setTimeout(() => {
        this.blurLockTimer = null;
        if (!document.hasFocus() && !this.deviceVerificationActive) this.lockNow();
        else if (!document.hidden) this.revealPrivacySurface();
      }, 250);
    }, { capture: true });
    window.addEventListener('focus', event => {
      if (event.target !== window) return;
      if (this.expireDeviceVerification()) {
        refreshUnread();
        return;
      }
      const memePanelHandoff = this.memePanelHandoff;
      if (memePanelHandoff) {
        if (this.expireMemePanelHandoff(memePanelHandoff)) {
          refreshUnread();
          return;
        }
        if (!this.memePanelHandoffValid(memePanelHandoff)) {
          if (this.invalidateMemePanelHandoff(memePanelHandoff)) {
            refreshUnread();
            return;
          }
        } else this.clearMemePanelHandoff();
      }
      const keyboardHandoff = this.keyboardHandoff;
      if (keyboardHandoff) {
        if (this.expireKeyboardHandoff(keyboardHandoff)) {
          refreshUnread();
          return;
        }
        if (!this.keyboardHandoffValid(keyboardHandoff)) {
          if (this.invalidateKeyboardHandoff(keyboardHandoff)) {
            refreshUnread();
            return;
          }
        } else this.clearKeyboardHandoff();
      }
      const pendingHandoff = this.nativeHandoff;
      if (pendingHandoff && !pendingHandoff.settling && this.expireNativeHandoff(pendingHandoff)) {
        refreshUnread();
        return;
      }
      // A browser may omit window.blur around an OS picker. Any active picker
      // seen at the return focus edge gets the same short change/cancel window.
      const returningPicker = this.nativeHandoff?.kind === 'picker'
        ? this.imagePickerInput : null;
      // A result that arrived before focus is waiting on this exact handoff;
      // its own focus listener validates and clears it after this handler.
      if (!pendingHandoff?.settling) this.clearNativeHandoff(undefined, false);
      if (this.blurLockTimer !== null) window.clearTimeout(this.blurLockTimer);
      this.blurLockTimer = null;
      this.finishFileExport();
      this.expireIdleSession();
      this.revealPrivacySurface();
      if (!document.hidden && !this.privacyCovered && this.session) void this.resumeDeferredImage();
      // Some mobile browsers report focus before dispatching the picker's
      // change/cancel event. Give that event one short return edge, then detach
      // the input so a stranded system sheet cannot remain above the cover.
      if (returningPicker && returningPicker === this.imagePickerInput && this.imagePickerActive) {
        if (this.imagePickerFocusReturnTimer !== null) window.clearTimeout(this.imagePickerFocusReturnTimer);
        this.imagePickerFocusReturnTimer = window.setTimeout(() => {
          this.imagePickerFocusReturnTimer = null;
          if (returningPicker === this.imagePickerInput && this.imagePickerActive) this.abandonImagePicker();
        }, 350);
      }
      refreshUnread();
    }, { capture: true });
    document.addEventListener('freeze', () => { this.clearMemePanelHandoff(); this.abandonImagePicker(); this.lockNow(); }, { capture: true });
    window.addEventListener('pageshow', event => {
      if (event.persisted) this.lockNow();
      refreshUnread();
    }, { capture: true });
    window.addEventListener('pagehide', () => {
      this.clearMemePanelHandoff();
      this.abandonImagePicker();
      this.lockNow({ preserveFilePicker: false });
    }, { capture: true });
  }

  async start(): Promise<void> {
    this.renderCover();
    void this.unreadCounter.refresh();
  }

  private coverErrorMarkup(): string {
    return `<div class="cover-error">
      <svg class="cover-error-icon" aria-hidden="true" viewBox="0 0 48 48"><path d="M10 5h19l9 9v29H10zM29 5v10h9M17 25h2m10 0h2M18 35l5-3 6 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
      <h1>无法访问此网站</h1>
      <p>连接已意外关闭。</p>
      <div class="cover-error-details">请试试以下办法：<ul><li>检查网络连接</li><li>检查代理服务器和防火墙</li></ul></div>
      <code class="cover-error-code">ERR_CONNECTION_CLOSED <span class="cover-unread">${this.unreadCounter.count}</span></code>
    </div>`;
  }

  private obscurePrivacySurface(): void {
    this.clearMemePanelHandoff();
    this.closeMemePicker();
    document.documentElement.classList.add('privacy-obscured');
    this.concealChatImages();
    this.closeImageViewer(true);
  }

  private revealPrivacySurface(): void {
    if (!document.hidden) document.documentElement.classList.remove('privacy-obscured');
  }

  private coverOnDeparture(): void {
    if (this.expireIdleSession()) return;
    // Native permission and export flows keep their existing immediate lock.
    const nativeSurface = this.imagePickerActive || this.filePickerActive || this.fileExportActive ||
      this.microphonePromptActive || this.callPermissionActive || this.systemSurfaceTokens.size > 0;
    if (this.privacyCovered && this.retainedSession && !nativeSurface) return;
    if (this.desktopBrowser && this.session && !nativeSurface && this.idleDeadline > 0 &&
        !this.root.querySelector('.gateway')) {
      this.renderCover(false, true);
    } else this.lockNow({ preserveFilePicker: this.filePickerActive || this.imagePickerActive });
  }

  private renderCover(preserveFilePicker = false, retainSession = false): void {
    this.gatewayRenderEpoch += 1;
    this.obscurePrivacySurface();
    const retained = retainSession ? this.session : null;
    const deadline = this.idleDeadline;
    const monotonicDeadline = this.idleMonotonicDeadline;
    const picker = preserveFilePicker ? this.imagePickerInput : null;
    // Keep the same input connected while the native chooser owns it.
    if (picker) document.body.append(picker);
    if (!this.setActiveSurface('away')) return;
    this.cleanupRuntime(preserveFilePicker);
    if (retained) {
      this.retainedSession = retained;
      this.idleDeadline = deadline;
      this.idleMonotonicDeadline = monotonicDeadline;
      this.scheduleIdleLock();
    }
    this.privacyCovered = true;
    document.body.className = 'cover-mode';
    this.root.innerHTML = `
      <section class="cover" aria-label="页面加载失败">
        ${this.coverErrorMarkup()}
        <button class="cover-trigger" type="button" aria-label="长按一秒打开私密空间"></button>
      </section>
    `;
    this.revealPrivacySurface();
    if (!document.hidden) void this.unreadCounter.refresh();
    const trigger = this.root.querySelector<HTMLButtonElement>('.cover-trigger')!;
    const preparation = ++this.coverStoredVaultPreparation;
    this.coverStoredVault = null;
    // Prepare the non-secret encrypted wrapper while the cover is idle. A
    // completed hold can then enter the v3 gateway without another storage
    // wait. This preparation does not substitute for real browser focus.
    void readStoredVault().then(stored => {
      if (preparation === this.coverStoredVaultPreparation && this.privacyCovered && trigger.isConnected &&
          stored?.v === 3 && stored.unlockMethod === 'platform') this.coverStoredVault = stored;
    }).catch(() => undefined);
    let pointerId: number | null = null;
    const begin = (event: PointerEvent) => {
      // A browser may omit pointerup/cancel when focus leaves. Once the hold
      // timer was canceled, the next primary pointer starts a fresh gesture.
      if (!event.isPrimary || event.button !== 0 || (pointerId !== null && this.coverTimer !== null) || this.coverHoldCommitted) return;
      // Keep the native touch-to-focus path. Safari can return from background
      // visible but unfocused; compatibility mouse/click events can be needed
      // to recover focus like an ordinary page tap.
      // touch-action:none and the existing callout/selection rules own gestures.
      if (event.pointerType !== 'touch') event.preventDefault();
      pointerId = event.pointerId;
      const bounds = trigger.getBoundingClientRect();
      trigger.style.setProperty('--cover-press-x', `${event.clientX - bounds.left}px`);
      trigger.style.setProperty('--cover-press-y', `${event.clientY - bounds.top}px`);
      try { trigger.setPointerCapture(event.pointerId); } catch { /* Synthetic pointers have no native capture owner. */ }
      this.beginCoverHold(1000, true);
    };
    const release = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      pointerId = null;
      if (!this.coverHoldCommitted || event.type === 'pointercancel') this.cancelCoverTimer();
      if (trigger.hasPointerCapture(event.pointerId)) trigger.releasePointerCapture(event.pointerId);
    };
    trigger.addEventListener('pointerdown', begin);
    trigger.addEventListener('pointerup', release);
    trigger.addEventListener('pointercancel', release);
    trigger.addEventListener('lostpointercapture', event => {
      if (event.pointerId !== pointerId) return;
      pointerId = null;
      if (!this.coverHoldCommitted) this.cancelCoverTimer();
    });
    // If a browser missed its focus-return event, its opaque curtain can still
    // sit above an already rendered cover. Only this safe cover corner accepts
    // the fresh user gesture; no private runtime is revealed by this handoff.
    this.privacyCurtain.onpointerdown = event => {
      if (!this.privacyCovered || document.hidden || !trigger.isConnected) return;
      const bounds = trigger.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) return;
      this.revealPrivacySurface();
      begin(event);
    };
    trigger.addEventListener('keydown', (event) => {
      if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
        event.preventDefault();
        this.beginCoverHold(1000);
      }
    });
    trigger.addEventListener('keyup', () => this.cancelCoverTimer());
  }

  private beginCoverHold(duration: number, pointer = false): void {
    if (!this.privacyCovered || document.hidden || (!pointer && !document.hasFocus())) return;
    this.cancelCoverTimer();
    const trigger = this.root.querySelector<HTMLElement>('.cover-trigger');
    const entryEpoch = this.coverEntryEpoch;
    // A fresh pointer in the only active cover hot-zone is itself the return
    // edge on WebKit builds that restore pointer delivery before hasFocus().
    // Hidden/pagehide/another window blur still invalidate the entry epoch.
    const current = () => this.privacyCovered && !document.hidden && (pointer || document.hasFocus())
      && this.coverEntryEpoch === entryEpoch && Boolean(trigger?.isConnected);
    trigger?.classList.add('is-holding');
    this.coverTimer = window.setTimeout(() => {
      this.coverTimer = null;
      trigger?.classList.remove('is-holding');
      if (!current()) return;
      navigator.vibrate?.(20);
      if (pointer) {
        this.coverHoldCommitted = true;
        if (current()) void this.renderGateway({ trustedCoverActivation: true });
      } else void this.renderGateway({ trustedCoverActivation: true });
    }, duration);
  }

  private cancelCoverTimer(): void {
    if (this.coverTimer !== null) window.clearTimeout(this.coverTimer);
    this.coverTimer = null;
    if (this.coverRevealTimer !== null) window.clearTimeout(this.coverRevealTimer);
    this.coverRevealTimer = null;
    this.coverHoldCommitted = false;
    this.root.querySelector('.cover-trigger')?.classList.remove('is-holding', 'is-opening');
  }

  private async renderGateway({ trustedCoverActivation = false }: { trustedCoverActivation?: boolean } = {}): Promise<void> {
    this.cancelCoverTimer();
    this.expireIdleSession();
    const gatewayEpoch = ++this.gatewayRenderEpoch;
    const runtimeEpoch = this.runtimeEpoch;
    const entryEpoch = this.coverEntryEpoch;
    const canRender = () => {
      if (this.privacyCovered || this.gatewayRenderEpoch !== gatewayEpoch || this.runtimeEpoch !== runtimeEpoch) return false;
      if (document.hidden || (!trustedCoverActivation && !document.hasFocus()) || this.coverEntryEpoch !== entryEpoch) {
        this.lockNow();
        return false;
      }
      return true;
    };
    const retained = this.retainedSession;
    if (retained) {
      const epoch = this.runtimeEpoch;
      const entryEpoch = this.coverEntryEpoch;
      let resumed: VaultSession;
      try {
        // Another tab, reset or recovery can invalidate the cached snapshot.
        // Require normal verification in that case; never reopen stale MLS state.
        resumed = await resumeVaultSession(retained);
      } catch {
        if (this.retainedSession !== retained || this.runtimeEpoch !== epoch || this.coverEntryEpoch !== entryEpoch) return;
        this.lockNow();
        if (!document.hidden && document.hasFocus()) void this.renderGateway();
        return;
      }
      if (this.retainedSession !== retained || this.runtimeEpoch !== epoch || this.coverEntryEpoch !== entryEpoch || this.expireIdleSession() ||
          document.hidden || (!trustedCoverActivation && !document.hasFocus())) return;
      this.retainedSession = null;
      this.session = resumed;
      this.privacyCovered = false;
      document.body.className = 'app-mode';
      this.revealPrivacySurface();
      // Renew only after the hold has completed and expiry has been checked.
      this.resetIdleLock();
      try { await this.openSession(); }
      catch (cause) {
        if (this.isRuntimeActive(epoch, resumed)) this.fatalSecurityError(cause);
      }
      return;
    }
    this.privacyCovered = false;
    document.body.className = 'app-mode';
    const preparedStored = trustedCoverActivation ? this.coverStoredVault : null;
    this.coverStoredVault = null;
    if (preparedStored?.v === 3 && preparedStored.unlockMethod === 'platform') {
      // renderUnlock has no await when supplied a record. It mounts the retry
      // UI and starts navigator.credentials.get in this activation stack;
      // unlockVault still rereads and validates the current durable wrapper.
      void this.renderUnlock(preparedStored, true);
      return;
    }
    const hasVault = await hasStoredVault();
    if (!canRender()) return;
    if (hasVault) {
      const stored = await readStoredVault();
      if (!canRender()) return;
      if (!stored) this.renderCorruptVault();
      else void this.renderUnlock(stored, trustedCoverActivation);
    }
    else {
      const inviteLink = classifyInviteHash(location.hash);
      if (inviteLink.kind === 'device') this.renderJoinDevice(inviteLink.invite);
      else this.renderFirstRun(inviteLink.kind === 'participant' ? inviteLink.invite : null);
    }
  }

  private gatewayTemplate(title: string, subtitle: string, content: string, compact = false): void {
    this.root.innerHTML = `
      <section class="gateway${compact ? ' gateway-gesture' : ''}">
        ${compact ? '' : `<div class="gateway-mark" aria-hidden="true">${icons.lock}</div>`}
        <div class="gateway-heading">
          ${compact ? '' : '<p class="eyebrow">Quiet Room</p>'}
          <h1>${title}</h1>
          <p>${subtitle}</p>
        </div>
        ${content}
        ${compact ? '' : '<p class="privacy-note">通行密钥和解密密钥不会发送到服务器，丢失后无法代为找回。</p>'}
      </section>
    `;
  }

  private async renderUnlock(providedStored?: Awaited<ReturnType<typeof readStoredVault>>, trustedCoverActivation = false): Promise<void> {
    this.gatewayFocusAbort?.abort();
    this.gatewayFocusAbort = null;
    const renderEpoch = ++this.gatewayRenderEpoch;
    const runtimeEpoch = this.runtimeEpoch;
    const entryEpoch = this.coverEntryEpoch;
    const current = () => !this.privacyCovered && this.gatewayRenderEpoch === renderEpoch && this.runtimeEpoch === runtimeEpoch;
    const stored = providedStored ?? await readStoredVault();
    if (!current()) return;
    if (document.hidden || (!trustedCoverActivation && !document.hasFocus()) || this.coverEntryEpoch !== entryEpoch) {
      this.lockNow();
      return;
    }
    if (!stored) {
      this.renderCorruptVault();
      return;
    }
    if (stored.unlockMethod === 'recovery') {
      this.renderRecoveryUnlock();
      return;
    }
    if (stored.v === 1 && stored.unlockMethod !== 'gesture') {
      this.gatewayTemplate('升级旧保险库', '输入原本机密码。解锁后使用通行密钥完成一次性迁移。', `
        <form class="gateway-form" id="unlock-form">
          <label>旧本机密码<input name="password" type="password" autocomplete="current-password" required autofocus /></label>
          <p class="form-error" role="alert"></p>
          <button class="primary-button" type="submit">解锁并迁移</button>
        </form>
        <div class="gateway-secondary">
          <button class="text-button" id="back-to-cover" type="button">返回白屏</button>
        </div>
      `);
      const form = this.root.querySelector<HTMLFormElement>('#unlock-form')!;
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (this.unlocking) return;
        const button = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
        const error = form.querySelector<HTMLElement>('.form-error')!;
        let secret = formPassword(form);
        form.reset();
        error.textContent = '';
        setBusy(button, true, '正在解锁…');
        this.unlocking = true;
        try {
          const unlocked = await unlockVault(secret);
          secret = '';
          if (!current()) return;
          this.session = unlocked;
          this.renderPlatformMigration();
        } catch (cause) {
          secret = '';
          if (current()) {
            error.textContent = cause instanceof Error ? cause.message : '无法解锁';
            setBusy(button, false);
          }
        } finally {
          if (this.gatewayRenderEpoch === renderEpoch) this.unlocking = false;
        }
      });
    } else if (stored.v === 1 || stored.v === 2) {
      this.gatewayTemplate('升级设备保护', stored.v === 2
        ? '最后一次绘制原解锁手势。验证成功后，今后只需使用通行密钥。'
        : '绘制旧版手势，随后绑定通行密钥。', `
        ${this.legacyGestureUnlockMarkup('连接至少 4 个点。')}
        <div class="gateway-secondary">
          <button class="text-button" id="back-to-cover" type="button">返回白屏</button>
        </div>
      `, true);
      const error = this.root.querySelector<HTMLElement>('.form-error')!;
      const instruction = this.root.querySelector<HTMLElement>('.gesture-instruction')!;
      this.mountGesturePad((pattern) => {
        let secret: string;
        try {
          secret = gestureSecret(pattern);
        } catch (cause) {
          error.textContent = cause instanceof Error ? cause.message : '手势无法识别';
          return;
        }
        if (this.unlocking) return;
        this.unlocking = true;
        error.textContent = '';
        instruction.textContent = '正在验证手势…';
        void (async () => {
          try {
            const platformProof = stored.v === 2
              ? this.withDeviceVerification(() => unlockPlatformCredential(stored.platform))
              : undefined;
            // Attach a rejection observer immediately: vault lifecycle work
            // can delay the eventual await while the native sheet is open.
            void platformProof?.catch(() => undefined);
            const unlocked = await unlockVault(secret, platformProof);
            secret = '';
            if (!current()) return;
            this.session = unlocked;
            if (unlocked.stored.v === 1) this.renderPlatformMigration();
            else await this.openSession();
          } catch (cause) {
            secret = '';
            if (current()) {
              if (isPlatformVaultCancellation(cause)) {
                error.textContent = '';
                instruction.textContent = '验证已取消，请重新绘制手势重试。';
              } else {
                error.textContent = cause instanceof Error ? cause.message : '无法解锁';
                instruction.textContent = '请重新绘制手势。';
              }
            }
          } finally {
            if (this.gatewayRenderEpoch === renderEpoch) this.unlocking = false;
          }
        })();
      }, '解锁手势');
    } else {
      this.root.innerHTML = `<section class="gateway gateway-unlock" aria-label="解锁会话">
        <div class="credential-only-step credential-unlock-step">
          <button class="primary-button" id="passkey-unlock" type="button">使用通行密钥解锁</button>
          <p class="form-error" role="alert"></p>
        </div>
      </section>`;
      const button = this.root.querySelector<HTMLButtonElement>('#passkey-unlock')!;
      const error = this.root.querySelector<HTMLElement>('.form-error')!;
      const runUnlock = () => {
        if (this.unlocking || !current() || document.hidden || !button.isConnected) return;
        if (!document.hasFocus()) {
          // WebKit rejects an unfocused request before presenting native UI.
          // Keep this unauthenticated gateway usable, and start only once the
          // browser reports real focus. This is not a verification exemption:
          // hidden/pagehide/freeze/lock still tear down this pending intent.
          if (!this.gatewayFocusAbort) {
            const focusAbort = new AbortController();
            this.gatewayFocusAbort = focusAbort;
            window.addEventListener('focus', event => {
              if (event.target === window && document.hasFocus()) runUnlock();
            }, { capture: true, signal: focusAbort.signal });
            // Some Safari foreground returns update document.hasFocus()
            // without dispatching a window focus event. Observe that short
            // return edge so the trusted hold still starts verification. The
            // poll never calls WebAuthn while unfocused and expires after the
            // short return edge; the normal focus listener and retryable
            // button remain available without creating unbounded polling.
            const focusPoll = window.setInterval(() => {
              if (!current() || document.hidden || !button.isConnected) {
                focusAbort.abort();
                return;
              }
              if (document.hasFocus()) runUnlock();
            }, 16);
            const focusDeadline = window.setTimeout(() => {
              window.clearInterval(focusPoll);
            }, 1_500);
            focusAbort.signal.addEventListener('abort', () => {
              window.clearInterval(focusPoll);
              window.clearTimeout(focusDeadline);
            }, { once: true });
          }
          button.focus({ preventScroll: true });
          // Some browsers update hasFocus without a window focus event. Calling
          // runUnlock again also handles a synchronous focus event without a
          // duplicate request, since unlocking is checked above.
          if (document.hasFocus()) runUnlock();
          return;
        }
        this.gatewayFocusAbort?.abort();
        this.gatewayFocusAbort = null;
        this.unlocking = true;
        const abort = new AbortController();
        this.gatewayUnlockAbort = abort;
        error.textContent = '';
        setBusy(button, true, '正在验证…');
        void (async () => {
          try {
            // Start without another storage wait. Browser-owned sheet timing
            // is separate from invoking this request; teardown must cancel it
            // as well as rejecting its late result.
            const platformProof = this.withDeviceVerification(() => unlockPlatformCredential(stored.platform, abort.signal));
            void platformProof.catch(() => undefined);
            const unlocked = await unlockVault('', platformProof);
            if (!current()) return;
            this.session = unlocked;
            await this.openSession();
          } catch (cause) {
            if (current()) {
              if (isPlatformVaultCancellation(cause)) button.dataset.label = '重新验证';
              else error.textContent = cause instanceof Error ? cause.message : '无法解锁';
            }
          } finally {
            if (this.gatewayUnlockAbort === abort) this.gatewayUnlockAbort = null;
            if (this.gatewayRenderEpoch === renderEpoch) this.unlocking = false;
            if (button.isConnected) setBusy(button, false);
          }
        })();
      };
      button.addEventListener('click', runUnlock);
      if (trustedCoverActivation) runUnlock();
    }
    this.root.querySelector('#back-to-cover')?.addEventListener('click', () => this.lockNow());
  }

  private renderCorruptVault(): void {
    this.gatewayTemplate('本机数据需要恢复', '检测到本地保险库存在，但格式已经损坏或无法识别。不要直接清除浏览器数据。', `
      <div class="corrupt-vault-panel">
        <p class="form-error" role="alert">可使用恢复码读取自动备份；诊断文件不包含解密密钥或消息明文。</p>
        <button class="primary-button" id="corrupt-cloud-recovery" type="button">使用恢复码恢复</button>
        <button class="secondary-button" id="download-vault-diagnostic" type="button">下载诊断信息</button>
        <button class="text-button" id="clear-corrupt-vault" type="button">确认清除损坏的本机数据</button>
      </div>
      <div class="gateway-secondary"><button class="text-button" id="corrupt-vault-lock" type="button">返回白屏</button></div>
    `);
    this.root.querySelector('#corrupt-cloud-recovery')?.addEventListener('click', () => this.transitionPage('forward', () => this.renderCloudRecovery()));
    this.root.querySelector('#download-vault-diagnostic')?.addEventListener('click', () => {
      this.beginFileExport();
      void this.withSystemSurface(() => downloadVaultDiagnostic()).catch((cause) => this.showFormError(cause));
    });
    this.root.querySelector('#clear-corrupt-vault')?.addEventListener('click', async () => {
      if (!this.confirmSystemAction('确认清除损坏的本机数据？只有在你已经尝试恢复或确定不再需要它时才继续。')) return;
      try {
        await deleteCurrentVault();
        this.unreadCounter.clear();
        if (!this.privacyCovered) this.renderFirstRun(null);
      } catch (cause) {
        this.showFormError(cause);
      }
    });
    this.root.querySelector('#corrupt-vault-lock')?.addEventListener('click', () => this.lockNow());
  }

  private renderRecoveryUnlock(): void {
    const renderEpoch = ++this.gatewayRenderEpoch;
    const runtimeEpoch = this.runtimeEpoch;
    this.gatewayTemplate('恢复加密保险库', '输入这次恢复使用的恢复码，继续完成本设备绑定。', `
      <form class="gateway-form" id="recovery-code-form">
        <label>恢复码<textarea name="recovery-code" rows="3" autocomplete="off" spellcheck="false" required autofocus placeholder="QR3-…"></textarea></label>
        <p class="field-hint">恢复码不会发送到服务器。验证成功后，需要把保险库重新绑定到这台设备。</p>
        <p class="form-error" role="alert"></p>
        <button class="primary-button" type="submit">验证恢复码</button>
      </form>
      <div class="gateway-secondary"><button class="text-button" id="back-to-cover" type="button">返回白屏</button></div>
    `);
    const form = this.root.querySelector<HTMLFormElement>('#recovery-code-form')!;
    // A short mobile blur can be accepted without replacing this form even
    // though coverEntryEpoch advances. The mounted form plus gateway/runtime
    // identity owns the result; a real lock or rerender invalidates all three.
    const sameOperation = () => this.gatewayRenderEpoch === renderEpoch && this.runtimeEpoch === runtimeEpoch && form.isConnected;
    const current = () => sameOperation() && !this.privacyCovered && form.isConnected;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (this.unlocking) return;
      const button = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
      const error = form.querySelector<HTMLElement>('.form-error')!;
      let recoveryCode = String(new FormData(form).get('recovery-code') ?? '');
      form.reset();
      error.textContent = '';
      setBusy(button, true, '正在验证…');
      this.unlocking = true;
      try {
        const unlocked = await unlockRecoveryVault(recoveryCode);
        recoveryCode = '';
        if (!current()) return;
        this.session = unlocked;
        this.renderRecoveredVaultBinding();
      } catch (cause) {
        recoveryCode = '';
        if (current()) {
          error.textContent = cause instanceof Error ? cause.message : '恢复码验证失败';
          setBusy(button, false);
        }
      } finally {
        if (sameOperation()) this.unlocking = false;
      }
    });
    this.root.querySelector('#back-to-cover')?.addEventListener('click', () => this.lockNow());
  }

  private legacyGestureUnlockMarkup(instruction: string): string {
    return `
      <div class="gesture-block">
        <p class="gesture-instruction" role="status">${instruction}</p>
        <div class="gesture-host"></div>
        <p class="form-error" role="alert"></p>
      </div>
    `;
  }

  private mountGesturePad(onComplete: (pattern: number[]) => void, label: string): void {
    this.gesturePad?.destroy();
    const host = this.root.querySelector<HTMLElement>('.gesture-host');
    if (!host) return;
    this.gesturePad = new GesturePad(host, onComplete, label);
  }

  private passkeySetupMarkup(instruction = '通行密钥会使用系统生物识别或设备密码保护。'): string {
    return `
      <div class="credential-only-step">
        <p class="field-hint">${instruction}</p>
        <button class="primary-button" type="button" data-device-verify>设置通行密钥</button>
        <p class="form-error" role="alert"></p>
      </div>
    `;
  }

  private mountPasskeySetup(
    onConfirmed: (platformResult: PlatformCredentialResult) => Promise<void>,
    busyLabel: string,
  ): void {
    const verifyButton = this.root.querySelector<HTMLButtonElement>('[data-device-verify]')!;
    const error = this.root.querySelector<HTMLElement>('.form-error')!;
    let preparedPlatformCredential: PlatformCredentialResult | null = null;
    let createdPlatformRecord: PlatformCredentialRecord | null = null;
    let busy = false;
    verifyButton.addEventListener('click', () => {
      if (busy) return;
      const epoch = this.runtimeEpoch;
      const session = this.session;
      const active = () => verifyButton.isConnected && !this.privacyCovered && this.runtimeEpoch === epoch && this.session === session;
      busy = true;
      error.textContent = '';
      setBusy(verifyButton, true, preparedPlatformCredential ? '正在重试…' : '正在验证…');
      void (async () => {
        try {
          if (!preparedPlatformCredential) {
            preparedPlatformCredential = createdPlatformRecord
              ? {
                  record: createdPlatformRecord,
                  prfOutput: await this.withDeviceVerification(() => unlockPlatformCredential(createdPlatformRecord!)),
                }
              : await this.withDeviceVerification(() => createPlatformCredential(record => { createdPlatformRecord = record; }));
          }
          if (!active()) return;
          setBusy(verifyButton, true, busyLabel);
          await onConfirmed(preparedPlatformCredential);
        } catch (cause) {
          if (!active()) return;
          if (isPlatformVaultCancellation(cause)) verifyButton.dataset.label = '重新验证';
          else {
            error.textContent = cause instanceof Error ? cause.message : '通行密钥设置失败';
            if (preparedPlatformCredential) verifyButton.dataset.label = '重试';
          }
        } finally {
          busy = false;
          if (active()) setBusy(verifyButton, false);
        }
      })();
    });
  }

  private async withSystemSurface<T>(operation: () => Promise<T>): Promise<T> {
    const token = Symbol('system-surface');
    this.systemSurfaceTokens.add(token);
    try {
      return await operation();
    } finally {
      this.systemSurfaceTokens.delete(token);
    }
  }

  private nativeSurfaceActive(): boolean {
    return Boolean(this.nativeHandoff) || this.imagePickerActive || this.filePickerActive
      || this.fileExportActive || this.microphonePromptActive || this.callPermissionActive
      || this.systemSurfaceTokens.size > 0;
  }

  private beginMemePanelHandoff(button: HTMLButtonElement, event: PointerEvent): boolean {
    const previous = this.memePanelHandoff;
    if (previous) {
      if (previous.blurred) {
        this.invalidateMemePanelHandoff(previous);
        return false;
      }
      this.clearMemePanelHandoff();
    }
    if (!event.isTrusted || event.button !== 0 || !event.isPrimary || this.desktopBrowser
      || this.privacyCovered || !this.session || this.activeSurface !== 'chat'
      || document.hidden || !document.hasFocus() || !button.isConnected || button.disabled
      || this.nativeSurfaceActive() || this.expireIdleSession()) return false;
    if (this.blurLockTimer !== null) window.clearTimeout(this.blurLockTimer);
    this.blurLockTimer = null;
    const handoff = {
      deadline: performance.now() + MEME_PANEL_HANDOFF_MS,
      wallDeadline: Date.now() + MEME_PANEL_HANDOFF_MS,
      blurred: false,
      runtimeEpoch: this.runtimeEpoch,
      session: this.session,
      button,
      timer: 0,
    };
    handoff.timer = window.setTimeout(() => { this.expireMemePanelHandoff(handoff); }, MEME_PANEL_HANDOFF_MS);
    this.memePanelHandoff = handoff;
    return true;
  }

  private memePanelHandoffValid(handoff: NonNullable<QuietRoomApp['memePanelHandoff']>): boolean {
    return this.memePanelHandoff === handoff && handoff.runtimeEpoch === this.runtimeEpoch
      && handoff.session === this.session && !this.privacyCovered && this.activeSurface === 'chat'
      && !document.hidden && handoff.button.isConnected && !handoff.button.disabled && !this.nativeSurfaceActive();
  }

  private memePanelHandoffExpired(handoff: NonNullable<QuietRoomApp['memePanelHandoff']>): boolean {
    return performance.now() >= handoff.deadline || Date.now() >= handoff.wallDeadline;
  }

  private expireMemePanelHandoff(handoff: NonNullable<QuietRoomApp['memePanelHandoff']>): boolean {
    if (this.memePanelHandoff !== handoff || !this.memePanelHandoffExpired(handoff)) return false;
    this.invalidateMemePanelHandoff(handoff);
    return true;
  }

  private invalidateMemePanelHandoff(handoff = this.memePanelHandoff): boolean {
    if (!handoff || this.memePanelHandoff !== handoff) return false;
    const consumed = handoff.blurred;
    this.clearMemePanelHandoff();
    if (consumed && !this.privacyCovered && this.session) {
      this.obscurePrivacySurface();
      this.lockNow({ preserveFilePicker: false });
    }
    return consumed;
  }

  private consumeMemePanelHandoffBlur(): boolean {
    const handoff = this.memePanelHandoff;
    if (!handoff) return false;
    if (!this.memePanelHandoffValid(handoff) || document.hidden) {
      return this.invalidateMemePanelHandoff(handoff);
    }
    if (this.memePanelHandoffExpired(handoff)) {
      const consumed = handoff.blurred;
      this.expireMemePanelHandoff(handoff);
      return consumed;
    }
    if (handoff.blurred || this.expireIdleSession()) return false;
    handoff.blurred = true;
    return true;
  }

  private clearMemePanelHandoff(): void {
    const handoff = this.memePanelHandoff;
    if (!handoff) return;
    window.clearTimeout(handoff.timer);
    this.memePanelHandoff = null;
  }

  private beginKeyboardHandoff(input: HTMLTextAreaElement | HTMLInputElement, event: PointerEvent): boolean {
    const previous = this.keyboardHandoff;
    if (previous) {
      if (previous.blurred) {
        this.invalidateKeyboardHandoff(previous);
        return false;
      }
      this.clearKeyboardHandoff();
    }
    const layoutHeight = document.documentElement.clientHeight || window.innerHeight;
    const viewportHeight = Math.max(1, window.visualViewport?.height ?? window.innerHeight);
    const keyboardSpace = Math.max(0, layoutHeight - viewportHeight);
    if (!event.isTrusted || event.button !== 0 || !event.isPrimary || this.desktopBrowser
      || this.privacyCovered || !this.session || this.activeSurface !== 'chat'
      || document.hidden || !document.hasFocus() || !input.isConnected || input.disabled
      || document.documentElement.dataset.keyboardOpen === 'true' || keyboardSpace > 120
      || this.nativeSurfaceActive() || this.expireIdleSession()) return false;
    const handoff = {
      deadline: performance.now() + KEYBOARD_NATIVE_HANDOFF_MS,
      wallDeadline: Date.now() + KEYBOARD_NATIVE_HANDOFF_MS,
      blurred: false,
      runtimeEpoch: this.runtimeEpoch,
      session: this.session,
      input,
      viewportGeneration: this.visualViewportGeometryGeneration,
      baselineViewportHeight: viewportHeight,
      baselineLayoutHeight: layoutHeight,
      openingEvidence: false,
      timer: 0,
    };
    handoff.timer = window.setTimeout(() => { this.expireKeyboardHandoff(handoff); }, KEYBOARD_NATIVE_HANDOFF_MS);
    this.keyboardHandoff = handoff;
    return true;
  }

  private keyboardHandoffValid(handoff: NonNullable<QuietRoomApp['keyboardHandoff']>): boolean {
    return this.keyboardHandoff === handoff && handoff.runtimeEpoch === this.runtimeEpoch
      && handoff.session === this.session && !this.privacyCovered && this.activeSurface === 'chat'
      && handoff.input.isConnected && !handoff.input.disabled && !this.nativeSurfaceActive();
  }

  private keyboardHandoffExpired(handoff: NonNullable<QuietRoomApp['keyboardHandoff']>): boolean {
    return performance.now() >= handoff.deadline || Date.now() >= handoff.wallDeadline;
  }

  private expireKeyboardHandoff(handoff: NonNullable<QuietRoomApp['keyboardHandoff']>): boolean {
    if (this.keyboardHandoff !== handoff || !this.keyboardHandoffExpired(handoff)) return false;
    this.invalidateKeyboardHandoff(handoff);
    return true;
  }

  /**
   * A visible window blur spends the sole keyboard exception. From that point
   * on, losing its input/runtime/surface owner is a security failure, not an
   * unused-token cleanup. Clear first so the nested cover render cannot recurse.
   */
  private invalidateKeyboardHandoff(handoff = this.keyboardHandoff): boolean {
    if (!handoff || this.keyboardHandoff !== handoff) return false;
    const consumed = handoff.blurred;
    this.clearKeyboardHandoff();
    if (consumed && !this.privacyCovered && this.session) {
      this.obscurePrivacySurface();
      this.lockNow({ preserveFilePicker: false });
    }
    return consumed;
  }

  private consumeKeyboardHandoffBlur(): boolean {
    const handoff = this.keyboardHandoff;
    if (!handoff) return false;
    if (!this.keyboardHandoffValid(handoff) || document.hidden) {
      return this.invalidateKeyboardHandoff(handoff);
    }
    if (this.keyboardHandoffExpired(handoff)) {
      const consumed = handoff.blurred;
      this.expireKeyboardHandoff(handoff);
      return consumed;
    }
    if (handoff.blurred || document.activeElement !== handoff.input || this.expireIdleSession()) return false;
    handoff.blurred = true;
    // Some WebKit builds publish the keyboard viewport before transferring
    // window focus. The blur is still consumed once, but no token remains for
    // a later unrelated departure after both halves of the handoff are known.
    if (handoff.openingEvidence) this.clearKeyboardHandoff();
    return true;
  }

  private completeKeyboardHandoffFromViewport(sample: {
    generation: number;
    viewportHeight: number;
    layoutHeight: number;
  }): void {
    const handoff = this.keyboardHandoff;
    if (!handoff) return;
    if (!this.keyboardHandoffValid(handoff)) {
      this.invalidateKeyboardHandoff(handoff);
      return;
    }
    if (this.keyboardHandoffExpired(handoff)) {
      this.expireKeyboardHandoff(handoff);
      return;
    }
    const baselineKeyboardSpace = Math.max(0, handoff.baselineLayoutHeight - handoff.baselineViewportHeight);
    const keyboardSpace = Math.max(0, sample.layoutHeight - sample.viewportHeight);
    const freshGeometry = sample.generation > handoff.viewportGeneration
      && (Math.abs(sample.viewportHeight - handoff.baselineViewportHeight) > 1
        || Math.abs(sample.layoutHeight - handoff.baselineLayoutHeight) > 1);
    // Only geometry generated after the trusted tap can complete this owner.
    // Retain it until the matching blur if resize beats focus/blur ordering.
    if (!freshGeometry || baselineKeyboardSpace > 120 || keyboardSpace <= 120) return;
    handoff.openingEvidence = true;
    if (handoff.blurred) this.clearKeyboardHandoff();
  }

  private clearKeyboardHandoff(): void {
    const handoff = this.keyboardHandoff;
    if (!handoff) return;
    window.clearTimeout(handoff.timer);
    this.keyboardHandoff = null;
  }

  private beginNativeHandoff(kind: 'picker' | 'microphone' | 'camera', timeout: number): boolean {
    if (this.invalidateKeyboardHandoff()) return false;
    this.clearNativeHandoff();
    if (!this.session || this.privacyCovered || document.hidden || !document.hasFocus()) return false;
    const handoff = {
      kind,
      deadline: performance.now() + timeout,
      wallDeadline: Date.now() + timeout,
      blurred: false,
      timer: 0,
    };
    handoff.timer = window.setTimeout(() => {
      if (this.nativeHandoff !== handoff) return;
      if (!this.expireNativeHandoff(handoff)) {
        handoff.timer = window.setTimeout(() => {
          if (this.nativeHandoff === handoff) this.expireNativeHandoff(handoff);
        }, Math.max(0, Math.min(handoff.deadline - performance.now(), handoff.wallDeadline - Date.now())));
      }
    }, timeout);
    this.nativeHandoff = handoff;
    return true;
  }

  private nativeHandoffExpired(handoff: NonNullable<QuietRoomApp['nativeHandoff']>): boolean {
    return performance.now() >= handoff.deadline || Date.now() >= handoff.wallDeadline;
  }

  /**
   * Reject a handoff whose OS-owned timer may have been suspended. Once an
   * actual departure occurred, returning focus/result cannot revive the stale
   * exemption or retain a detached chooser selection.
   */
  private expireNativeHandoff(handoff: NonNullable<QuietRoomApp['nativeHandoff']>): boolean {
    if (this.nativeHandoff !== handoff || !this.nativeHandoffExpired(handoff)) return false;
    // Completion can run before a suspended timeout task after focus returns.
    // Expiry therefore invalidates and locks independently of current focus.
    const shouldLock = !this.privacyCovered && Boolean(this.session);
    this.clearNativeHandoff();
    if (handoff.kind === 'picker') this.abandonImagePicker();
    if (shouldLock) {
      this.obscurePrivacySurface();
      this.lockNow({ preserveFilePicker: false });
    }
    return true;
  }

  private consumeNativeHandoffBlur(): boolean {
    const handoff = this.nativeHandoff;
    if (!handoff || handoff.blurred || this.privacyCovered || !this.session || document.hidden || this.fileExportActive || this.systemSurfaceTokens.size > 0 ||
        this.nativeHandoffExpired(handoff) || this.expireIdleSession()) return false;
    handoff.blurred = true;
    return true;
  }

  private clearNativeHandoff(kind?: 'picker' | 'microphone' | 'camera', invalidated = true): void {
    if (!this.nativeHandoff || (kind && this.nativeHandoff.kind !== kind)) return;
    const handoff = this.nativeHandoff;
    window.clearTimeout(handoff.timer);
    this.nativeHandoff = null;
    handoff.settle?.(invalidated);
    handoff.settle = undefined;
  }

  private finishNativeHandoff(kind: 'picker' | 'microphone' | 'camera'): Promise<boolean> {
    const handoff = this.nativeHandoff;
    if (!handoff || handoff.kind !== kind) return Promise.resolve(false);
    if (this.expireNativeHandoff(handoff)) return Promise.resolve(true);
    if (!document.hidden && document.hasFocus()) {
      this.clearNativeHandoff(kind, false);
      return Promise.resolve(false);
    }
    if (document.hidden) {
      handoff.deadline = 0;
      handoff.wallDeadline = 0;
      this.expireNativeHandoff(handoff);
      return Promise.resolve(true);
    }
    if (handoff.settling) return handoff.settling;
    // change / getUserMedia resolution can precede the native focus event.
    // Hold the selected file or stream outside the app until focus is proven.
    window.clearTimeout(handoff.timer);
    const hardDeadline = handoff.deadline;
    const hardWallDeadline = handoff.wallDeadline;
    handoff.deadline = Math.min(hardDeadline, performance.now() + 250);
    handoff.wallDeadline = Math.min(hardWallDeadline, Date.now() + 250);
    handoff.settling = new Promise<boolean>((resolve) => {
      let settled = false;
      let focusPoll = 0;
      const finish = (invalidated: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(handoff.timer);
        window.clearInterval(focusPoll);
        window.removeEventListener('focus', onReturn, true);
        document.removeEventListener('visibilitychange', onReturn, true);
        resolve(invalidated);
      };
      const evaluate = () => {
        if (this.nativeHandoff !== handoff) {
          finish(true);
          return;
        }
        const hardExpired = performance.now() >= hardDeadline || Date.now() >= hardWallDeadline;
        const returnEdgeExpired = this.nativeHandoffExpired(handoff);
        // Check both clocks before accepting focus. A suspended event loop
        // must not infer that focus returned inside this 250 ms edge merely
        // from the state observed several seconds later.
        if (hardExpired || returnEdgeExpired || document.hidden) {
          handoff.deadline = 0;
          handoff.wallDeadline = 0;
          this.expireNativeHandoff(handoff);
          finish(true);
          return;
        }
        // Some UAs update hasFocus without delivering a focus event. Poll only
        // while this short edge is live; a normal return is usually resolved
        // immediately by the focus listener above.
        if (document.hasFocus()) {
          this.clearNativeHandoff(kind, false);
          finish(false);
        }
      };
      const onReturn = () => evaluate();
      window.addEventListener('focus', onReturn, { capture: true });
      document.addEventListener('visibilitychange', onReturn, { capture: true });
      handoff.settle = finish;
      focusPoll = window.setInterval(evaluate, 16);
      handoff.timer = window.setTimeout(() => {
        evaluate();
      }, 250);
      evaluate();
    });
    return handoff.settling;
  }

  private setMediaPermission(kind: 'microphone' | 'camera', active: boolean): Promise<boolean> {
    if (kind === 'microphone') this.microphonePromptActive = active;
    else this.callPermissionActive = active;
    if (active) {
      return Promise.resolve(!this.beginNativeHandoff(kind, 30_000));
    }
    return this.finishNativeHandoff(kind);
  }

  private confirmSystemAction(message: string): boolean {
    const epoch = this.runtimeEpoch;
    const token = Symbol('system-confirmation');
    this.systemSurfaceTokens.add(token);
    try {
      const confirmed = window.confirm(message);
      return confirmed && this.runtimeEpoch === epoch && !this.privacyCovered;
    } finally {
      this.systemSurfaceTokens.delete(token);
    }
  }

  private async clearPendingUploadPlans(): Promise<void> {
    const session = this.session;
    const plans = [...this.uploadPlans];
    if (!session || plans.length === 0 || this.privacyCovered) return;
    if (!this.confirmSystemAction('清除本机待续传记录？已上传的分块不会形成消息，之后可重新选择文件上传。')) return;
    const epoch = this.runtimeEpoch;
    try {
      for (const plan of plans) {
        await deleteUploadPlan(session, plan.blobId);
        if (!this.isRuntimeActive(epoch, session)) return;
      }
      const cleared = new Set(plans.map(plan => plan.blobId));
      this.uploadPlans = this.uploadPlans.filter(plan => !cleared.has(plan.blobId));
      this.renderChat();
      this.showNotice('已清除待续传记录');
    } catch (cause) {
      if (!this.isRuntimeActive(epoch, session)) return;
      this.showNotice(cause instanceof Error ? cause.message : '清除待续传记录失败，请稍后重试', 'error');
    }
  }

  private async withDeviceVerification<T>(operation: () => Promise<T>): Promise<T> {
    // Recovery/migration have decrypted key material but have not opened a
    // conversation or socket. Their native prompt needs the same bounded
    // protection as first-time enrollment. Never exempt an open conversation.
    if (this.session && (!this.root.querySelector('.gateway') || this.socket)) return operation();
    const epoch = this.runtimeEpoch;
    const token = Symbol('device-verification');
    const timeout = 65_000;
    this.deviceVerificationFocusSettle?.(false);
    this.deviceVerificationFocusSettle = null;
    this.deviceVerificationToken = token;
    this.deviceVerificationActive = true;
    this.deviceVerificationDeadline = performance.now() + timeout;
    this.deviceVerificationWallDeadline = Date.now() + timeout;
    const timer = window.setTimeout(() => {
      if (this.deviceVerificationToken !== token) return;
      this.expireDeviceVerification(true);
    }, timeout);
    try {
      const result = await operation();
      if (this.deviceVerificationToken !== token || this.runtimeEpoch !== epoch || this.privacyCovered ||
          performance.now() >= this.deviceVerificationDeadline || Date.now() >= this.deviceVerificationWallDeadline) {
        if (this.deviceVerificationToken === token) this.expireDeviceVerification(true);
        throw new DOMException('设备验证流程已经结束', 'AbortError');
      }
      return result;
    } finally {
      window.clearTimeout(timer);
      if (this.deviceVerificationToken !== token) {
        // Never allow an already computed credential/PRF result to cross a
        // manual lock, pagehide, freeze, timeout, or replacement ceremony.
        throw new DOMException('设备验证流程已经结束', 'AbortError');
      }
      if (!document.hidden && !document.hasFocus()) {
        const returned = await this.waitForDeviceVerificationFocus(token);
        if (!returned) {
          if (this.deviceVerificationToken === token) this.expireDeviceVerification(true);
          throw new DOMException('设备验证流程已经结束', 'AbortError');
        }
      }
      if (this.deviceVerificationToken !== token) {
        throw new DOMException('设备验证流程已经结束', 'AbortError');
      } else if (performance.now() >= this.deviceVerificationDeadline || Date.now() >= this.deviceVerificationWallDeadline ||
            document.hidden || !document.hasFocus()) {
          this.expireDeviceVerification(true);
          throw new DOMException('设备验证流程已经结束', 'AbortError');
      } else {
          this.deviceVerificationToken = null;
          this.deviceVerificationActive = false;
          this.deviceVerificationDeadline = 0;
          this.deviceVerificationWallDeadline = 0;
          if (document.hidden) this.lockNow({ preserveFilePicker: false });
          else if (document.hasFocus()) this.revealPrivacySurface();
      }
    }
  }

  private waitForDeviceVerificationFocus(token: symbol): Promise<boolean> {
    if (this.deviceVerificationToken !== token || document.hidden || document.hasFocus()) {
      return Promise.resolve(this.deviceVerificationToken === token && !document.hidden && document.hasFocus());
    }
    return new Promise(resolve => {
      let timer = 0;
      let focusPoll = 0;
      let settled = false;
      // iOS Safari can resolve WebAuthn before it reports that the document
      // regained focus. Keep the gateway obscured while waiting for that real
      // focus edge; lifecycle teardown and the outer 65-second bound still win.
      const deadline = performance.now() + DEVICE_VERIFICATION_FOCUS_RETURN_MS;
      const wallDeadline = Date.now() + DEVICE_VERIFICATION_FOCUS_RETURN_MS;
      const finish = (valid = true) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        window.clearInterval(focusPoll);
        window.removeEventListener('focus', onReturn, true);
        document.removeEventListener('visibilitychange', onReturn, true);
        if (this.deviceVerificationFocusSettle === finish) this.deviceVerificationFocusSettle = null;
        resolve(valid && performance.now() < deadline && Date.now() < wallDeadline
          && this.deviceVerificationToken === token && !document.hidden && document.hasFocus());
      };
      const evaluate = () => {
        if (this.deviceVerificationToken !== token || document.hidden || performance.now() >= deadline || Date.now() >= wallDeadline) {
          finish(false);
        } else if (document.hasFocus()) finish(true);
      };
      const onReturn = () => evaluate();
      window.addEventListener('focus', onReturn, { capture: true });
      document.addEventListener('visibilitychange', onReturn, { capture: true });
      this.deviceVerificationFocusSettle = finish;
      focusPoll = window.setInterval(evaluate, 16);
      timer = window.setTimeout(() => finish(false), DEVICE_VERIFICATION_FOCUS_RETURN_MS);
      evaluate();
    });
  }

  private expireDeviceVerification(force = false): boolean {
    if (!this.deviceVerificationActive || !this.deviceVerificationToken) return false;
    if (!force && performance.now() < this.deviceVerificationDeadline && Date.now() < this.deviceVerificationWallDeadline) return false;
    this.deviceVerificationFocusSettle?.(false);
    this.deviceVerificationFocusSettle = null;
    this.deviceVerificationToken = null;
    this.deviceVerificationActive = false;
    this.deviceVerificationDeadline = 0;
    this.deviceVerificationWallDeadline = 0;
    this.obscurePrivacySurface();
    this.lockNow({ preserveFilePicker: false });
    return true;
  }

  private renderPlatformMigration(): void {
    if (!this.session) return;
    this.gatewayTemplate('绑定这台设备', '以后只需使用通行密钥或生物识别。', `
      ${this.passkeySetupMarkup()}
      <button class="text-button gateway-back" id="migration-lock" type="button">取消并锁定</button>
    `);
    this.mountPasskeySetup(async (platformResult) => {
      const session = this.session;
      if (!session) return;
      await migrateVaultToPlatform(session, '', platformResult);
      if (!this.privacyCovered && this.session === session) await this.openSession();
    }, '正在绑定…');
    this.root.querySelector('#migration-lock')?.addEventListener('click', () => this.lockNow());
  }

  private renderRecoveredVaultBinding(): void {
    if (!this.session) return;
    this.gatewayTemplate('重新绑定设备', '为这台设备创建新的通行密钥保护。', `
      ${this.passkeySetupMarkup()}
      <button class="text-button gateway-back" id="recovery-lock" type="button">取消并锁定</button>
    `);
    this.mountPasskeySetup(async (platformResult) => {
      const session = this.session;
      if (!session) return;
      await bindRecoveredVaultToPlatform(session, '', platformResult);
      if (!this.privacyCovered && this.session === session) await this.openSession();
    }, '正在绑定…');
    this.root.querySelector('#recovery-lock')?.addEventListener('click', () => this.lockNow());
  }

  private renderFirstRun(invite: Invite | null): void {
    if (invite) {
      this.renderJoin(invite);
      return;
    }
    this.gatewayTemplate('建立私密会话', '两位参与者可各自安全使用最多三台设备。', `
      <div class="choice-stack">
        <button class="choice-row" id="create-room" type="button">
          <span><strong>创建会话</strong><small>生成一次性邀请，等待另一位参与者加入</small></span>
          <span aria-hidden="true">→</span>
        </button>
        <button class="choice-row" id="join-room" type="button">
          <span><strong>使用邀请加入</strong><small>粘贴另一台设备发来的邀请链接</small></span>
          <span aria-hidden="true">→</span>
        </button>
        <button class="choice-row" id="restore-cloud" type="button">
          <span><strong>恢复已有会话</strong><small>使用恢复码读取自动加密备份</small></span><span aria-hidden="true">→</span>
        </button>
      </div>
      <p class="form-error" role="alert"></p>
    `);
    this.root.querySelector('#create-room')?.addEventListener('click', () => this.transitionPage('forward', () => this.renderCreate()));
    this.root.querySelector('#join-room')?.addEventListener('click', () => this.transitionPage('forward', () => this.renderPasteInvite()));
    this.root.querySelector('#restore-cloud')?.addEventListener('click', () => this.transitionPage('forward', () => this.renderCloudRecovery()));
  }

  private renderCreate(): void {
    this.gatewayTemplate('创建会话', '使用系统通行密钥保护这台设备。', `
      ${this.passkeySetupMarkup()}
      <button class="text-button gateway-back" type="button">返回</button>
    `);
    this.mountPasskeySetup(
      (platformResult) => this.handleCreate(platformResult),
      '正在创建会话…',
    );
    this.root.querySelector('.gateway-back')?.addEventListener('click', () => this.transitionPage('backward', () => this.renderFirstRun(null)));
  }

  private async handleCreate(platformResult: PlatformCredentialResult): Promise<void> {
    const epoch = this.runtimeEpoch;
    const initialSession = this.session;
    const active = () => !this.privacyCovered && this.runtimeEpoch === epoch && this.session === initialSession;
    let room: { roomId: string; createdAt: string; protocol: 'legacy-v1' | 'mls-rfc9420' } | null = null;
    let vaultCreated = false;
    const accessToken = randomBase64Url(32);
    const inviteToken = randomBase64Url(32);
    try {
      const identity = await generateIdentity();
      if (!active()) return;
      const pairingSecret = randomBase64Url(32);
      room = await createRoom(
        identity.publicBundle,
        accessToken,
        inviteToken,
        defaultDeviceName(),
        CLIENT_CAPABILITIES,
      );
      if (room.protocol !== 'mls-rfc9420') {
        throw new SecurityViolation('服务器未按 MLS 协议创建会话，已拒绝继续');
      }
      const creatorFingerprint = await bundleFingerprint(identity.publicBundle);
      const creator: RoomMember = {
        ...identity.publicBundle,
        role: 'creator',
        joinProof: null,
        deviceName: defaultDeviceName(),
        status: 'active',
        addedBy: null,
        joinSeq: 0,
        joinReceiptSeq: 0,
        capabilities: CLIENT_CAPABILITIES,
        createdAt: room.createdAt,
      };
      const vault: Vault = {
        v: 3,
        roomId: room.roomId,
        accessToken,
        inviteToken,
        role: 'creator',
        pairingSecret,
        creatorFingerprint,
        identity,
        members: [creator],
        lastSeq: 0,
        lastReceiptSeq: 0,
        pairingState: 'ready',
        createdAt: room.createdAt,
        protocol: 'mls-rfc9420',
      };
      vault.mls = await createCreatorMlsState(room.roomId, identity, [creator]);
      identity.mlsPrivatePackage = undefined;
      const createdSession = await createVault(vault, '', 'platform', platformResult, active);
      vaultCreated = true;
      if (!active()) return;
      this.session = createdSession;
      await this.openSession();
    } catch (cause) {
      // Once the vault is durable, preserve the room so a transient local/network
      // failure can be retried instead of deleting a valid session on the server.
      if (room && !vaultCreated) {
        const persisted = await readStoredVault().catch(() => null);
        if (!persisted) await deleteRoom(room.roomId, accessToken).catch(() => undefined);
      }
      if (!active()) return;
      throw cause;
    }
  }

  private renderPasteInvite(): void {
    this.gatewayTemplate('使用邀请加入', '粘贴完整邀请链接。邀请中的密钥片段不会作为 HTTP 参数发送。', `
      <form class="gateway-form" id="paste-form">
        <label for="invite-input">邀请链接<textarea id="invite-input" name="invite" rows="4" inputmode="url" required aria-describedby="invite-error" autofocus></textarea></label>
        <p class="form-error" id="invite-error" role="alert"></p>
        <button class="primary-button" type="submit">继续</button>
      </form>
      <button class="text-button gateway-back" type="button">返回</button>
    `);
    const form = this.root.querySelector<HTMLFormElement>('#paste-form')!;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const parsed = parseInviteText(String(new FormData(form).get('invite') ?? ''), location.href);
      if (parsed.kind === 'invalid') {
        const input = form.querySelector<HTMLTextAreaElement>('#invite-input')!;
        input.setAttribute('aria-invalid', 'true');
        form.querySelector<HTMLElement>('#invite-error')!.textContent = '邀请链接无法识别';
        input.focus();
        return;
      }
      form.querySelector<HTMLTextAreaElement>('#invite-input')?.removeAttribute('aria-invalid');
      this.transitionPage('forward', () => {
        if (parsed.kind === 'device') this.renderJoinDevice(parsed.invite);
        else this.renderJoin(parsed.invite);
      });
    });
    this.root.querySelector('.gateway-back')?.addEventListener('click', () => this.transitionPage('backward', () => this.renderFirstRun(null)));
  }

  private renderJoin(invite: Invite): void {
    this.gatewayTemplate('加入会话', '使用系统通行密钥保护这台设备。', `
      ${this.passkeySetupMarkup()}
      <button class="text-button gateway-back" type="button">返回</button>
    `);
    this.mountPasskeySetup(
      (platformResult) => this.handleJoin(invite, platformResult),
      '正在加入会话…',
    );
    this.root.querySelector('.gateway-back')?.addEventListener('click', () => this.transitionPage('backward', () => this.renderFirstRun(null)));
  }

  private async handleJoin(
    invite: Invite,
    platformResult: PlatformCredentialResult,
  ): Promise<void> {
    const epoch = this.runtimeEpoch;
    const initialSession = this.session;
    const active = () => !this.privacyCovered && this.runtimeEpoch === epoch && this.session === initialSession;
    try {
      const initialState = await getRoomState(invite.roomId, invite.accessToken);
      if (!active()) return;
      const creator = initialState.members.find((member) => member.role === 'creator');
      if (!creator || await bundleFingerprint(memberBundle(creator)) !== invite.creatorFingerprint) {
        throw new Error('创建者身份与邀请不一致，已拒绝加入');
      }
      if (initialState.members.length !== 1) {
        throw new Error('这是一次性参与者邀请，已经封存，不能用于添加设备。请在已有设备中重新生成设备链接');
      }
      if (initialState.protocol !== 'legacy-v1' && initialState.protocol !== 'mls-rfc9420') {
        throw new SecurityViolation('服务器没有声明受支持的会话加密协议');
      }
      if (initialState.protocol === 'mls-rfc9420' && !creator.mlsKeyPackage) {
        throw new SecurityViolation('MLS 会话的创建者密钥包缺失');
      }
      const identity = await generateIdentity();
      const deviceAccessToken = randomBase64Url(32);
      const proof = await createJoinProof(invite.pairingSecret, identity.publicBundle);
      const provisionalJoiner: RoomMember = {
        ...identity.publicBundle,
        role: 'joiner',
        joinProof: proof,
        deviceName: defaultDeviceName(),
        status: 'active',
        addedBy: null,
        joinSeq: 0,
        joinReceiptSeq: 0,
        capabilities: CLIENT_CAPABILITIES,
        createdAt: new Date().toISOString(),
      };
      const vault: Vault = {
        v: 3,
        roomId: invite.roomId,
        accessToken: deviceAccessToken,
        inviteToken: invite.accessToken,
        role: 'joiner',
        pairingSecret: invite.pairingSecret,
        creatorFingerprint: invite.creatorFingerprint,
        identity,
        members: [creator, provisionalJoiner],
        lastSeq: 0,
        lastReceiptSeq: 0,
        pairingState: 'joining',
        createdAt: new Date().toISOString(),
        protocol: initialState.protocol,
        ...(initialState.protocol === 'mls-rfc9420'
          ? { mls: { protocol: 'mls-rfc9420' as const, phase: 'awaiting-welcome' as const } }
          : {}),
      };
      if (initialState.protocol === 'legacy-v1') identity.mlsPrivatePackage = undefined;
      const createdSession = await createVault(vault, '', 'platform', platformResult, active);
      if (!active()) return;
      this.session = createdSession;
      history.replaceState(null, '', `${location.pathname}${location.search}`);
      await this.completePendingJoin();
      if (!this.isRuntimeActive(epoch, createdSession)) return;
      await this.openSession();
    } catch (cause) {
      if (this.privacyCovered || this.runtimeEpoch !== epoch) return;
      if (this.session?.vault.pairingState === 'joining') {
        history.replaceState(null, '', `${location.pathname}${location.search}`);
        this.renderPendingJoin(cause);
        return;
      }
      throw cause;
    }
  }

  private renderJoinDevice(invite: DeviceInvite): void {
    this.gatewayTemplate('添加这台设备', '新设备会生成独立密钥，只能读取获准加入之后的新消息。', `
      ${this.passkeySetupMarkup()}
      <p class="form-note">完成后，请回到已有设备核对六位安全码并批准加入。</p>
      <button class="text-button gateway-back" type="button">返回</button>
    `);
    this.mountPasskeySetup(
      (platformResult) => this.handleJoinDevice(invite, platformResult),
      '正在生成独立设备密钥…',
    );
    this.root.querySelector('.gateway-back')?.addEventListener('click', () => {
      history.replaceState(null, '', `${location.pathname}${location.search}`);
      this.renderFirstRun(null);
    });
  }

  private async handleJoinDevice(
    invite: DeviceInvite,
    platformResult: PlatformCredentialResult,
  ): Promise<void> {
    const epoch = this.runtimeEpoch;
    const initialSession = this.session;
    const active = () => !this.privacyCovered && this.runtimeEpoch === epoch && this.session === initialSession;
    const status = await getDeviceLinkStatus(invite.linkId, invite.secret);
    if (!active()) return;
    if (Date.parse(invite.expiresAt) <= Date.now() || status.link.usedAt || status.link.claimedDeviceId) {
      throw new Error('这条设备链接已经失效或被另一台设备领取，请在已有设备中重新生成');
    }
    if (
      status.link.roomId !== invite.roomId ||
      status.link.role !== invite.role ||
      status.link.authorizerId !== invite.authorizerId ||
      status.link.expiresAt !== invite.expiresAt
    ) {
      throw new SecurityViolation('设备链接与服务器状态不一致');
    }
    const authorizer = status.state.members.find((member) => member.deviceId === invite.authorizerId);
    const creator = status.state.members.find((member) => member.role === 'creator' && !member.addedBy);
    if (
      !authorizer ||
      await bundleFingerprint(memberBundle(authorizer)) !== invite.authorizerFingerprint ||
      !creator ||
      await bundleFingerprint(memberBundle(creator)) !== invite.creatorFingerprint
    ) throw new SecurityViolation('已有设备身份与设备链接不一致');
    const identity = await generateIdentity();
    const accessToken = randomBase64Url(32);
    const createdAt = new Date().toISOString();
    const own: RoomMember = {
      ...identity.publicBundle,
      role: invite.role,
      joinProof: null,
      deviceName: defaultDeviceName(),
      status: 'pending',
      addedBy: invite.authorizerId,
      joinSeq: 0,
      joinReceiptSeq: 0,
      revokedAt: null,
      capabilities: CLIENT_CAPABILITIES,
      createdAt,
    };
    const vault: Vault = {
      v: 3,
      roomId: invite.roomId,
      accessToken,
      role: invite.role,
      pairingSecret: '',
      creatorFingerprint: invite.creatorFingerprint,
      identity,
      members: [...status.state.members, own],
      lastSeq: 0,
      lastReceiptSeq: 0,
      pairingState: 'linking',
      historyUnavailableBeforeSeq: 0,
      createdAt,
      protocol: 'mls-rfc9420',
      mls: { protocol: 'mls-rfc9420', phase: 'awaiting-welcome', lastEventSeq: status.state.nextMlsEventSeq ?? 0 },
      pendingDeviceLinks: [{ linkId: invite.linkId, secret: invite.secret, expiresAt: invite.expiresAt, createdAt }],
      pendingDeviceLinkId: invite.linkId,
    };
    const createdSession = await createVault(vault, '', 'platform', platformResult, active);
    if (!active()) return;
    this.session = createdSession;
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    try {
      await this.completePendingDeviceLink();
      if (!this.isRuntimeActive(epoch, createdSession)) return;
      if (createdSession.vault.pairingState === 'ready') await this.openSession();
      else await this.renderPendingDeviceLink();
    } catch (cause) {
      if (!this.isRuntimeActive(epoch, createdSession)) return;
      await this.renderPendingDeviceLink(cause);
    }
  }

  private async completePendingDeviceLink(): Promise<void> {
    const session = this.session;
    if (!session || session.vault.pairingState !== 'linking') return;
    const epoch = this.runtimeEpoch;
    const pending = session.vault.pendingDeviceLinks?.find((item) => item.linkId === session.vault.pendingDeviceLinkId);
    if (!pending) throw new SecurityViolation('本机设备链接凭据缺失');
    let result = await getDeviceLinkStatus(pending.linkId, pending.secret, session.vault.accessToken);
    if (!this.isRuntimeActive(epoch, session)) return;
    let own = result.state.members.find((member) => member.deviceId === session.vault.identity.publicBundle.deviceId);
    if (!own) {
      result = await claimDeviceLink(
        pending.linkId,
        pending.secret,
        session.vault.identity.publicBundle,
        session.vault.accessToken,
        defaultDeviceName(),
        CLIENT_CAPABILITIES,
      );
      if (!this.isRuntimeActive(epoch, session)) return;
      own = result.state.members.find((member) => member.deviceId === session.vault.identity.publicBundle.deviceId);
    }
    if (!own || canonicalStringify(memberBundle(own)) !== canonicalStringify(session.vault.identity.publicBundle)) {
      throw new SecurityViolation('服务器返回的新设备身份与本机密钥不一致');
    }
    await withVaultMutation(session, async (mutation) => {
      if (!this.isRuntimeActive(epoch, session)) return;
      await this.applyRoomState(result.state, mutation);
      if (!this.isRuntimeActive(epoch, session)) return;
      own = session.vault.members.find((member) => member.deviceId === session.vault.identity.publicBundle.deviceId);
      if (own?.status !== 'active' || session.vault.mls?.phase !== 'active') return;
      session.vault.historyUnavailableBeforeSeq = own.joinSeq ?? result.state.nextSeq;
      session.vault.lastSeq = Math.max(session.vault.lastSeq, session.vault.historyUnavailableBeforeSeq);
      session.vault.lastReceiptSeq = Math.max(session.vault.lastReceiptSeq ?? 0, own.joinReceiptSeq ?? 0);
      session.vault.pairingState = 'ready';
      session.vault.pendingDeviceLinks = undefined;
      session.vault.pendingDeviceLinkId = undefined;
      await saveVault(session, mutation);
    });
  }

  private async renderPendingDeviceLink(cause?: unknown): Promise<void> {
    const session = this.session;
    const epoch = this.runtimeEpoch;
    if (!session || this.privacyCovered) return;
    const pending = session.vault.pendingDeviceLinks?.find((item) => item.linkId === session.vault.pendingDeviceLinkId);
    const own = session.vault.members.find((member) => member.deviceId === session.vault.identity.publicBundle.deviceId);
    const authorizer = session.vault.members.find((member) => member.deviceId === own?.addedBy);
    const code = pending && own && authorizer ? await deviceLinkSafetyCode(pending.linkId, authorizer, own) : '无法计算';
    if (!this.isRuntimeActive(epoch, session)) return;
    this.gatewayTemplate('等待已有设备批准', '两台设备显示相同安全码时，才可以在已有设备上允许加入。', `
      <div class="device-safety-code" aria-label="设备安全码">${code}</div>
      <p class="form-error" role="alert"></p>
      <button class="primary-button" id="retry-device-link" type="button">检查批准状态</button>
      <button class="text-button" id="pending-device-lock" type="button">锁定并返回白屏</button>
    `);
    const error = this.root.querySelector<HTMLElement>('.form-error');
    if (error) error.textContent = cause instanceof Error ? cause.message : '';
    this.root.querySelector('#retry-device-link')?.addEventListener('click', async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      setBusy(button, true, '正在检查…');
      try {
        await this.completePendingDeviceLink();
        if (!this.isRuntimeActive(epoch, session) || !button.isConnected) return;
        if (session.vault.pairingState === 'ready') await this.openSession();
        else await this.renderPendingDeviceLink();
      } catch (retryCause) {
        if (this.isRuntimeActive(epoch, session) && button.isConnected) await this.renderPendingDeviceLink(retryCause);
      }
    });
    this.root.querySelector('#pending-device-lock')?.addEventListener('click', () => this.lockNow());
  }

  private async completePendingRecovery(): Promise<void> {
    const session = this.session;
    const pending = session?.vault.pendingRecovery;
    if (!session || !pending || session.vault.pairingState !== 'recovering') return;
    const epoch = this.runtimeEpoch;
    const signal = this.runtimeAbort?.signal;
    let result: { state: RoomState };
    try {
      result = await recoveryStatus(session.vault.roomId, pending.request.requestId, session.vault.accessToken, signal);
    } catch (cause) {
      if (!this.isRuntimeActive(epoch, session)) return;
      if (cause instanceof ApiError && cause.status >= 500) throw cause;
      result = await requestRecovery(session.vault.roomId, pending.request, session.vault.accessToken,
        defaultDeviceName(), CLIENT_CAPABILITIES, signal);
    }
    if (!this.isRuntimeActive(epoch, session)) return;
    await withVaultMutation(session, async (mutation) => {
      if (!this.isRuntimeActive(epoch, session) || !session.vault.pendingRecovery) return;
      await verifyRecoveryMembershipChain(session.vault, result.state);
      const ownEvent = result.state.mlsEvents?.find(({ event }) => event.action === 'replace' &&
        event.targetId === session.vault.identity.publicBundle.deviceId &&
        event.recoveryRequest?.requestId === pending.request.requestId);
      if (!ownEvent) return;
      if (canonicalStringify(ownEvent.event.recoveryRequest) !== canonicalStringify(pending.request)) {
        throw new SecurityViolation('恢复授权与本机保存的请求不一致');
      }
      const own = result.state.members.find((member) => member.deviceId === session.vault.identity.publicBundle.deviceId);
      if (!own || own.status !== 'active' || !Number.isSafeInteger(own.joinSeq) || !Number.isSafeInteger(own.joinReceiptSeq)) {
        throw new SecurityViolation('恢复设备尚未获得有效的加入边界');
      }
      const nextVault: Vault = {
        ...session.vault,
        identity: structuredClone(session.vault.identity),
        members: result.state.members,
        mls: { protocol: 'mls-rfc9420', phase: 'awaiting-welcome', lastEventSeq: ownEvent.eventSeq - 1 },
      };
      nextVault.mls = await joinMlsMembership(nextVault, ownEvent.event, ownEvent.eventSeq);
      for (const subsequent of [...(result.state.mlsEvents ?? [])].sort((a, b) => a.eventSeq - b.eventSeq)) {
        if (subsequent.eventSeq <= ownEvent.eventSeq) continue;
        nextVault.mls.groupState = await processMlsMembership(nextVault, subsequent.event, subsequent.eventSeq);
        nextVault.mls.lastEventSeq = subsequent.eventSeq;
      }
      nextVault.identity.mlsPrivatePackage = undefined;
      nextVault.lastSeq = own.joinSeq!;
      nextVault.lastReceiptSeq = own.joinReceiptSeq!;
      nextVault.historyUnavailableBeforeSeq = own.joinSeq!;
      nextVault.pairingState = 'ready';
      nextVault.pendingRecovery = undefined;
      nextVault.recoveryExportedAt = undefined;
      nextVault.pairingSecret = '';
      nextVault.inviteToken = undefined;
      if (this.isRuntimeActive(epoch, session)) await finishVaultRecovery(session, nextVault, mutation);
    });
  }

  private renderPendingRecovery(cause?: unknown): void {
    const session = this.session;
    if (!session || this.privacyCovered) return;
    const epoch = this.runtimeEpoch;
    this.gatewayTemplate('等待安全恢复', '请让对方或另一台已授权设备打开会话。在线设备会验证恢复包授权，并为本机建立全新的加密身份。', `
      <div class="credential-only-step">
        <p class="field-hint">恢复成功后会生成新恢复码。历史消息和保险箱需要使用新码主动恢复，原设备将退出。</p>
        <p class="form-error" id="recovery-wait-error" role="status"></p>
        <button class="primary-button" id="retry-recovery" type="button">检查恢复进度</button>
        <button class="text-button" id="restart-recovery" type="button" disabled>请求过期后重新读取备份</button>
        <button class="text-button" id="pending-recovery-lock" type="button">锁定并返回白屏</button>
      </div>
    `);
    const error = this.root.querySelector<HTMLElement>('#recovery-wait-error')!;
    const restart = this.root.querySelector<HTMLButtonElement>('#restart-recovery')!;
    restart.disabled = !(cause instanceof ApiError && cause.code === 'RECOVERY_EXPIRED');
    error.textContent = cause instanceof Error ? cause.message : '等待另一台已授权设备在线…';
    const check = async () => {
      if (!this.isRuntimeActive(epoch, session)) return;
      if (this.recoveryPollTimer !== null) window.clearTimeout(this.recoveryPollTimer);
      this.recoveryPollTimer = null;
      const button = this.root.querySelector<HTMLButtonElement>('#retry-recovery');
      if (!button || button.disabled) return;
      setBusy(button, true, '正在检查…');
      try {
        await this.completePendingRecovery();
        if (!this.isRuntimeActive(epoch, session)) return;
        if (session.vault.pairingState !== 'recovering') {
          await this.openSession();
          this.showNotice('设备身份已恢复，请完成新恢复码保护');
          return;
        }
      } catch (nextCause) {
        if (this.isRuntimeActive(epoch, session) && error.isConnected) {
          error.textContent = nextCause instanceof Error ? nextCause.message : '恢复状态暂时不可用';
          restart.disabled = !(nextCause instanceof ApiError && nextCause.code === 'RECOVERY_EXPIRED');
        }
      } finally {
        if (button.isConnected) setBusy(button, false);
      }
      if (this.isRuntimeActive(epoch, session) && session.vault.pairingState === 'recovering') {
        this.recoveryPollTimer = window.setTimeout(() => void check(), 3000);
      }
    };
    this.root.querySelector('#retry-recovery')?.addEventListener('click', () => void check());
    this.root.querySelector('#pending-recovery-lock')?.addEventListener('click', () => this.lockNow());
    restart.addEventListener('click', async () => {
      if (restart.disabled || !this.isRuntimeActive(epoch, session)) return;
      restart.disabled = true;
      try {
        // A lost success response must not discard the only replacement key.
        await this.completePendingRecovery();
        if (this.isRuntimeActive(epoch, session)) await this.openSession();
      } catch (retryCause) {
        if (!this.isRuntimeActive(epoch, session)) return;
        if (retryCause instanceof ApiError && retryCause.code === 'RECOVERY_EXPIRED') {
          await deleteCurrentVault();
          this.unreadCounter.clear();
          if (this.isRuntimeActive(epoch, session)) this.lockNow();
        } else if (error.isConnected) {
          error.textContent = retryCause instanceof Error ? retryCause.message : '暂时无法确认恢复状态，请保留本机数据后重试';
        }
      }
    });
    this.recoveryPollTimer = window.setTimeout(() => void check(), 1500);
  }

  private async completeAuthorizedRecoveries(state: RoomState): Promise<void> {
    const session = this.session;
    const epoch = this.runtimeEpoch;
    if (!session || session.vault.mls?.phase !== 'active') return;
    for (const request of state.recoveryRequests ?? []) {
      if (request.sourceDeviceId === session.vault.identity.publicBundle.deviceId ||
        request.replacement.deviceId === session.vault.identity.publicBundle.deviceId) continue;
      const target = state.members.find((member) => member.deviceId === request.replacement.deviceId);
      if (!target || target.status !== 'pending') continue;
      try {
        await withVaultMutation(session, async (mutation) => {
          if (!this.isRuntimeActive(epoch, session) || !session.vault.mls) return;
          let pending = session.vault.mls.pendingMembership;
          if (pending && (pending.event.action !== 'replace' || pending.event.recoveryRequest?.requestId !== request.requestId)) return;
          if (!pending) {
            pending = await prepareMlsRecoveryReplacement(session.vault, request, target);
            session.vault.mls.pendingMembership = pending;
            await saveVault(session, mutation);
          }
          const result = await publishMlsMembership(session.vault.roomId, session.vault.accessToken, pending.event);
          if (this.isRuntimeActive(epoch, session)) await this.applyRoomState(result.state, mutation);
        });
      } catch (cause) {
        if (!this.isRuntimeActive(epoch, session)) return;
        if (cause instanceof ApiError && !cause.retryable) {
          await withVaultMutation(session, async (mutation) => {
            if (!this.isRuntimeActive(epoch, session) || !session.vault.mls) return;
            session.vault.mls.pendingMembership = undefined;
            await saveVault(session, mutation);
          });
        } else throw cause;
      }
    }
  }

  private async openSession(): Promise<void> {
    const session = this.session;
    if (!session || this.privacyCovered) return;
    // Re-opening after an archive restore first commits any already hydrated
    // UI state. A first unlock (or a lock racing this read) must never persist
    // the in-memory empty default over an unread encrypted preference record.
    if (this.uiPreferencesHydrated) {
      if (this.preferenceSaveTimer !== null) window.clearTimeout(this.preferenceSaveTimer);
      this.preferenceSaveTimer = null;
      this.flushUiPreferencesSave();
    }
    this.uiPreferencesHydrated = false;
    const epoch = this.runtimeEpoch;
    this.runtimeAbort?.abort();
    this.runtimeAbort = new AbortController();
    this.resetIdleLock();
    if (session.vault.pairingState === 'recovering') {
      try {
        await this.completePendingRecovery();
      } catch (cause) {
        if (this.isRuntimeActive(epoch, session)) this.renderPendingRecovery(cause);
        return;
      }
      if (!this.isRuntimeActive(epoch, session)) return;
      if (session.vault.pairingState === 'recovering') {
        this.renderPendingRecovery();
        return;
      }
    }
    if (session.vault.recoverySource || session.vault.backup?.newCodePending) {
      this.renderRecoveryRotation();
      return;
    }
    const configureUnread = () => {
      if (!this.isRuntimeActive(epoch, session) || (session.vault.pairingState && session.vault.pairingState !== 'ready')) return;
      void this.unreadCounter.ensureConfigured(session.vault, this.runtimeAbort?.signal).then(ready => {
        if (!ready || !this.isRuntimeActive(epoch, session)) return;
        this.markVisibleMessagesRead();
        void this.unreadCounter.refresh();
      });
    };
    // History loading may fail or take time. Register the count-only observer
    // first so the loading-failure cover can still receive unread updates.
    configureUnread();
    await this.preferenceSaveChain.catch(() => undefined);
    if (!this.isRuntimeActive(epoch, session)) return;
    const preferences = await loadUiPreferences(session);
    if (!this.isRuntimeActive(epoch, session)) return;
    this.uiPreferences = preferences;
    this.uiPreferencesHydrated = true;
    // Projection events can sit far beyond a restored reading anchor. Start
    // their encrypted scan alongside the visible-page work and do not expose
    // chat rows until tombstones are known; otherwise a previously deleted
    // target can flash on screen between unlock and the trailing event scan.
    const messageEventsPromise = loadMessageEventHistory(session, { signal: this.runtimeAbort.signal });
    const anchor = this.uiPreferences.chatAnchor;
    const beforeSeq = anchor && !anchor.pinnedToBottom
      ? Math.min(Number.MAX_SAFE_INTEGER, anchor.seq + 101)
      : undefined;
    const initialPage = await loadHistoryPage(session, { limit: 200, ...(beforeSeq ? { beforeSeq } : {}), signal: this.runtimeAbort.signal });
    if (!this.isRuntimeActive(epoch, session)) return;
    const pages = [initialPage];
    let page = initialPage;
    let historyHasMore = page.length >= 200 && Math.min(...page.map(message => message.seq)) > 1;
    // Reaction/gallery events share the encrypted stream. An all-hidden tail
    // has no scrollbar, so fill backwards until there is a chat row to show.
    while (historyHasMore && !page.some(message => message.payload.kind !== 'gallery-image' && message.payload.kind !== 'gallery-file'
      && message.payload.kind !== 'reaction' && message.payload.kind !== 'message-delete' && message.payload.kind !== 'media-read' && message.payload.kind !== 'message-read')) {
      page = await loadHistoryPage(session, { limit: 200, beforeSeq: Math.min(...page.map(message => message.seq)), signal: this.runtimeAbort.signal });
      if (!this.isRuntimeActive(epoch, session)) return;
      pages.unshift(page);
      historyHasMore = page.length >= 200 && Math.min(...page.map(message => message.seq)) > 1;
    }
    const cached = pages.flat();
    this.messages = new Map(cached.map((message) => [message.seq, {
      ...message,
      status: message.status === 'sent'
        ? (message.senderId === session.vault.identity.publicBundle.deviceId ? 'stored' : 'delivered')
        : message.status,
    }]));
    this.historyHasMore = historyHasMore;
    this.historyForwardCursor = cached.length > 0
      ? Math.max(...cached.map((message) => message.seq))
      : session.vault.historyUnavailableBeforeSeq ?? 0;
    this.historyHasNewer = this.historyForwardCursor < session.vault.lastSeq;
    let contiguousSeq = session.vault.historyUnavailableBeforeSeq ?? 0;
    while (this.messages.has(contiguousSeq + 1)) contiguousSeq += 1;
    const [outbox, pendingReceipts, uploadPlans, messageEvents] = await Promise.all([
      loadOutbox(session),
      loadPendingReceipts(session),
      loadUploadPlans(session),
      messageEventsPromise,
    ]);
    if (!this.isRuntimeActive(epoch, session)) return;
    this.outbox = new Map(outbox.map((item) => [item.clientMsgId, item]));
    this.pending = new Map(outbox.map((item) => [item.clientMsgId, {
      seq: Number.MAX_SAFE_INTEGER,
      clientMsgId: item.clientMsgId,
      senderId: session.vault.identity.publicBundle.deviceId,
      payload: item.payload,
      acceptedAt: item.createdAt,
      status: 'pending' as const,
    }]));
    this.pendingReceipts = new Map(pendingReceipts.map((receipt) => [receipt.clientMsgId, receipt]));
    this.uploadPlans = uploadPlans;
    this.messageEventHistory = new Map(messageEvents.map(message => [message.seq, message]));
    this.restoreChatAnchorOnNextRender = true;
    await withVaultMutation(session, async (mutation) => {
      if (!this.isRuntimeActive(epoch, session)) return;
      session.vault.lastSeq = Math.max(session.vault.lastSeq, contiguousSeq);
      session.vault.lastReceiptSeq ??= 0;
      await saveVault(session, mutation);
    });
    if (!this.isRuntimeActive(epoch, session)) return;
    if (session.vault.pairingState === 'joining') {
      try {
        await this.completePendingJoin();
      } catch (cause) {
        if (this.isRuntimeActive(epoch, session)) this.renderPendingJoin(cause);
        return;
      }
    }
    if (!this.isRuntimeActive(epoch, session)) return;
    if (session.vault.pairingState === 'linking') {
      try {
        await this.completePendingDeviceLink();
      } catch (cause) {
        if (this.isRuntimeActive(epoch, session)) await this.renderPendingDeviceLink(cause);
        return;
      }
      if (!this.isRuntimeActive(epoch, session)) return;
      if (session.vault.pairingState === 'linking') {
        await this.renderPendingDeviceLink();
        return;
      }
    }
    if (!this.isRuntimeActive(epoch, session)) return;
    const activeRoles = new Set(session.vault.members.filter((member) => member.status !== 'pending' && member.status !== 'revoked').map((member) => member.role));
    if (activeRoles.size < 2) this.renderInviteWait();
    else this.renderChat();
    configureUnread();
    void this.connectSocket().catch(cause => { if (this.isRuntimeActive(epoch, session)) this.operationalError(cause, '安全通话身份准备失败，请重新解锁'); });
    if (activeRoles.size === 2) void this.resumeDeferredImage();
    this.startAutomaticBackup();
  }

  private async completePendingJoin(): Promise<void> {
    const session = this.session;
    if (!session || session.vault.role !== 'joiner') return;
    const epoch = this.runtimeEpoch;
    const ownMember = session.vault.members.find((member) =>
      member.deviceId === session.vault.identity.publicBundle.deviceId,
    );
    if (!ownMember?.joinProof) throw new SecurityViolation('本机待加入凭据不完整');
    const state = await joinRoom(
      session.vault.roomId,
      session.vault.inviteToken ?? session.vault.accessToken,
      session.vault.identity.publicBundle,
      ownMember.joinProof,
      session.vault.accessToken,
      ownMember.deviceName ?? defaultDeviceName(),
      CLIENT_CAPABILITIES,
    );
    if (!this.isRuntimeActive(epoch, session)) return;
    await withVaultMutation(session, async (mutation) => {
      if (!this.isRuntimeActive(epoch, session)) return;
      await this.applyRoomState(state, mutation);
      if (!this.isRuntimeActive(epoch, session)) return;
      session.vault.pairingState = 'ready';
      session.vault.inviteToken = undefined;
      await saveVault(session, mutation);
    });
  }

  private renderPendingJoin(cause?: unknown): void {
    const session = this.session;
    const epoch = this.runtimeEpoch;
    if (!session || this.privacyCovered) return;
    if (!this.setActiveSurface('away')) return;
    document.body.className = 'app-mode';
    this.gatewayTemplate('正在完成设备绑定', '本机密钥已经安全保存。网络恢复后可使用同一身份继续，不会占用新的名额。', `
      <div class="pending-join-panel">
        <p class="form-error" role="alert" id="pending-join-error"></p>
        <button class="primary-button" id="retry-join" type="button">继续完成绑定</button>
        <button class="text-button" id="pending-lock" type="button">锁定并返回白屏</button>
      </div>
    `);
    const error = this.root.querySelector<HTMLElement>('#pending-join-error')!;
    error.textContent = cause instanceof Error
      ? cause.message
      : '绑定尚未完成';
    this.root.querySelector('#retry-join')?.addEventListener('click', async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      setBusy(button, true, '正在重试…');
      try {
        await this.completePendingJoin();
        if (!this.isRuntimeActive(epoch, session) || !button.isConnected) return;
        await this.openSession();
      } catch (retryCause) {
        if (!this.isRuntimeActive(epoch, session) || !error.isConnected) return;
        error.textContent = retryCause instanceof Error
          ? retryCause.message
          : '绑定失败，请检查网络后重试';
        setBusy(button, false);
      }
    });
    this.root.querySelector('#pending-lock')?.addEventListener('click', () => this.lockNow());
  }

  private applyRoomStateQueued(state: RoomState): Promise<void> {
    const session = this.session;
    const epoch = this.runtimeEpoch;
    const operation = this.membershipChain.catch(() => undefined).then(async () => {
      if (!session || !this.isRuntimeActive(epoch, session)) return;
      await withVaultMutation(session, async (mutation) => {
        if (this.isRuntimeActive(epoch, session)) await this.applyRoomState(state, mutation);
      });
    });
    this.membershipChain = operation.catch(() => undefined);
    return operation;
  }

  private async applyRoomState(state: RoomState, mutation: VaultMutation): Promise<void> {
    const session = this.session;
    if (!session || state.roomId !== session.vault.roomId) throw new SecurityViolation('会话状态不匹配');
    const localProtocol = session.vault.protocol ?? 'legacy-v1';
    if (state.protocol !== localProtocol) {
      throw new SecurityViolation('服务器返回的加密协议与本机保险库不一致，已停止连接');
    }
    if (localProtocol === 'mls-rfc9420' && !session.vault.mls) {
      throw new SecurityViolation('本机 MLS 状态缺失，已停止连接');
    }
    const epoch = this.runtimeEpoch;
    const previousMembers = session.vault.members;
    const creator = state.members.find((member) => member.role === 'creator' && !member.addedBy);
    if (!creator || await bundleFingerprint(memberBundle(creator)) !== session.vault.creatorFingerprint) {
      throw new SecurityViolation('服务器返回的创建者身份已改变，已停止连接');
    }
    if (!this.isRuntimeActive(epoch, session)) return;
    const ownStored = session.vault.identity.publicBundle;
    const ownRemote = state.members.find((member) => member.deviceId === ownStored.deviceId);
    if (!ownRemote || ownRemote.status === 'revoked' || canonicalStringify(memberBundle(ownRemote)) !== canonicalStringify(ownStored)) {
      throw new SecurityViolation('服务器返回的本设备公钥已改变，已停止连接');
    }
    for (const known of previousMembers) {
      const remote = state.members.find((member) => member.deviceId === known.deviceId);
      if (remote && (remote.role !== known.role || (remote.addedBy ?? null) !== (known.addedBy ?? null) || canonicalStringify(memberBundle(remote)) !== canonicalStringify(memberBundle(known)))) {
        throw new SecurityViolation('已知设备身份发生变化，已停止连接');
      }
    }
    const originalJoiner = state.members.find((member) => member.role === 'joiner' && Boolean(member.joinProof));
    let verifiedOriginalJoiner = false;
    if (originalJoiner && session.vault.pairingSecret) {
      if (!originalJoiner.joinProof || !(await verifyJoinProof(
        session.vault.pairingSecret,
        memberBundle(originalJoiner),
        originalJoiner.joinProof,
      ))) throw new SecurityViolation('加入设备未通过邀请密钥验证，已停止连接');
      verifiedOriginalJoiner = true;
    }
    if (!this.isRuntimeActive(epoch, session)) return;
    if (
      session.vault.pairingState === 'linking' &&
      localProtocol === 'mls-rfc9420' &&
      session.vault.mls &&
      !session.vault.mls.groupState
    ) {
      const ownAdd = (state.mlsEvents ?? []).find((item) =>
        item.event.action === 'add' && item.event.targetId === ownStored.deviceId,
      );
      session.vault.mls.lastEventSeq = ownAdd ? ownAdd.eventSeq - 1 : (state.nextMlsEventSeq ?? 0);
    }
    session.vault.members = state.members;
    if (localProtocol === 'mls-rfc9420' && session.vault.mls) {
      const trustedDeviceIds = new Set(previousMembers
        .filter((member) => member.status === undefined || member.status === 'active')
        .map((member) => member.deviceId));
      const expectedMembers = new Map(previousMembers.filter(member => member.status === undefined || member.status === 'active').map(member => [member.deviceId, member]));
      if (verifiedOriginalJoiner && originalJoiner) {
        expectedMembers.set(originalJoiner.deviceId, originalJoiner);
        trustedDeviceIds.add(originalJoiner.deviceId);
      }
      for (const serverEvent of [...(state.mlsEvents ?? [])].sort((left, right) => left.eventSeq - right.eventSeq)) {
        const lastEventSeq = session.vault.mls.lastEventSeq ?? 0;
        if (serverEvent.eventSeq <= lastEventSeq) continue;
        if (serverEvent.eventSeq !== lastEventSeq + 1 || !trustedDeviceIds.has(serverEvent.event.senderId)) {
          throw new SecurityViolation('MLS 设备变更链不连续或发送者不可信');
        }
        const pending = session.vault.mls.pendingMembership;
        if (pending && pending.event.eventId === serverEvent.event.eventId) {
          if (canonicalStringify(pending.event) !== canonicalStringify(serverEvent.event)) {
            throw new SecurityViolation('服务器返回的 MLS 设备变更与本机提交不一致');
          }
          session.vault.mls.groupState = pending.nextGroupState;
          session.vault.mls.pendingMembership = undefined;
          session.vault.mls.phase = 'active';
        } else if (
          serverEvent.event.action === 'add' &&
          serverEvent.event.targetId === ownStored.deviceId &&
          !session.vault.mls.groupState
        ) {
          session.vault.mls = await joinMlsMembership(session.vault, serverEvent.event, serverEvent.eventSeq);
          session.vault.identity.mlsPrivatePackage = undefined;
        } else {
          session.vault.mls.groupState = await processMlsMembership(session.vault, serverEvent.event, serverEvent.eventSeq);
          session.vault.mls.phase = 'active';
        }
        session.vault.mls.lastEventSeq = serverEvent.eventSeq;
        if (serverEvent.event.action === 'add') {
          trustedDeviceIds.add(serverEvent.event.targetId);
          if (!serverEvent.event.target) throw new SecurityViolation('设备加入证明缺少公钥');
          expectedMembers.set(serverEvent.event.targetId, { ...serverEvent.event.target, status: 'active' });
        }
        else if (serverEvent.event.action === 'replace') {
          if (!serverEvent.event.replacedDeviceId || !trustedDeviceIds.has(serverEvent.event.replacedDeviceId)) {
            throw new SecurityViolation('恢复替换的原设备不在可信成员中');
          }
          trustedDeviceIds.delete(serverEvent.event.replacedDeviceId);
          trustedDeviceIds.add(serverEvent.event.targetId);
          expectedMembers.delete(serverEvent.event.replacedDeviceId);
          if (!serverEvent.event.target) throw new SecurityViolation('设备替换证明缺少公钥');
          expectedMembers.set(serverEvent.event.targetId, { ...serverEvent.event.target, status: 'active' });
        } else {
          trustedDeviceIds.delete(serverEvent.event.targetId);
          expectedMembers.delete(serverEvent.event.targetId);
        }
      }
      if ((state.nextMlsEventSeq ?? 0) !== (session.vault.mls.lastEventSeq ?? 0)) {
        throw new SecurityViolation('服务器未提供完整的 MLS 设备变更记录');
      }
      try { assertAuthenticatedRoomRoster([...expectedMembers.values()], state.members); }
      catch { throw new SecurityViolation('设备名单与已验证的加密成员不一致，已停止连接'); }
    }
    session.vault.protocol = localProtocol;
    const activeRoles = new Set(state.members.filter((member) => member.status === 'active').map((member) => member.role));
    if (activeRoles.size === 2) {
      session.vault.inviteToken = undefined;
      session.vault.pairingSecret = '';
    }
    await saveVault(session, mutation);
  }

  private isRuntimeActive(epoch: number, session: VaultSession): boolean {
    return !this.privacyCovered && this.runtimeEpoch === epoch && this.session === session;
  }

  private async connectSocket(): Promise<void> {
    const session = this.session;
    if (!session || this.privacyCovered) return;
    const epoch = this.runtimeEpoch;
    const callIdentity = session.vault.protocol === 'mls-rfc9420' ? await signCallIdentityAttestation(session.vault) : undefined;
    if (!this.isRuntimeActive(epoch, session)) return;
    this.socket?.close();
    this.ensureCallController();
    const roomSocket = new RoomSocket(
      session.vault.roomId,
      session.vault.accessToken,
      () => session.vault.lastSeq,
      () => session.vault.lastReceiptSeq ?? 0,
      {
        connection: (state) => {
          if (!this.isRuntimeActive(epoch, session) || this.socket !== roomSocket) return;
          this.connectionState = state;
          this.callController?.setConnection(state === 'connected');
          if (state !== 'connected') this.rolePresence = null;
          this.updateConnectionStatus();
        },
        presence: (roles, lastSeen) => {
          if (!this.isRuntimeActive(epoch, session) || this.socket !== roomSocket) return;
          this.rolePresence = roles;
          this.roleLastSeen = lastSeen;
          this.updatePeerStatus();
        },
        ready: (state) => {
          if (this.isRuntimeActive(epoch, session) && this.socket === roomSocket) return this.handleMembership(state);
        },
        membership: (state) => {
          if (this.isRuntimeActive(epoch, session) && this.socket === roomSocket) return this.handleMembership(state);
        },
        call: (envelope) => {
          if (this.isRuntimeActive(epoch, session) && this.socket === roomSocket) return this.callController?.receive(envelope);
        },
        callTransport: code => this.callController?.signalingFailure(code),
        callState: (event) => {
          if (this.isRuntimeActive(epoch, session) && this.socket === roomSocket) this.callController?.serverEvent(event);
        },
        message: (message) => {
          if (!this.isRuntimeActive(epoch, session) || this.socket !== roomSocket) return;
          this.livePresenceMessages.add(message);
          this.serverQueue.set(message.seq, message);
          if (new Set(this.session?.vault.members.filter((member) => member.status !== 'pending' && member.status !== 'revoked').map((member) => member.role)).size === 2) {
            void this.drainServerQueue();
          }
        },
        sync: (messages) => {
          if (!this.isRuntimeActive(epoch, session) || this.socket !== roomSocket) return;
          for (const message of messages) this.serverQueue.set(message.seq, message);
          void this.drainServerQueue(messages.length === 500);
        },
        receipt: (receipt) => {
          if (!this.isRuntimeActive(epoch, session) || this.socket !== roomSocket) return;
          this.receiptQueue.set(receipt.receiptSeq, receipt);
          void this.drainReceiptQueue();
        },
        receiptSync: (receipts) => {
          if (!this.isRuntimeActive(epoch, session) || this.socket !== roomSocket) return;
          for (const receipt of receipts) this.receiptQueue.set(receipt.receiptSeq, receipt);
          void this.drainReceiptQueue(receipts.length === 500);
        },
        ack: (clientMsgId, seq) => {
          if (!this.isRuntimeActive(epoch, session) || this.socket !== roomSocket) return;
          this.clearRetry(clientMsgId);
          const item = this.pending.get(clientMsgId);
          if (item) item.status = 'stored';
          this.renderMessages();
          void this.reconcileMessageAck(clientMsgId, seq, roomSocket, epoch, session);
        },
        receiptAck: (clientMsgId) => {
          if (this.isRuntimeActive(epoch, session) && this.socket === roomSocket) void this.acknowledgeReceipt(clientMsgId);
        },
        error: async (message, code, clientMsgId, rejectedEnvelope) => {
          if (!this.isRuntimeActive(epoch, session) || this.socket !== roomSocket) return;
          if (code === 'MLS_EPOCH_STALE' && clientMsgId) {
            if (!rejectedEnvelope) {
              this.fatalSecurityError(new SecurityViolation('服务器拒绝了无法绑定到已发送密文的消息，已停止继续推进加密状态'));
              return;
            }
            try {
              await this.reencryptOutboxItem(clientMsgId, rejectedEnvelope);
              return;
            } catch (cause) {
              this.operationalError(cause, '设备状态已更新，但待发消息重新加密失败');
              return;
            }
          }
          this.showNotice(message, 'error');
          if (code?.startsWith('INVALID_') || code === 'MESSAGE_CONFLICT' || code === 'RECEIPT_CONFLICT') {
            this.fatalSecurityError(new SecurityViolation(message));
          }
        },
      },
      session.vault.identity.publicBundle.deviceId,
      CLIENT_CAPABILITIES,
      callIdentity,
    );
    this.socket = roomSocket;
    roomSocket.setChatPresence(this.activeSurface === 'chat' && !this.root.classList.contains('portrait-blocked'));
    roomSocket.connect();
  }

  private async reconcileMessageAck(
    clientMsgId: string,
    seq: number,
    roomSocket: RoomSocket,
    epoch: number,
    session: VaultSession,
  ): Promise<void> {
    if (!this.isRuntimeActive(epoch, session) || this.socket !== roomSocket || !this.outbox.has(clientMsgId)) return;
    if (!Number.isSafeInteger(seq) || seq < 1) {
      this.fatalSecurityError(new SecurityViolation('服务器返回了无效的消息确认序号'));
      return;
    }
    if (seq > session.vault.lastSeq) {
      roomSocket.requestSync(session.vault.lastSeq);
      if (this.outbox.has(clientMsgId)) this.scheduleRetry(clientMsgId);
      return;
    }
    let removed = false;
    try {
      await withVaultMutation(session, async (mutation) => {
        if (!this.isRuntimeActive(epoch, session) || this.socket !== roomSocket) return;
        const queued = this.outbox.get(clientMsgId);
        if (!queued) return;
        const stored = await loadHistoryMessage(session, seq, this.runtimeAbort?.signal);
        if (!stored || stored.clientMsgId !== clientMsgId ||
          stored.senderId !== session.vault.identity.publicBundle.deviceId ||
          canonicalStringify(stored.payload) !== canonicalStringify(queued.payload)) {
          throw new SecurityViolation('服务器消息确认与本机已存加密历史不一致');
        }
        await deleteOutboxItem(session, clientMsgId, mutation);
        removed = true;
      });
      if (!removed || !this.isRuntimeActive(epoch, session) || this.socket !== roomSocket) return;
      this.clearRetry(clientMsgId);
      this.outbox.delete(clientMsgId);
      this.pending.delete(clientMsgId);
      this.renderMessages();
    } catch (cause) {
      if (!this.isRuntimeActive(epoch, session) || this.socket !== roomSocket) return;
      if (cause instanceof SecurityViolation) this.fatalSecurityError(cause);
      else {
        this.operationalError(cause, '已确认消息的本机待发记录未能清理，将继续重试');
        if (this.outbox.has(clientMsgId)) this.scheduleRetry(clientMsgId);
      }
    }
  }

  private async handleMembership(state: RoomState): Promise<void> {
    const session = this.session;
    if (!session) return;
    const epoch = this.runtimeEpoch;
    try {
      const before = new Set(session.vault.members.filter((member) => member.status !== 'pending' && member.status !== 'revoked').map((member) => member.role)).size;
      const mlsWasReady = session.vault.protocol !== 'mls-rfc9420' || session.vault.mls?.phase === 'active';
      await this.applyRoomStateQueued(state);
      if (!this.isRuntimeActive(epoch, session)) return;
      await this.ensureMlsReady(state);
      if (!this.isRuntimeActive(epoch, session)) return;
      if (session.vault.protocol === 'mls-rfc9420' && session.vault.mls?.phase === 'active') {
        try {
          const callVault = await createAuthenticatedCallVault(session.vault);
          if (!this.isRuntimeActive(epoch, session)) return;
          this.callVault = callVault;
        } catch { throw new SecurityViolation('通话设备身份无法通过加密群组验证'); }
      }
      this.callController?.updateMembers();
      this.updateCallControls();
      await this.completeAuthorizedRecoveries(state);
      if (!this.isRuntimeActive(epoch, session)) return;
      const mlsBecameReady = !mlsWasReady && session.vault.mls?.phase === 'active';
      const activeRoleCount = new Set(state.members.filter((member) => member.status === undefined || member.status === 'active').map((member) => member.role)).size;
      if ((before < 2 && activeRoleCount === 2) || mlsBecameReady) {
        this.renderChat();
        this.socket?.requestSync(session.vault.lastSeq);
      }
      await this.drainServerQueue();
      await this.drainReceiptQueue();
      await this.resumeOutbox();
      await this.resendPendingReceipts();
      this.updatePeerStatus();
    } catch (cause) {
      if (!this.isRuntimeActive(epoch, session)) return;
      if (cause instanceof SecurityViolation) this.fatalSecurityError(cause);
      else this.operationalError(cause);
    }
  }

  private async ensureMlsReady(state: RoomState): Promise<void> {
    const session = this.session;
    const epoch = this.runtimeEpoch;
    if (!session) return;
    await withVaultMutation(session, async (mutation) => {
      if (this.isRuntimeActive(epoch, session)) await this.ensureMlsReadyLocked(state, mutation);
    });
  }

  private async ensureMlsReadyLocked(state: RoomState, mutation: VaultMutation): Promise<void> {
    const session = this.session;
    if (!session || session.vault.protocol !== 'mls-rfc9420' || !session.vault.mls) return;
    if (session.vault.role === 'creator') {
      if (state.mlsWelcome) {
        const pending = session.vault.mls.pendingWelcome;
        if (pending && canonicalStringify(pending) !== canonicalStringify(state.mlsWelcome)) {
          throw new SecurityViolation('服务器返回了与本机不一致的 MLS 欢迎消息');
        }
        if (pending) {
          session.vault.mls = { ...session.vault.mls, pendingWelcome: undefined };
          await saveVault(session, mutation);
        }
        return;
      }
      if (new Set(state.members.filter((member) => member.status === undefined || member.status === 'active').map((member) => member.role)).size < 2) return;
      session.vault.mls = await prepareCreatorWelcome(session.vault);
      await saveVault(session, mutation);
      const pending = session.vault.mls.pendingWelcome;
      if (!pending) throw new Error('MLS 欢迎消息没有持久化');
      const published = await publishMlsWelcome(session.vault.roomId, session.vault.accessToken, pending);
      if (!published.mlsWelcome || canonicalStringify(published.mlsWelcome) !== canonicalStringify(pending)) {
        throw new SecurityViolation('服务器没有确认相同的 MLS 欢迎消息');
      }
      session.vault.mls = { ...session.vault.mls, pendingWelcome: undefined };
      await saveVault(session, mutation);
      return;
    }
    if (session.vault.mls.phase === 'active') return;
    if (!state.mlsWelcome) return;
    session.vault.mls = await joinMlsGroup(session.vault, state.mlsWelcome);
    session.vault.identity.mlsPrivatePackage = undefined;
    await saveVault(session, mutation);
  }

  private async drainServerQueue(requestMore = false): Promise<void> {
    const session = this.session;
    const epoch = this.runtimeEpoch;
    if (!session || this.privacyCovered) return;
    await withVaultMutation(session, async (mutation) => {
      if (this.isRuntimeActive(epoch, session)) await this.drainServerQueueLocked(requestMore, mutation);
    });
    if (this.isRuntimeActive(epoch, session)) await this.drainReceiptQueue();
  }

  private async drainServerQueueLocked(requestMore: boolean, mutation: VaultMutation): Promise<void> {
    const session = this.session;
    if (this.draining || !session || this.privacyCovered) return;
    const epoch = this.runtimeEpoch;
    let projectionChanged = false;
    this.draining = true;
    try {
      let expected = session.vault.lastSeq + 1;
      while (this.serverQueue.has(expected)) {
        const serverMessage = this.serverQueue.get(expected)!;
        let payload: MessagePayload;
        let nextMlsGroupState: string | null = null;
        const ownDevice = serverMessage.envelope.senderId === session.vault.identity.publicBundle.deviceId;
        const senderMember = session.vault.members.find((member) => member.deviceId === serverMessage.envelope.senderId);
        const ownRole = senderMember?.role === session.vault.role;
        try {
          if (serverMessage.envelope.v === 2) {
            if (ownDevice) {
              const queued = this.outbox.get(serverMessage.envelope.clientMsgId);
              if (!queued?.envelope || canonicalStringify(queued.envelope) !== canonicalStringify(serverMessage.envelope)) {
                throw new Error('本机 MLS 待发记录与服务器消息不一致');
              }
              payload = queued.payload;
            } else {
              const opened = await decryptMlsApplication(session.vault, serverMessage.envelope);
              payload = opened.payload;
              nextMlsGroupState = opened.nextGroupState;
            }
          } else {
            payload = await decryptMessage(session.vault, serverMessage.envelope);
          }
          if (payload.kind === 'gallery-image' || payload.kind === 'gallery-file') {
            const sender = session.vault.members.find((member) => member.deviceId === serverMessage.envelope.senderId);
            if (sender?.role !== 'creator') throw new SecurityViolation('非创建者设备不能写入相册');
          }
          if (!this.isRuntimeActive(epoch, session)) return;
        } catch (cause) {
          if (!this.isRuntimeActive(epoch, session)) return;
          this.fatalSecurityError(new SecurityViolation(cause instanceof Error ? cause.message : '消息完整性验证失败'));
          break;
        }
        const message: DecryptedMessage = {
          seq: serverMessage.seq,
          clientMsgId: serverMessage.envelope.clientMsgId,
          senderId: serverMessage.envelope.senderId,
          payload,
          acceptedAt: serverMessage.acceptedAt,
          status: ownRole ? 'stored' : 'delivered',
        };
        try {
          let receipt: DeliveryReceipt | null = null;
          if (!ownRole) {
            receipt = await createDeliveryReceipt(session.vault, serverMessage);
            if (!this.isRuntimeActive(epoch, session)) return;
            if (!nextMlsGroupState) await savePendingReceipt(session, receipt, mutation);
          }
          const previousSeq = session.vault.lastSeq;
          session.vault.lastSeq = message.seq;
          if (nextMlsGroupState) {
            try {
              await commitMlsReceive(session, message, nextMlsGroupState, receipt ?? undefined, mutation);
            } catch (cause) {
              session.vault.lastSeq = previousSeq;
              throw cause;
            }
          } else {
            await saveHistoryMessage(session, message, mutation);
            try {
              await saveVault(session, mutation);
            } catch (cause) {
              session.vault.lastSeq = previousSeq;
              throw cause;
            }
          }
          if (ownDevice) {
            this.clearRetry(message.clientMsgId);
            await deleteOutboxItem(session, message.clientMsgId, mutation);
          }
          if (!this.isRuntimeActive(epoch, session)) return;
          this.messages.set(message.seq, message);
          if (!ownDevice && this.livePresenceMessages.has(serverMessage)
            && ['text', 'image', 'image-album', 'file', 'audio'].includes(payload.kind)) {
            this.presenceCircuit?.received(ownRole);
          }
          projectionChanged = true;
          if (!this.historyHasNewer && message.seq > this.historyForwardCursor) {
            this.historyForwardCursor = message.seq;
          }
          this.serverQueue.delete(expected);
          this.pending.delete(message.clientMsgId);
          if (ownDevice) this.outbox.delete(message.clientMsgId);
          if (receipt) {
            this.pendingReceipts.set(receipt.clientMsgId, receipt);
            this.sendPendingReceipt(receipt);
          }
          expected += 1;
        } catch (cause) {
          let durableSeq = session.vault.historyUnavailableBeforeSeq ?? 0;
          while (this.messages.has(durableSeq + 1)) durableSeq += 1;
          session.vault.lastSeq = durableSeq;
          if (!this.isRuntimeActive(epoch, session)) return;
          this.operationalError(cause);
          break;
        }
      }
      // Reconnect readiness and empty sync frames must not restart local media
      // loading. Only the active page owns updates, never an outgoing animation.
      if (projectionChanged) {
        this.closeViewerIfProjectionDeleted();
        const gallery = this.root.querySelector<HTMLElement>(':scope > .gallery-shell');
        const galleryTab = gallery?.querySelector<HTMLElement>('.gallery-tabs')?.dataset.activeTab;
        if (gallery && (galleryTab === 'images' || galleryTab === 'files')) this.renderGallery(galleryTab);
        else this.renderMessages();
      }
      if (requestMore || [...this.serverQueue.keys()].some((seq) => seq > session.vault.lastSeq + 1)) {
        this.socket?.requestSync(session.vault.lastSeq);
      }
    } finally {
      if (this.runtimeEpoch === epoch) this.draining = false;
    }
  }

  private async drainReceiptQueue(requestMore = false): Promise<void> {
    const session = this.session;
    const epoch = this.runtimeEpoch;
    if (!session || this.privacyCovered) return;
    await withVaultMutation(session, async (mutation) => {
      if (this.isRuntimeActive(epoch, session)) await this.drainReceiptQueueLocked(requestMore, mutation);
    });
  }

  private async drainReceiptQueueLocked(requestMore: boolean, mutation: VaultMutation): Promise<void> {
    const session = this.session;
    if (!session || this.privacyCovered || this.receiptDraining) return;
    const epoch = this.runtimeEpoch;
    this.receiptDraining = true;
    try {
      let expected = (session.vault.lastReceiptSeq ?? 0) + 1;
      while (this.receiptQueue.has(expected)) {
        const serverReceipt = this.receiptQueue.get(expected)!;
        if (serverReceipt.skipped) {
          const previousReceiptSeq = session.vault.lastReceiptSeq ?? 0;
          session.vault.lastReceiptSeq = expected;
          try {
            await saveVault(session, mutation);
          } catch (cause) {
            session.vault.lastReceiptSeq = previousReceiptSeq;
            if (!this.isRuntimeActive(epoch, session)) return;
            this.operationalError(cause);
            return;
          }
          if (!this.isRuntimeActive(epoch, session)) return;
          this.receiptQueue.delete(expected);
          expected += 1;
          continue;
        }
        const receipt = serverReceipt.receipt;
        // The visible history is paginated; an old receipt must resolve against
        // encrypted local history rather than repeatedly syncing after lastSeq.
        const message = this.messages.get(receipt.seq)
          ?? await loadHistoryMessage(session, receipt.seq, this.runtimeAbort?.signal);
        if (!this.isRuntimeActive(epoch, session)) return;
        const sender = message ? this.memberForMessage(message) : undefined;
        const receiver = session.vault.members.find((member) => member.deviceId === receipt.receiverId);
        if (!message) {
          if (receipt.seq <= session.vault.lastSeq) {
            this.fatalSecurityError(new SecurityViolation('送达回执对应的本机加密历史缺失，已停止同步'));
            return;
          }
          this.socket?.requestSync(session.vault.lastSeq);
          break;
        }
        if (
          message.clientMsgId !== receipt.clientMsgId ||
          !sender || !receiver || sender.role === receiver.role ||
          !(await verifyDeliveryReceipt(session.vault, receipt))
        ) {
          if (!this.isRuntimeActive(epoch, session)) return;
          this.fatalSecurityError(new SecurityViolation('对端送达回执未通过签名或消息绑定校验'));
          return;
        }
        try {
          if (this.isOwnMessage(message)) {
            message.status = 'delivered';
            await saveHistoryMessage(session, message, mutation);
          }
          if (!this.isRuntimeActive(epoch, session)) return;
          const previousReceiptSeq = session.vault.lastReceiptSeq ?? 0;
          session.vault.lastReceiptSeq = expected;
          try {
            await saveVault(session, mutation);
          } catch (cause) {
            session.vault.lastReceiptSeq = previousReceiptSeq;
            throw cause;
          }
          if (!this.isRuntimeActive(epoch, session)) return;
          this.receiptQueue.delete(expected);
          expected += 1;
        } catch (cause) {
          this.operationalError(cause);
          return;
        }
      }
      if (!this.isRuntimeActive(epoch, session)) return;
      this.renderMessages();
      if (requestMore || [...this.receiptQueue.keys()].some((seq) => seq > (session.vault.lastReceiptSeq ?? 0) + 1)) {
        this.socket?.requestReceiptSync(session.vault.lastReceiptSeq ?? 0);
      }
    } finally {
      if (this.runtimeEpoch === epoch) this.receiptDraining = false;
    }
  }

  private renderInviteWait(): void {
    if (!this.session) return;
    if (!this.setActiveSurface('away')) return;
    document.body.className = 'app-mode';
    const invite: Invite = {
      v: 1,
      roomId: this.session.vault.roomId,
      accessToken: this.session.vault.inviteToken ?? this.session.vault.accessToken,
      pairingSecret: this.session.vault.pairingSecret,
      creatorFingerprint: this.session.vault.creatorFingerprint,
    };
    const inviteUrl = makeParticipantInviteUrl(invite);
    this.root.innerHTML = `
      <section class="pairing-screen">
        <header class="pairing-header">
          <div><p class="eyebrow">一次性邀请</p><h1>等待另一位参与者</h1></div>
          <button class="icon-button" id="pairing-lock" type="button" aria-label="锁定并返回白屏">${icons.lock}</button>
        </header>
        <div class="pairing-body">
          <canvas id="invite-qr" width="248" height="248" aria-label="会话邀请二维码"></canvas>
          <p class="pairing-instruction">让对方扫描二维码，或安全地发送邀请链接。第二位参与者加入后，这个邀请将不再新增参与者。</p>
          <label class="invite-link">邀请链接<input id="invite-url" readonly /></label>
          <button class="primary-button" id="copy-invite" type="button">复制邀请链接</button>
          <p class="connection-line"><span class="status-dot"></span><span id="connection-label">正在连接…</span></p>
        </div>
        <footer class="pairing-footer">邀请链接同时包含访问凭证和配对秘密，请只发送给另一位参与者。</footer>
      </section>
    `;
    const input = this.root.querySelector<HTMLInputElement>('#invite-url')!;
    input.value = inviteUrl;
    const canvas = this.root.querySelector<HTMLCanvasElement>('#invite-qr')!;
    void QRCode.toCanvas(canvas, inviteUrl, {
      width: 248,
      margin: 1,
      color: { dark: '#2f4037', light: '#f5f3ee' },
      errorCorrectionLevel: 'M',
    });
    this.root.querySelector('#copy-invite')?.addEventListener('click', async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      const session = this.session;
      const epoch = this.runtimeEpoch;
      if (!session || this.privacyCovered) return;
      try {
        await this.withSystemSurface(() => navigator.clipboard.writeText(inviteUrl));
      } catch {
        if (!this.isRuntimeActive(epoch, session) || !input.isConnected) return;
        input.select();
        if (!document.execCommand('copy')) {
          button.textContent = '请选择链接后复制';
          return;
        }
      }
      if (!this.isRuntimeActive(epoch, session) || !button.isConnected) return;
      button.textContent = '已复制';
      window.setTimeout(() => {
        if (this.isRuntimeActive(epoch, session) && button.isConnected) button.textContent = '复制邀请链接';
      }, 1600);
    });
    this.root.querySelector('#pairing-lock')?.addEventListener('click', () => this.lockNow());
    this.updateConnectionStatus();
  }

  private closeMemePicker(keyboard = false, animate = false): void {
    const picker = this.memePicker;
    if (picker) this.clearMemePanelHandoff();
    if (this.keyboardHandoff?.input.id === 'meme-query' && this.invalidateKeyboardHandoff()) return;
    if (animate && picker && !this.privacyCovered) {
      if (keyboard) this.root.querySelector<HTMLTextAreaElement>('#message-input')?.focus({ preventScroll: true });
      picker.close(() => this.closeMemePicker(keyboard));
      return;
    }
    this.memePicker = null;
    picker?.dispose();
    const button = this.root.querySelector<HTMLButtonElement>('#open-memes');
    button?.setAttribute('aria-expanded', 'false');
    if (button) { button.innerHTML = memeIcons.smile; button.setAttribute('aria-label', '打开表情'); }
    if (keyboard && !this.privacyCovered) this.root.querySelector<HTMLTextAreaElement>('#message-input')?.focus({ preventScroll: true });
    else if (picker && !this.privacyCovered) button?.focus({ preventScroll: true });
  }

  private openMemePicker(): void {
    this.closeChatTools();
    const session = this.session;
    const epoch = this.runtimeEpoch;
    const host = this.root.querySelector<HTMLElement>('#composer');
    if (!session || !host || this.privacyCovered || !this.runtimeAbort || this.activeSurface !== 'chat') return;
    this.closeMemePicker();
    this.closeMessageActions(false, false);
    this.root.querySelector<HTMLTextAreaElement>('#message-input')?.blur();
    const button = this.root.querySelector<HTMLButtonElement>('#open-memes')!;
    button.setAttribute('aria-expanded', 'true'); button.setAttribute('aria-label', '切回键盘'); button.innerHTML = memeIcons.keyboard;
    const isActive = () => this.isRuntimeActive(epoch, session) && this.activeSurface === 'chat' && host.isConnected;
    const request = async (path: string, body: unknown, signal: AbortSignal) => {
      const response = await fetch(`/api/rooms/${session.vault.roomId}/memes/${path}`, {
        method: 'POST', credentials: 'omit', cache: 'no-store', signal,
        headers: { Authorization: `Bearer ${session.vault.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!response.ok) {
        if (response.status === 404) throw new Error('图片已过期，请重新搜索');
        if (response.status >= 500) throw new Error('网络梗图暂时不可用，请稍后重试');
        if (response.status === 429) throw new Error('请求过于频繁，请稍后再试');
        throw new Error('梗图请求失败，请重试或重新搜索');
      }
      return response;
    };
    this.memePicker = new MemePicker({
      host, root: this.root, signal: this.runtimeAbort.signal, isActive,
      cache: this.memeCache,
      list: () => loadMemeFavorites(session),
      file: (item, signal) => loadMemeFavoriteFile(session, item, signal),
      save: (file, signal) => saveMemeFavorite(session, file, signal),
      remove: (id, signal) => removeMemeFavorite(session, id, signal),
      packs: () => loadStickerPacks(session),
      install: (id, title, files, signal, autoHide) => installStickerPack(session, id, title, files, signal, autoHide),
      removePack: (id, signal) => removeStickerPack(session, id, signal),
      reorderPacks: (ids, signal) => reorderStickerPacks(session, ids, signal),
      pack: async (id, signal) => {
        const result = await (await request('pack', { id }, signal)).json();
        if (result.id !== id || typeof result.title !== 'string' || result.title.length > 120 || (result.autoHide !== undefined && typeof result.autoHide !== 'boolean') || !Array.isArray(result.items)
          || !result.items.length || result.items.length > 200 || result.items.some((item: { id?: unknown; title?: unknown }) =>
            typeof item?.id !== 'string' || !/^[0-9a-f-]{36}$/.test(item.id) || typeof item.title !== 'string' || item.title.length > 120 || (item as { autoHide?: unknown }).autoHide !== undefined && typeof (item as { autoHide?: unknown }).autoHide !== 'boolean')) throw new Error('合集格式不受支持');
        return { id: result.id, title: result.title, autoHide: result.autoHide, items: result.items.map((item: { id: string; title: string; autoHide?: boolean }) => ({ id: item.id, title: item.title, autoHide: item.autoHide ?? result.autoHide })) };
      },
      send: async (file, autoHide, signal) => {
        if (!isActive()) throw new Error('会话已关闭');
        if (this.imageBatchUploading) throw new Error('另一个附件正在发送，请稍后重试');
        this.imageBatchUploading = true;
        try {
          if (!await this.processImageBatch([file], 'chat', signal, true, undefined, autoHide)) throw new Error('发送未完成，请查看聊天中的状态后重试');
        } finally { if (this.isRuntimeActive(epoch, session)) this.imageBatchUploading = false; }
      },
      search: async (keyword, page, signal, kind) => {
        const response = await request('search', { keyword, page, kind }, signal);
        const result = await response.json();
        if (!Array.isArray(result.items) || result.items.length > 200
          || result.items.some((item: { id?: unknown; title?: unknown }) => typeof item?.id !== 'string' || !/^[0-9a-f-]{36}$/.test(item.id)
            || typeof item.title !== 'string' || item.title.length > 120 || (item as { autoHide?: unknown }).autoHide !== undefined && typeof (item as { autoHide?: unknown }).autoHide !== 'boolean')
          || (result.nextPage !== null && (!Number.isSafeInteger(result.nextPage) || result.nextPage <= page || result.nextPage > 1000))) throw new Error('搜索结果格式不受支持');
        if (result.packs !== undefined && (!Array.isArray(result.packs) || result.packs.length > 24 || result.packs.some((pack: { id?: unknown; title?: unknown; cover?: unknown }) =>
          typeof pack.id !== 'string' || !/^[a-z0-9-]{1,80}$/.test(pack.id) || typeof pack.title !== 'string' || pack.title.length > 120 || typeof pack.cover !== 'string' || !/^[0-9a-f-]{36}$/.test(pack.cover) || (pack as { autoHide?: unknown }).autoHide !== undefined && typeof (pack as { autoHide?: unknown }).autoHide !== 'boolean'))) throw new Error('合集搜索结果不受支持');
        return { items: result.items.map((item: { id: string; title: string; autoHide?: boolean }) => ({ id: item.id, title: item.title, animatedOnly: kind === 'gifs', autoHide: item.autoHide })),
          packs: result.packs?.map((pack: { id: string; title: string; cover: string; autoHide?: boolean }) => ({ id: pack.id, title: pack.title, cover: pack.cover, autoHide: pack.autoHide })),
          nextPage: result.nextPage, source: typeof result.source === 'string' ? result.source.slice(0, 120) : undefined };
      },
      media: async (id, signal) => {
        const response = await request('media', { id }, signal);
        // Bound streamed bytes even if a response omits Content-Length.
        if (!response.body) throw new Error('图片内容为空');
        const reader = response.body.getReader(); const chunks: Uint8Array<ArrayBuffer>[] = []; let size = 0;
        try {
          while (true) {
            signal.throwIfAborted();
            const part = await reader.read(); if (part.done) break;
            size += part.value.byteLength;
            if (size > 8 * 1024 * 1024) throw new Error('梗图需小于 8 MiB');
            chunks.push(new Uint8Array(part.value));
          }
        } finally { await reader.cancel().catch(() => undefined); }
        return new Blob(chunks, { type: response.headers.get('Content-Type') ?? '' });
      },
      close: keyboard => this.closeMemePicker(keyboard, true),
      onSearchPointer: (input, event) => { this.beginKeyboardHandoff(input, event); },
      onKeyboardPointer: event => {
        const input = host.querySelector<HTMLTextAreaElement>('#message-input');
        if (input) this.beginKeyboardHandoff(input, event);
      },
    });
    // Once the picker owns the gesture, a delayed Safari blur must not be
    // mistaken for a fresh departure and lock an actively used panel.
    this.clearMemePanelHandoff();
  }

  private async favoriteChatMeme(message: DecryptedMessage, manifest: ImageManifest): Promise<void> {
    const session = this.session; const epoch = this.runtimeEpoch; const signal = this.runtimeAbort?.signal;
    if (!session || !signal || this.privacyCovered || this.messageIsUnavailable(message.clientMsgId)) return;
    this.closeMessageActions(false, false);
    this.showNotice('正在收藏…');
    try {
      const cached = await this.loadImage(manifest);
      if (!this.isRuntimeActive(epoch, session) || this.messageIsUnavailable(message.clientMsgId)) return;
      const file = await validateMemeFile(cached.blob, manifest.originalName || '梗图', signal);
      if (!this.isRuntimeActive(epoch, session) || this.messageIsUnavailable(message.clientMsgId)) return;
      const added = await saveMemeFavorite(session, file, signal);
      if (this.isRuntimeActive(epoch, session)) this.showNotice(added ? '已收藏到本机' : '已在收藏中');
    } catch (error) { if (this.isRuntimeActive(epoch, session)) this.operationalError(error, '收藏失败，请重试'); }
  }

  private renderChat(): void {
    if (!this.session) return;
    // Replacing the textarea destroys the owner of a consumed native-keyboard
    // blur. Treat that as a departure; an unused pre-focus arm is just cleared.
    if (this.invalidateKeyboardHandoff()) return;
    this.closeMemePicker();
    this.presenceCircuit?.destroy();
    this.presenceCircuit = null;
    if (this.galleryMode === 'favorites') this.galleryKnownCounts = {};
    this.galleryMode = 'safe';
    this.galleryRevealedAssets.clear();
    this.clearMessageTextSelection();
    this.closeVoiceRecorder();
    this.voicePlayback.stop();
    this.setActiveSurface('chat');
    const cryptoReady = this.session.vault.protocol !== 'mls-rfc9420' || this.session.vault.mls?.phase === 'active';
    this.galleryObserver?.disconnect();
    this.galleryObserver = null;
    this.chatImageObserver?.disconnect();
    this.chatImageObserver = null;
    // A new page must rebuild previews from the current cache, not retain a
    // detached loading element whose old hydration callback has already ended.
    this.renderedMessages.clear();
    this.renderedMessageOrder = [];
    this.renderedMessageDates.clear();
    this.renderedMessageSeq.clear();
    document.body.className = 'app-mode';
    this.root.innerHTML = `
      <section class="chat-shell">
        <header class="chat-header">
          <div aria-hidden="true"></div>
          <div class="peer-summary" ${this.session.vault.role === 'creator' ? 'id="open-gallery" role="button" tabindex="0"' : 'role="status"'} aria-live="polite">
            <div class="presence-heading">
              <span class="presence-row" id="self-presence"><span>我</span><i class="presence-dot" aria-hidden="true"></i><strong class="sr-only">同步中</strong></span>
              ${presenceCircuitMarkup}
              <span class="presence-row" id="peer-presence"><i class="presence-dot" aria-hidden="true"></i><span>对方</span></span>
            </div>
            <strong class="peer-status">同步中</strong>
          </div>
          <nav class="header-actions" aria-label="会话操作">
            <details class="more-menu">
              <summary class="icon-button" aria-label="更多操作">${icons.more}</summary>
              <div class="menu-panel">
                <p class="menu-title">本机安全</p>
                <p class="protocol-label">${this.session.vault.protocol === 'mls-rfc9420' ? '端到端加密' : '旧版会话，建议重新建立'}</p>
                <button id="manage-devices" type="button">${icons.lock}<span>设备管理</span></button>
                <button id="backup-settings" type="button">${icons.download}<span>备份与恢复</span></button>
                <button id="release-history" type="button">${icons.file}<span>更新日志</span></button>
                <p class="menu-footnote">新设备只能查看加入后的消息。</p>
              </div>
            </details>
          </nav>
        </header>
        <div class="system-notices" aria-label="本机安全提醒">
          ${this.releaseUpdateBannerMarkup()}
          ${cryptoReady ? '' : `
            <aside class="crypto-reminder">
              <div><strong>正在建立安全会话</strong><span>验证完成后即可发送消息。</span></div>
            </aside>
          `}
          ${this.uiPreferences.recoveryReminderDismissed ? '' : `
            <aside class="recovery-reminder">
              <button type="button" id="reminder-export" class="pinned-recovery-content"><strong>自动备份与恢复码</strong><span>查看备份状态，保存本设备恢复码</span></button>
              <button type="button" id="dismiss-recovery" aria-label="关闭恢复提醒">${icons.close}</button>
            </aside>
          `}
          ${this.uploadPlans.length > 0 ? `
            <aside class="upload-reminder">
              <div><strong>有 ${this.uploadPlans.length} 个文件待续传</strong><span>重新选择同一文件即可从已完成的分块继续。</span></div>
              <button type="button" id="clear-upload-reminder">清除记录</button>
            </aside>
          ` : ''}
        </div>
        <div class="notice" id="notice" role="status" hidden></div>
        <section class="message-list" id="message-list" aria-label="聊天消息"></section>
        <form class="composer" id="composer" autocomplete="off">
          <button class="chat-bottom-control" id="chat-bottom-control" type="button" aria-label="回到最新消息" aria-hidden="true" tabindex="-1"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 5v14m-6-6 6 6 6-6"/></svg></button>
          <input id="image-input" type="file" accept="image/*,video/*" multiple ${cryptoReady ? '' : 'disabled'} hidden />
          <input id="camera-input" type="file" accept="image/*,video/*" capture="environment" ${cryptoReady ? '' : 'disabled'} hidden />
          <input id="file-input" type="file" multiple ${cryptoReady ? '' : 'disabled'} hidden />
          <div class="composer-input-stack">
            <div class="reply-draft" id="reply-draft" hidden>
              <div><strong>回复对方</strong><span></span></div>
              <button type="button" aria-label="取消回复">${icons.close}</button>
            </div>
            <div class="composer-field">
              <label class="sr-only" for="message-input">输入消息</label>
              <textarea id="message-input" rows="1" maxlength="4000" placeholder="${cryptoReady ? '点击输入文字，长按录制语音' : '正在建立安全会话…'}" autocomplete="off" enterkeyhint="send" ${cryptoReady ? '' : 'disabled'}></textarea>
              <span class="composer-placeholder" aria-hidden="true">${cryptoReady ? '点击输入文字，长按录制语音' : '正在建立安全会话…'}</span>
              <button class="meme-toggle" id="open-memes" type="button" aria-label="打开表情" title="表情" aria-expanded="false" aria-controls="meme-panel" ${cryptoReady ? '' : 'disabled'}>${memeIcons.smile}</button>
            </div>
          </div>
          <button class="icon-button" id="open-chat-tools" type="button" aria-label="更多功能" aria-expanded="false" aria-controls="chat-tools">${createElement(Plus).outerHTML}</button>
          <div class="chat-tools" id="chat-tools" hidden>
            <button id="open-image-picker" type="button" ${cryptoReady ? '' : 'disabled'}><span>${icons.image}</span>图片</button>
            <button id="open-camera-picker" type="button" ${cryptoReady ? '' : 'disabled'}><span>${createElement(Camera).outerHTML}</span>拍摄</button>
            <button id="start-video-call" type="button" disabled><span>${icons.video}</span>视频通话</button>
            <button id="start-audio-call" type="button" disabled><span>${icons.phone}</span>实时语音</button>
            <button id="open-file-picker" type="button" ${cryptoReady ? '' : 'disabled'}><span>${icons.file}</span>文件</button>
            <button id="open-favorites" type="button"><span>${memeIcons.star}</span>收藏</button>
          </div>
          <div class="upload-progress" id="upload-progress" hidden><span></span><output></output></div>
        </form>
        <section class="voice-recorder" aria-label="录制语音消息" hidden></section>
      </section>
    `;
    this.mountChatLayout();
    this.root.querySelector('#open-memes')?.addEventListener('pointerdown', event => {
      if (!this.memePicker) {
        this.beginMemePanelHandoff(event.currentTarget as HTMLButtonElement, event as PointerEvent);
        return;
      }
      const input = this.root.querySelector<HTMLTextAreaElement>('#message-input');
      if (input) this.beginKeyboardHandoff(input, event as PointerEvent);
    });
    this.root.querySelector('#open-memes')?.addEventListener('click', () => {
      if (this.memePicker) this.closeMemePicker(true, true); else this.openMemePicker();
    });
    this.root.querySelector('#composer')?.addEventListener('submit', (event) => void this.handleSendText(event));
    const list = this.root.querySelector<HTMLElement>('#message-list')!;
    const textarea = this.root.querySelector<HTMLTextAreaElement>('#message-input')!;
    const ownsActiveChat = () => !this.privacyCovered && this.activeSurface === 'chat'
      && this.chatLayoutElements?.list === list && this.chatLayoutElements.composer.contains(textarea)
      && list.isConnected && textarea.isConnected;
    let keyboardHistoryRead: AbortController | null = null;
    this.mountChatImageConcealGesture(list);
    const scrollIntent = (direction: 'up' | 'down') => {
      if (!ownsActiveChat()) return;
      keyboardHistoryRead?.abort();
      this.chatBottomControl?.cancel();
      this.cancelChatMessageMotion();
      this.chatResumeBottomOnFocus = false;
      this.chatRestoreAnchor = null;
      this.chatScrollIntent = direction;
      if (direction === 'up') {
        this.chatPinnedToBottom = false;
        this.chatBottomFollowPending = false;
        this.chatViewportFollowUntil = 0;
      }
      else if (this.chatBottomGap() <= 2
        || this.chatScrollTop >= (this.usesListScrolling ? list.scrollHeight - list.clientHeight
          : document.documentElement.scrollHeight - window.innerHeight) - 2) this.chatPinnedToBottom = true;
    };
    let touchY: number | null = null;
    if (this.usesListScrolling) list.addEventListener('scroll', () => {
      if (ownsActiveChat()) this.scheduleChatScroll();
    }, { passive: true });
    list.addEventListener('touchstart', event => {
      if (!ownsActiveChat()) return;
      if (!this.visualClientCoordinates || document.documentElement.dataset.keyboardOpen !== 'true') this.commitNativeChatFollow();
      touchY = event.touches[0]?.clientY ?? null;
      this.chatViewportMotion?.touchStart();
      this.trackChatViewport();
    }, { passive: true });
    list.addEventListener('touchmove', event => {
      if (!ownsActiveChat()) return;
      const y = event.touches[0]?.clientY;
      if (touchY !== null && y !== undefined && Math.abs(y - touchY) > 2) {
        this.chatViewportMotion?.move();
        if (!this.chatKeyboardGesture?.held) scrollIntent(y > touchY ? 'up' : 'down');
        touchY = y;
      }
      this.trackChatViewport();
    }, { passive: true });
    const endTouch = (event: TouchEvent) => {
      if (event.touches.length) return;
      touchY = null;
      if (!ownsActiveChat()) return;
      this.chatViewportMotion?.touchEnd();
      this.trackChatViewport();
    };
    list.addEventListener('touchend', endTouch, { passive: true });
    list.addEventListener('touchcancel', endTouch, { passive: true });
    list.addEventListener('wheel', event => {
      if (!ownsActiveChat()) return;
      this.commitNativeChatFollow();
      if (event.deltaY) { this.chatViewportMotion?.move(); scrollIntent(event.deltaY < 0 ? 'up' : 'down'); }
      this.trackChatViewport();
    }, { passive: true });
    list.addEventListener('pointerdown', () => { if (ownsActiveChat()) this.chatRestoreAnchor = null; }, { passive: true });
    list.addEventListener('keydown', event => {
      if (!ownsActiveChat()) return;
      this.commitNativeChatFollow();
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) scrollIntent('up');
      else if (['ArrowDown', 'PageDown', 'End', ' '].includes(event.key)) scrollIntent('down');
    }, { passive: true });
    const trackKeyboard = () => {
      if (ownsActiveChat()) this.trackChatViewport(!this.desktopBrowser && this.chatPinnedToBottom && this.chatScrollIntent !== 'up');
    };
    const prepareKeyboardTarget = () => {
      if (!ownsActiveChat()) return;
      // A tap in history cancels follow before blur to protect a possible drag.
      // On the next focus, resume a bottom reader who only dismissed the
      // keyboard. An actual touch/wheel/key scroll clears this saved intent.
      if (!this.chatRestoreAnchor && (this.chatResumeBottomOnFocus || this.chatBottomGap() <= 2)) {
        this.scrollChatToBottom();
      }
      this.chatResumeBottomOnFocus = false;
      trackKeyboard();
    };
    // Do not hide or make the textarea non-interactive on pointerdown. iOS may
    // defer the default focus until touchend; changing pointer-events before
    // then cancels the very tap that was meant to open the keyboard.
    textarea.addEventListener('pointerdown', event => {
      if (!ownsActiveChat()) return;
      if (this.memePicker) this.closeMemePicker(true, true);
      if (this.beginKeyboardHandoff(textarea, event)) this.chatViewportMotion?.anticipateKeyboard('open');
      prepareKeyboardTarget();
    }, { passive: true });
    let focusTap: { x: number; y: number } | null = null;
    textarea.addEventListener('touchstart', event => {
      const touch = event.touches.length === 1 ? event.touches[0] : undefined;
      focusTap = touch ? { x: touch.clientX, y: touch.clientY } : null;
    }, { passive: true });
    textarea.addEventListener('touchmove', event => {
      const touch = event.touches[0];
      if (focusTap && (!touch || Math.hypot(touch.clientX - focusTap.x, touch.clientY - focusTap.y) > 10)) focusTap = null;
    }, { passive: true });
    textarea.addEventListener('touchcancel', () => { focusTap = null; }, { passive: true });
    textarea.addEventListener('touchend', event => {
      const tap = focusTap;
      focusTap = null;
      if (!this.usesListScrolling || !ownsActiveChat() || event.touches.length
        || !tap || !textarea.value || document.activeElement === textarea || !event.cancelable) return;
      // Empty-input releases belong to the voice gesture, which focuses short taps.
      // Native tap focus pans Safari's root even when the list owns scrolling.
      // Keep focus in the trusted touch gesture and suppress only that root pan.
      event.preventDefault();
      textarea.focus({ preventScroll: true });
    }, { passive: false });
    textarea.addEventListener('focus', () => {
      if (!ownsActiveChat()) return;
      this.cancelNativeKeyboardDismiss();
      delete this.chatLayoutElements?.composer.dataset.keyboardDismissReveal;
      if (this.visualClientCoordinates) {
        this.nativeKeyboardOpening = true;
        this.chatRestoreAnchor = null;
        this.scrollChatToBottom();
        if (this.historyHasNewer && this.runtimeAbort) {
          keyboardHistoryRead?.abort();
          const read = new AbortController();
          keyboardHistoryRead = read;
          const signal = AbortSignal.any([read.signal, this.runtimeAbort.signal]);
          void this.prepareChatBottomScroll(list, signal).then(ready => {
            if (ready && !signal.aborted && ownsActiveChat() && document.activeElement === textarea
              && this.chatScrollIntent !== 'up') this.scrollChatToBottom();
          }).finally(() => { if (keyboardHistoryRead === read) keyboardHistoryRead = null; });
        }
      }
      this.beginListKeyboardLayout('open');
      prepareKeyboardTarget();
      if (!this.desktopBrowser && (document.documentElement.dataset.keyboardOpen !== 'true'
        || this.chatViewportMotion?.moving)) {
        this.chatViewportMotion?.keyboard('open');
      }
    });
    textarea.addEventListener('paste', event => this.handleComposerPaste(event));
    let nativeShrinkFrame: number | null = null;
    let activeComposition = false;
    const resizeTextarea = (animate = true, deferNativeShrink = true, composing = false) => {
      if (nativeShrinkFrame !== null) cancelAnimationFrame(nativeShrinkFrame);
      nativeShrinkFrame = null;
      const measure = textarea.cloneNode() as HTMLTextAreaElement;
      measure.removeAttribute('id');
      measure.setAttribute('aria-hidden', 'true');
      measure.tabIndex = -1;
      measure.value = textarea.value;
      measure.style.position = 'fixed';
      measure.style.inset = 'auto auto 0 0';
      measure.style.visibility = 'hidden';
      measure.style.pointerEvents = 'none';
      measure.style.transition = 'none';
      measure.style.width = `${textarea.getBoundingClientRect().width}px`;
      measure.style.height = '0px';
      textarea.parentElement!.append(measure);
      const measureStyle = getComputedStyle(measure);
      const borderHeight = parseFloat(measureStyle.borderTopWidth) + parseFloat(measureStyle.borderBottomWidth);
      let contentHeight = measure.scrollHeight + borderHeight;
      // WebKit's marked text can wrap before an unmarked measurement clone.
      // Native overflow is authoritative for growth; the clone still measures
      // intrinsic shrink without collapsing the focused textarea to zero.
      if (this.visualClientCoordinates && document.activeElement === textarea
        && textarea.scrollHeight > textarea.clientHeight + 1) {
        contentHeight = Math.max(contentHeight, textarea.scrollHeight + borderHeight);
      }
      const targetHeight = Math.min(contentHeight, 128);
      measure.remove();
      if (this.composerHeightMotion?.targetHeight === targetHeight) return;

      const currentHeight = textarea.getBoundingClientRect().height;
      // Marked text can temporarily fit fewer lines across separate native
      // editing frames. Keep its expanded area until composition commits.
      if (animate && this.visualClientCoordinates && document.activeElement === textarea
        && (activeComposition || composing) && targetHeight < currentHeight - 0.5) return;
      if (deferNativeShrink && animate && this.visualClientCoordinates
        && document.activeElement === textarea && targetHeight < currentHeight - 0.5) {
        // IME replacement can remove the marked text and insert its committed
        // form in adjacent input events. Do not scroll the document for that
        // transient shorter value. Growth still commits synchronously so the
        // native caret always has room; a real shrink uses the latest value.
        nativeShrinkFrame = requestAnimationFrame(() => {
          nativeShrinkFrame = null;
          if (ownsActiveChat()) resizeTextarea(animate, false);
        });
        return;
      }
      // A single-line edit commonly keeps the exact same intrinsic height.
      // Leave an already-running send/reaction animation alone in that case;
      // there is no composer geometry for this controller to retarget.
      if (!this.composerHeightMotion && Math.abs(targetHeight - currentHeight) < 0.5) return;
      const list = this.chatLayoutElements?.list;
      const origins = new Map<HTMLElement, number>();
      if (list?.isConnected) {
        // Include a margin for incoming bubbles and the maximum field growth,
        // but do not rewrite thousands of offscreen children on every frame.
        for (let row = list.lastElementChild; row; row = row.previousElementSibling) {
          const rect = row.getBoundingClientRect();
          if (rect.bottom < this.chatViewportTop - 320) break;
          if (rect.top > this.chatViewportTop + this.chatViewportHeight + 320) continue;
          const contents = row.classList.contains('message-date') ? [row] : [...row.children];
          for (const content of contents) {
            if (content instanceof HTMLElement && !content.classList.contains('message-reply-swipe-indicator')) {
              origins.set(content, content.getBoundingClientRect().top);
            }
          }
        }
      }
      const priorMotion = this.composerHeightMotion;
      if (priorMotion?.frame != null) cancelAnimationFrame(priorMotion.frame);
      this.composerHeightMotion = null;
      this.cancelChatMessageMotion();
      // Freeze an interrupted transition at its currently painted height, then
      // commit that geometry before retargeting. Origins above preserve the
      // exact visible message positions across this bookkeeping step.
      textarea.style.transition = 'none';
      textarea.style.height = `${currentHeight}px`;
      void textarea.offsetHeight;
      this.syncChatLayout();
      const composer = this.chatLayoutElements?.composer;
      const currentComposerHeight = composer?.getBoundingClientRect().height ?? currentHeight;
      const follow = this.chatPinnedToBottom && this.chatScrollIntent !== 'up';
      if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches
        || !ownsActiveChat() || Math.abs(targetHeight - currentHeight) < 0.5) {
        textarea.style.height = `${targetHeight}px`;
        void textarea.offsetHeight;
        textarea.style.removeProperty('transition');
        this.syncChatLayout();
        return;
      }
      if (this.visualClientCoordinates && document.activeElement === textarea) {
        // The native iOS caret is not painted by our animation frame. Give it
        // the complete editing area in the input event; animating a clipped
        // textarea makes WebKit chase the new line while we move that line.
        // Only message contents interpolate, after layout and native clamping
        // have reached their endpoint. The actual input and selection stay put.
        this.composerViewportSettleUntil = performance.now() + CHAT_COMPOSER_VIEWPORT_SETTLE_MS;
        textarea.style.height = `${targetHeight}px`;
        textarea.style.removeProperty('transition');
        this.syncChatLayout();
        for (const [content, previousTop] of origins) {
          if (!content.isConnected) continue;
          const distance = previousTop - content.getBoundingClientRect().top;
          if (Math.abs(distance) < 0.5) continue;
          const animation = content.animate(
            [{ translate: `0 ${distance}px` }, { translate: '0 0' }],
            { duration: CHAT_COMPOSER_MOTION_MS, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'backwards' },
          );
          animation.currentTime = 0;
          this.chatMessageAnimations.add(animation);
          animation.finished.then(() => this.chatMessageAnimations.delete(animation), () => this.chatMessageAnimations.delete(animation));
        }
        return;
      }
      const motion = { targetHeight, frame: null as number | null };
      this.composerHeightMotion = motion;
      // iOS Safari can publish its caret-reveal viewport pan only after the
      // textarea has reached its painted endpoint. Keep ownership through that
      // delayed native settle instead of handing the same resize to the
      // keyboard/toolbar transition controller.
      this.composerViewportSettleUntil = performance.now()
        + CHAT_COMPOSER_MOTION_MS + CHAT_COMPOSER_VIEWPORT_SETTLE_MS;
      // One pre-paint update owns both layout height and visible translations.
      // WebKit may sample layout animations and compositor animations at
      // different instants even with identical WAAPI start times. Read only
      // the small composer here; document scrolling stays deferred to the end.
      const starts = new Map<HTMLElement, number>();
      for (const [content, previousTop] of origins) {
        if (!content.isConnected) continue;
        starts.set(content, previousTop - content.getBoundingClientRect().top);
        content.style.translate = `0 ${starts.get(content)}px`;
        this.chatMessageTranslations.add(content);
      }
      const started = performance.now();
      const step = (now: number) => {
        if (this.composerHeightMotion !== motion || !ownsActiveChat()) return;
        const progress = Math.min(1, Math.max(0, (now - started) / CHAT_COMPOSER_MOTION_MS));
        const eased = 1 - Math.pow(1 - progress, 4);
        textarea.style.height = `${currentHeight + (targetHeight - currentHeight) * eased}px`;
        const distance = follow ? (composer?.getBoundingClientRect().height ?? currentHeight) - currentComposerHeight : 0;
        for (const [content, start] of starts) {
          content.style.translate = `0 ${start * (1 - eased) - distance}px`;
        }
        if (progress < 1) { motion.frame = requestAnimationFrame(step); return; }
        this.composerHeightMotion = null;
        this.composerViewportSettleUntil = performance.now() + CHAT_COMPOSER_VIEWPORT_SETTLE_MS;
        textarea.style.removeProperty('transition');
        // Commit to the already-painted endpoint, then remove translations in
        // the same task. Older-history readers keep their original anchor.
        this.syncChatLayout();
        this.cancelChatMessageMotion();
      };
      motion.frame = requestAnimationFrame(step);
    };
    textarea.addEventListener('compositionstart', () => { activeComposition = true; });
    textarea.addEventListener('compositionend', () => {
      activeComposition = false;
      if (ownsActiveChat()) resizeTextarea();
    });
    textarea.addEventListener('input', event => {
      resizeTextarea(true, true, event instanceof InputEvent && event.isComposing);
      this.uiPreferences.composerDraft = textarea.value;
      this.scheduleUiPreferencesSave();
      this.syncComposerMode();
    });
    textarea.value = this.uiPreferences.composerDraft ?? '';
    resizeTextarea(false);
    this.syncComposerMode();
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.root.querySelector<HTMLFormElement>('#composer')?.requestSubmit();
      }
    });
    textarea.addEventListener('blur', () => {
      if (!ownsActiveChat()) return;
      keyboardHistoryRead?.abort();
      if ((this.bottomControlRetainsKeyboard || replyCloseRetainsKeyboard) && !this.privacyCovered && this.activeSurface === 'chat') {
        // A few mobile browser builds still transfer focus after a prevented
        // pointerdown on the floating return control. Restore it before the
        // soft keyboard begins to dismiss, retaining the exact selection.
        queueMicrotask(() => {
          if ((!this.bottomControlRetainsKeyboard && !replyCloseRetainsKeyboard) || !ownsActiveChat()) return;
          const selection = this.composerSelection ?? {
            start: textarea.selectionStart ?? textarea.value.length,
            end: textarea.selectionEnd ?? textarea.value.length,
          };
          textarea.focus({ preventScroll: true });
          textarea.setSelectionRange(
            Math.min(selection.start, textarea.value.length),
            Math.min(selection.end, textarea.value.length),
          );
        });
      } else {
        if (!this.imagePickerActive) this.keepComposerKeyboard = false;
        if (!this.nativeSurfaceActive()) this.beginListKeyboardLayout('closed');
        if (!this.desktopBrowser && document.documentElement.dataset.keyboardOpen === 'true') {
          if (this.visualClientCoordinates && this.chatLayoutElements) this.chatLayoutElements.composer.dataset.keyboardDismissReveal = 'true';
          this.beginNativeKeyboardDismiss();
          this.chatViewportMotion?.keyboard('closed');
        }
      }
      trackKeyboard();
    });
    const imageInput = this.root.querySelector<HTMLInputElement>('#image-input');
    this.voiceGesture?.destroy();
    this.voiceGesture = bindVoiceInputGesture(textarea, mode => this.beginVoiceRecording(mode));
    this.root.querySelector('#open-chat-tools')?.addEventListener('click', () => this.toggleChatTools());
    textarea.addEventListener('focus', () => this.closeChatTools());
    this.root.querySelector('#message-list')?.addEventListener('click', event => {
      if (event.target === event.currentTarget) this.closeChatTools();
    });
    this.root.querySelector('#chat-tools')?.addEventListener('keydown', event => {
      if ((event as KeyboardEvent).key === 'Escape') { this.closeChatTools(); this.root.querySelector<HTMLButtonElement>('#open-chat-tools')?.focus(); }
    });
    this.root.querySelector('#start-video-call')?.addEventListener('click', () => { this.closeChatTools(); void this.startCall('video'); });
    this.root.querySelector('#start-audio-call')?.addEventListener('click', () => { this.closeChatTools(); void this.startCall('audio'); });
    this.root.querySelector('#chat-bottom-control')?.addEventListener('pointerdown', event => {
      this.bottomControlRetainsKeyboard = document.activeElement === textarea;
      this.retainComposerKeyboard(event as PointerEvent, textarea);
    });
    this.mountImagePicker(imageInput, 'chat', this.root.querySelector<HTMLButtonElement>('#open-image-picker'));
    this.mountImagePicker(this.root.querySelector<HTMLInputElement>('#camera-input'), 'chat', this.root.querySelector<HTMLButtonElement>('#open-camera-picker'));
    this.mountImagePicker(this.root.querySelector<HTMLInputElement>('#file-input'), 'chat', this.root.querySelector<HTMLButtonElement>('#open-file-picker'));
    const openSafe = () => {
      if (this.session?.vault.role !== 'creator' || this.privacyCovered) return;
      this.closeChatTools(); this.galleryMode = 'safe';
      this.transitionPage('forward', () => this.renderGallery());
    };
    this.root.querySelector('#open-gallery')?.addEventListener('click', openSafe);
    this.root.querySelector('#open-gallery')?.addEventListener('keydown', event => {
      if (['Enter', ' '].includes((event as KeyboardEvent).key)) { event.preventDefault(); openSafe(); }
    });
    this.root.querySelector('#open-favorites')?.addEventListener('click', () => {
      this.closeChatTools(); this.galleryMode = 'favorites'; this.galleryKnownCounts = {}; this.galleryScrollTop = { images: 0, files: 0 };
      this.transitionPage('forward', () => this.renderGallery());
    });
    this.root.querySelector('#backup-settings')?.addEventListener('click', () => this.transitionPage('forward', () => this.renderBackupSettings()));
    this.root.querySelector('#release-history')?.addEventListener('click', () => this.transitionPage('forward', () => this.renderReleaseHistory()));
    this.root.querySelector('#reminder-export')?.addEventListener('click', () => this.transitionPage('forward', () => this.renderBackupSettings()));
    this.root.querySelector('#dismiss-recovery')?.addEventListener('click', () => {
      this.uiPreferences.recoveryReminderDismissed = true;
      this.flushUiPreferencesSave();
      this.root.querySelector('.recovery-reminder')?.remove();
    });
    this.root.querySelector('#clear-upload-reminder')?.addEventListener('click', () => void this.clearPendingUploadPlans());
    this.bindReleaseUpdateButton();
    this.root.querySelector('#manage-devices')?.addEventListener('click', () => this.transitionPage('forward', () => void this.renderDeviceManager()));
    const replyClose = this.root.querySelector<HTMLButtonElement>('#reply-draft button');
    let replyCloseRetainsKeyboard = false;
    replyClose?.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      replyCloseRetainsKeyboard = document.activeElement === textarea
        || document.documentElement.dataset.keyboardOpen === 'true';
      if (replyCloseRetainsKeyboard) {
        event.preventDefault(); this.retainComposerKeyboard(event, textarea);
        if (document.activeElement !== textarea) this.restoreComposerFocus();
      }
    });
    const dismissReply = () => {
      this.replyTarget = null;
      this.renderReplyDraft();
      if (replyCloseRetainsKeyboard) this.restoreComposerFocus();
      replyCloseRetainsKeyboard = false;
    };
    replyClose?.addEventListener('click', dismissReply);
    replyClose?.addEventListener('touchend', event => {
      if (!replyCloseRetainsKeyboard) return;
      event.preventDefault(); dismissReply();
    }, { passive: false });
    replyClose?.addEventListener('pointercancel', () => {
      replyCloseRetainsKeyboard = false;
    });
    const moreMenu = this.root.querySelector<HTMLDetailsElement>('.more-menu');
    moreMenu?.addEventListener('toggle', () => {
      if (moreMenu.open) moreMenu.style.setProperty('--app-height', `${this.chatViewportHeight}px`);
    });
    moreMenu?.querySelector('summary')?.addEventListener('click', (event) => {
      if (!moreMenu.open) return;
      event.preventDefault();
      this.closeMoreMenu(moreMenu);
    });
    this.renderMessages({ scroll: this.restoreChatAnchorOnNextRender ? 'restore' : 'preserve' });
    this.renderReplyDraft();
    this.updatePeerStatus();
    this.updateCallControls();
    void this.updateBackgroundNotificationControl();
    this.showReleaseNotesIfNeeded();
  }

  private releaseUpdateBannerMarkup(): string {
    return this.availableReleaseId ? `
      <aside class="release-update-reminder" role="status">
        <strong>有新版本待更新</strong>
        <button type="button" data-release-update>更新</button>
      </aside>
    ` : '';
  }

  private bindReleaseUpdateButton(): void {
    this.root.querySelector('[data-release-update]')?.addEventListener('click', () => window.location.reload());
  }

  private renderReleaseUpdateBanner(): void {
    if (this.privacyCovered || this.activeSurface !== 'chat') return;
    const notices = this.root.querySelector<HTMLElement>('.system-notices');
    if (!notices || notices.querySelector('.release-update-reminder')) return;
    notices.insertAdjacentHTML('afterbegin', this.releaseUpdateBannerMarkup());
    this.bindReleaseUpdateButton();
  }

  private showReleaseNotesIfNeeded(): void {
    const session = this.session;
    const epoch = this.runtimeEpoch;
    if (!session || !hasPendingReleaseNotes() || this.root.querySelector('.release-notes-sheet')) return;
    const sheet = document.createElement('section');
    sheet.className = 'release-notes-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-labelledby', 'release-notes-title');
    const panel = document.createElement('div');
    panel.className = 'release-notes-panel';
    const eyebrow = document.createElement('p');
    eyebrow.className = 'eyebrow';
    eyebrow.textContent = '已更新至最新版本';
    const title = document.createElement('h2');
    title.id = 'release-notes-title';
    title.textContent = currentRelease.title;
    const list = document.createElement('ol');
    for (const note of pendingReleaseNotes()) {
      const item = document.createElement('li');
      item.textContent = note;
      list.append(item);
    }
    const button = document.createElement('button');
    button.className = 'icon-button release-notes-close';
    button.type = 'button';
    button.setAttribute('aria-label', '关闭更新说明'); button.title = '关闭'; button.innerHTML = icons.close;
    const header = document.createElement('header');
    header.className = 'release-notes-header';
    header.append(button, eyebrow, title);
    const details = document.createElement('div');
    details.className = 'release-notes-details';
    details.append(list);
    panel.tabIndex = -1;
    panel.append(header, details);
    sheet.append(panel);
    this.root.append(sheet);
    const dialog = mountDialog(sheet, {
      isActive: () => this.isRuntimeActive(epoch, session) && this.activeSurface === 'chat',
      signal: this.runtimeAbort?.signal,
      initialFocus: panel,
    });
    markReleaseNotesSeen();
    button.addEventListener('click', () => dialog.close());
  }

  private renderReleaseHistory(): void {
    if (!this.session || this.privacyCovered) return;
    this.captureChatAnchor(false); this.closeVoiceRecorder(); this.voicePlayback.stop();
    if (!this.setActiveSurface('away')) return;
    this.root.innerHTML = `<section class="device-shell release-history-page"><header class="subpage-header device-header"><button class="icon-button" id="release-history-back" type="button" aria-label="返回聊天">${icons.back}</button><div><h1>更新日志</h1></div><span></span></header><main class="device-content release-history-content"></main></section>`;
    const content = this.root.querySelector('.release-history-content')!;
    for (const release of releaseLog) {
      const section = document.createElement('section');
      const heading = document.createElement('h2'); heading.textContent = release.id;
      const date = document.createElement('time');
      const parts = release.id.split('.');
      date.dateTime = release.createdAt ?? parts.slice(0, 3).join('-');
      date.textContent = release.createdAt
        ? new Date(release.createdAt).toLocaleString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
        : `${parts[0]}年${Number(parts[1])}月${Number(parts[2])}日`;
      const list = document.createElement('ul');
      for (const note of release.notes) { const item = document.createElement('li'); item.textContent = note; list.append(item); }
      section.append(heading, date, list); content.append(section);
    }
    this.root.querySelector('#release-history-back')?.addEventListener('click', () => this.transitionPage('backward', () => this.renderChat()));
  }

  private commitChatViewportGeometry(): void {
    if (this.usesListScrolling) { this.pendingChatViewportGeometry = null; return; }
    if (this.nativeKeyboardDismiss) return;
    const geometry = this.pendingChatViewportGeometry;
    const chat = this.chatLayoutElements;
    if (!geometry || !chat?.shell.isConnected || geometry.generation !== this.chatLayoutGeneration) {
      this.pendingChatViewportGeometry = null;
      return;
    }
    if (this.nativeChatFollow?.list === chat.list) {
      this.nativeChatFollow.padding = geometry.paddingBottom;
      chat.list.style.setProperty('padding-bottom', `calc(${geometry.paddingBottom} + 128px)`, 'important');
    } else if (chat.list.style.getPropertyValue('padding-bottom') !== geometry.paddingBottom) {
      chat.list.style.setProperty('padding-bottom', geometry.paddingBottom);
    }
    if (chat.list.style.getPropertyValue('min-height') !== geometry.minHeight) {
      chat.list.style.setProperty('min-height', geometry.minHeight);
    }
    this.pendingChatViewportGeometry = null;
  }

  private mountChatLayout(): void {
    this.cancelViewportWork();
    this.chatKeyboardGesture?.destroy();
    this.chatBottomControl?.destroy();
    this.chatLayoutObserver?.disconnect();
    const shell = this.root.querySelector<HTMLElement>('.chat-shell')!;
    const list = shell.querySelector<HTMLElement>('#message-list')!;
    const header = shell.querySelector<HTMLElement>('.chat-header')!;
    const notices = shell.querySelector<HTMLElement>('.system-notices')!;
    const composer = shell.querySelector<HTMLElement>('.composer')!;
    const notice = shell.querySelector<HTMLElement>('#notice')!;
    const fixedOrigin = document.createElement('div');
    fixedOrigin.className = 'chat-fixed-origin';
    fixedOrigin.setAttribute('aria-hidden', 'true');
    const fixedBottom = fixedOrigin.cloneNode() as HTMLElement;
    fixedBottom.classList.add('chat-fixed-bottom');
    shell.append(fixedOrigin, fixedBottom);
    this.nativeChatFollow = null;
    this.chatLayoutElements = { shell, list, header, fixedOrigin, fixedBottom, composer, notices, notice };
    shell.dataset.scrollOwner = this.usesListScrolling ? 'list' : 'document';
    this.chatViewportMotion = createChatViewportMotion({
      // The native closed snapshot already arrives at the terminal position.
      // The message animation owns any remaining movement before reveal.
      settleDelay: target => this.visualClientCoordinates && target === 'closed' ? 0 : CHAT_VIEWPORT_SETTLE_MS,
      conceal: immediate => {
        const state = immediate ? 'positioning' : 'moving';
        if (composer.dataset.viewportMotion !== state) composer.dataset.viewportMotion = state;
        if (!this.nativeKeyboardDismiss && !this.chatKeyboardGesture?.held
          && document.documentElement.dataset.keyboardOpen !== 'true') this.commitNativeChatFollow();
      },
      reveal: () => { if (!this.nativeKeyboardDismiss) delete composer.dataset.viewportMotion; },
      settled: () => {
        if (this.privacyCovered || this.activeSurface !== 'chat' || !shell.isConnected) return;
        this.nativeKeyboardOpening = false;
        if (this.nativeKeyboardDismiss) return;
        const scrollBookkeepingPending = this.chatScrollBookkeepingPending;
        const documentMoved = this.chatScrollDocumentMovedPending;
        this.chatScrollBookkeepingPending = false;
        this.chatScrollDocumentMovedPending = false;
        this.commitChatViewportGeometry();
        // ResizeObserver may have noticed the keyboard-mode composer height,
        // but it deliberately does no document work while motion is active.
        // Refresh shared spacing without performing its own positioning, then
        // make the single endpoint alignment explicit before revealing.
        this.syncChatLayout(false);
        if (this.chatPinnedToBottom && this.chatScrollIntent !== 'up' && !this.chatBottomControl?.scrolling) {
          this.alignChatBottom();
        }
        // A wheel/touch scroll can finish while message-document reads are
        // intentionally paused. Settle its pagination, anchor, read receipt
        // and return-control state once, before revealing the composer.
        if (scrollBookkeepingPending) this.commitChatScrollBookkeeping(list, documentMoved);
        else this.updateChatBottomControl();
      },
    });
    this.chatKeyboardGesture = bindChatKeyboardGesture({
      list,
      input: composer.querySelector<HTMLTextAreaElement>('#message-input')!,
      active: () => !this.privacyCovered && this.activeSurface === 'chat' && shell.isConnected,
      begin: () => {
        this.chatViewportMotion?.touchStart();
        this.chatBottomControl?.cancel();
        this.cancelChatMessageMotion();
        this.chatResumeBottomOnFocus = this.chatPinnedToBottom && this.chatBottomGap() <= 2;
        this.chatRestoreAnchor = null;
        this.chatScrollIntent = 'up';
        this.chatPinnedToBottom = false;
        this.chatBottomFollowPending = false;
        this.chatViewportFollowUntil = 0;
      },
      release: () => {
        this.chatViewportMotion?.touchEnd();
        this.beginNativeKeyboardDismiss();
        this.chatViewportMotion?.keyboard('closed');
        this.keepComposerKeyboard = false;
        this.trackChatViewport();
      },
    });
    const bottomControlButton = composer.querySelector<HTMLButtonElement>('#chat-bottom-control')!;
    this.chatBottomControl = mountChatBottomControl({
      button: bottomControlButton,
      list,
      latest: () => this.renderedMessageOrder.at(-1),
      hasNewer: () => this.historyHasNewer,
      visibilityTop: () => {
        const composerBounds = composer.getBoundingClientRect();
        const revealOffset = composerBounds.top - this.chatComposerLayoutTop(composer);
        return bottomControlButton.getBoundingClientRect().top - revealOffset;
      },
      targetScrollTop: () => this.chatBottomScrollTop(),
      scrollTop: () => this.chatScrollTop,
      scrollTo: top => this.setChatScrollTop(top),
      active: () => !this.privacyCovered && this.activeSurface === 'chat' && shell.isConnected,
      measure: () => !this.chatViewportMotion?.moving && !this.composerHeightMotion,
      begin: () => {
        this.replyJumpVersion += 1;
        this.chatViewportMotion?.automaticScroll();
        this.cancelChatMessageMotion();
        this.chatRestoreAnchor = null;
        this.chatScrollIntent = null;
        this.chatPinnedToBottom = false;
        this.chatBottomFollowPending = false;
        this.chatViewportFollowUntil = 0;
        this.chatResumeBottomOnFocus = false;
      },
      prepare: signal => this.historyHasNewer ? this.prepareChatBottomScroll(list, signal) : undefined,
      resized: () => {
        // A queued size notification must not undo a newer document scroll
        // before its ordinary scroll bookkeeping has run.
        if (this.chatPinnedToBottom && this.chatScrollIntent !== 'up' && !this.chatBottomControl?.scrolling
          && Math.abs(this.chatScrollTop - this.chatLastScrollY) <= 1) this.alignChatBottom();
      },
      complete: () => {
        this.scrollChatToBottom();
        this.captureChatAnchor(true);
        this.markVisibleMessagesRead();
        if (this.bottomControlRetainsKeyboard) {
          this.bottomControlRetainsKeyboard = false;
          this.restoreComposerFocus();
        }
      },
    });
    this.chatLayoutGeneration += 1;
    let previousMeasurements = '';
    const sync = (position = true) => {
      if (!shell.isConnected || this.chatViewportMotion?.moving || this.composerHeightMotion || this.nativeKeyboardDismiss) return;
      const headerHeight = header.offsetHeight;
      const noticesHeight = notices.offsetHeight;
      const composerHeight = composer.offsetHeight;
      const measurements = `${headerHeight}:${noticesHeight}:${composerHeight}`;
      if (measurements === previousMeasurements) return;
      previousMeasurements = measurements;
      const pinned = this.chatPinnedToBottom;
      const anchor = position ? this.captureChatAnchor() : null;
      shell.style.setProperty('--chat-header-height', `${headerHeight}px`);
      shell.style.setProperty('--chat-top-space', `${headerHeight + noticesHeight + 14}px`);
      shell.style.setProperty('--chat-bottom-space', `${composerHeight + CHAT_LATEST_GAP}px`);
      document.documentElement.style.setProperty('--chat-top-space', `${headerHeight + noticesHeight + 14}px`);
      document.documentElement.style.setProperty('--chat-bottom-space', `${composerHeight + CHAT_LATEST_GAP}px`);
      // Padding changes can clamp native document scrolling even for a reader
      // who has not requested bottom following. Correct chrome in this task.
      this.refreshNativeChatChrome();
      if (position) {
        if (pinned) this.scrollChatToBottom();
        else if (anchor) this.restoreChatAnchor(list, anchor);
        this.updateChatBottomControl();
      }
    };
    this.syncChatLayout = sync;
    this.syncViewport();
    this.updateChatBottomControl();
    sync();
    this.trackChatViewport();
    this.chatLayoutObserver = new ResizeObserver(() => sync());
    // Observe controls, not the document-height shell: changing message padding
    // also resizes that shell and creates a ResizeObserver feedback loop in WebKit.
    for (const element of [header, notices, composer]) this.chatLayoutObserver.observe(element);
    if (this.presenceRefreshTimer !== null) window.clearInterval(this.presenceRefreshTimer);
    this.presenceRefreshTimer = window.setInterval(() => this.updatePeerStatus(), 30_000);
  }

  private retainComposerKeyboard(event: PointerEvent, textarea: HTMLTextAreaElement): void {
    if (document.activeElement !== textarea) return;
    this.keepComposerKeyboard = true;
    this.composerSelection = {
      start: textarea.selectionStart ?? textarea.value.length,
      end: textarea.selectionEnd ?? textarea.value.length,
    };
    event.preventDefault();
  }

  private restoreComposerFocus(): void {
    const textarea = this.root.querySelector<HTMLTextAreaElement>('#message-input');
    if (!textarea || textarea.disabled || this.privacyCovered) return;
    this.keepComposerKeyboard = false;
    const selection = this.composerSelection ?? {
      start: textarea.selectionStart ?? textarea.value.length,
      end: textarea.selectionEnd ?? textarea.value.length,
    };
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(
      Math.min(selection.start, textarea.value.length),
      Math.min(selection.end, textarea.value.length),
    );
    this.composerSelection = null;
  }

  private closeMoreMenu(menu: HTMLDetailsElement, restoreFocus = false): void {
    if (menu.classList.contains('is-closing')) return;
    menu.classList.add('is-closing');
    window.setTimeout(() => {
      menu.open = false;
      menu.classList.remove('is-closing');
      if (restoreFocus && menu.isConnected && !this.privacyCovered) menu.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true });
    }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 320);
  }

  private async renderDeviceManager(): Promise<void> {
    const session = this.session;
    if (!session || this.privacyCovered) return;
    if (!this.setActiveSurface('away')) return;
    this.root.innerHTML = `
      <section class="device-shell">
        <header class="subpage-header device-header">
          <button class="icon-button" id="device-back" type="button" aria-label="返回聊天">${icons.back}</button>
          <div><h1>设备管理</h1><p>独立密钥 · 新设备只看新消息</p></div>
          <button class="icon-button" id="refresh-devices" type="button" aria-label="刷新设备状态">↻</button>
        </header>
        <div class="notice device-notice" id="notice" role="status" hidden></div>
        <main class="device-content">
          <aside class="device-security-note"><strong>你来决定哪些设备可以加入</strong><span>新设备只能查看加入后的消息。移除设备后，它将无法接收新消息。</span></aside>
          <div class="device-loading">正在验证设备状态…</div>
        </main>
      </section>
    `;
    this.root.querySelector('#device-back')?.addEventListener('click', () => this.transitionPage('backward', () => this.renderChat()));
    this.root.querySelector('#refresh-devices')?.addEventListener('click', () => void this.renderDeviceManager());
    try {
      const result = await listDeviceLinks(session.vault.roomId, session.vault.accessToken);
      if (this.session !== session || this.privacyCovered) return;
      await this.applyRoomStateQueued(result.state);
      if (this.session !== session || this.privacyCovered) return;
      const content = this.root.querySelector<HTMLElement>('.device-content');
      if (!content) return;
      content.querySelector('.device-loading')?.remove();

      const ownId = session.vault.identity.publicBundle.deviceId;
      const active = session.vault.members.filter((member) => member.status === undefined || member.status === 'active');
      const ownDevices = active.filter((member) => member.role === session.vault.role);
      const ownReservedDevices = session.vault.members.filter((member) =>
        member.role === session.vault.role && member.status !== 'revoked',
      );
      const peerDevices = active.filter((member) => member.role !== session.vault.role);
      const pendingClaims = result.links
        .filter((link) => link.claimedDeviceId && !link.usedAt)
        .map((link) => ({ link, member: session.vault.members.find((member) => member.deviceId === link.claimedDeviceId) }))
        .filter((item): item is typeof item & { member: RoomMember } => Boolean(item.member?.status === 'pending'));

      const toolbar = document.createElement('section');
      toolbar.className = 'device-toolbar';
      const heading = document.createElement('div');
      heading.innerHTML = `<strong>你的设备</strong><span>${ownDevices.length} / 3 台</span>`;
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'primary-button compact-button';
      add.textContent = '添加设备';
      add.disabled = ownReservedDevices.length >= 3 || session.vault.protocol !== 'mls-rfc9420';
      add.addEventListener('click', () => void this.startDeviceLink(add));
      toolbar.append(heading, add);
      content.append(toolbar);

      if (pendingClaims.length > 0) {
        const section = document.createElement('section');
        section.className = 'device-section';
        section.innerHTML = '<h2>等待你批准</h2>';
        for (const { link, member } of pendingClaims) {
          const card = this.deviceCard(member, false);
          card.classList.add('pending-device-card');
          const code = document.createElement('code');
          code.className = 'device-inline-code';
          code.textContent = await deviceLinkSafetyCode(link.linkId, session.vault.members.find((item) => item.deviceId === link.authorizerId)!, member);
          const note = document.createElement('p');
          note.textContent = '请确认新设备显示相同的六位安全码。';
          const approve = document.createElement('button');
          approve.type = 'button';
          approve.className = 'primary-button compact-button';
          approve.textContent = '安全码一致，允许加入';
          approve.addEventListener('click', () => void this.changeMlsMembership('add', member, approve));
          card.append(code, note, approve);
          section.append(card);
        }
        content.append(section);
      }

      const ownSection = document.createElement('section');
      ownSection.className = 'device-section';
      ownSection.innerHTML = '<h2>已授权设备</h2>';
      for (const member of ownDevices) {
        const card = this.deviceCard(member, member.deviceId === ownId);
        if (member.deviceId !== ownId && ownDevices.length > 1) {
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'danger-button compact-button';
          remove.textContent = '移除';
          remove.addEventListener('click', () => {
            if (this.confirmSystemAction(`移除“${member.deviceName ?? '这台设备'}”？它将无法解密之后的新消息。`)) {
              void this.changeMlsMembership('remove', member, remove);
            }
          });
          card.append(remove);
        }
        ownSection.append(card);
      }
      content.append(ownSection);

      const peerSection = document.createElement('section');
      peerSection.className = 'device-section peer-device-section';
      peerSection.innerHTML = `<h2>对方设备 <span>${peerDevices.length} 台</span></h2>`;
      for (const member of peerDevices) peerSection.append(this.deviceCard(member, false));
      content.append(peerSection);
    } catch (cause) {
      this.operationalError(cause, '设备状态载入失败');
      const loading = this.root.querySelector<HTMLElement>('.device-loading');
      if (loading) loading.textContent = cause instanceof Error ? cause.message : '设备状态载入失败';
    }
  }

  private deviceCard(member: RoomMember, current: boolean): HTMLElement {
    const card = document.createElement('article');
    card.className = 'device-card';
    const copy = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = member.deviceName ?? '未命名设备';
    if (current) {
      const badge = document.createElement('span');
      badge.className = 'device-current-badge';
      badge.textContent = '当前设备';
      title.append(' ', badge);
    }
    const detail = document.createElement('small');
    const date = member.lastSeenAt ?? member.createdAt;
    detail.textContent = date ? `${member.status === 'pending' ? '申请于' : '最近活动'} ${new Date(date).toLocaleString('zh-CN')}` : '活动时间未知';
    copy.append(title, detail);
    if ((member.status === undefined || member.status === 'active')
      && (!member.capabilities?.includes('message-read-v1') || !member.capabilities?.includes('media-read-v1'))) {
      const readStatus = document.createElement('small');
      readStatus.className = 'device-read-update';
      readStatus.textContent = '已读同步待更新：请在这台设备打开最新版';
      copy.append(readStatus);
    }
    card.append(copy);
    return card;
  }

  private async startDeviceLink(button: HTMLButtonElement): Promise<void> {
    const session = this.session;
    const epoch = this.runtimeEpoch;
    if (!session || this.privacyCovered) return;
    setBusy(button, true, '正在生成…');
    try {
      const own = session.vault.members.find((member) => member.deviceId === session.vault.identity.publicBundle.deviceId);
      const creator = session.vault.members.find((member) => member.role === 'creator' && !member.addedBy);
      if (!own || !creator) throw new SecurityViolation('本机成员身份不完整');
      const linkId = crypto.randomUUID();
      const secret = randomBase64Url(32);
      const createdAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
      await createDeviceLink(
        session.vault.roomId,
        session.vault.accessToken,
        own.deviceId,
        linkId,
        secret,
        expiresAt,
        this.runtimeAbort?.signal,
      );
      if (!this.isRuntimeActive(epoch, session) || !button.isConnected) return;
      const pending = { linkId, secret, expiresAt, createdAt };
      await withVaultMutation(session, async (mutation) => {
        if (!this.isRuntimeActive(epoch, session)) return;
        session.vault.pendingDeviceLinks = [
          ...(session.vault.pendingDeviceLinks ?? []).filter((item) => Date.parse(item.expiresAt) > Date.now()),
          pending,
        ];
        await saveVault(session, mutation);
      });
      if (!this.isRuntimeActive(epoch, session) || !button.isConnected) return;
      const invite: DeviceInvite = {
        v: 1,
        kind: 'device-link',
        roomId: session.vault.roomId,
        linkId,
        secret,
        role: session.vault.role,
        authorizerId: own.deviceId,
        authorizerFingerprint: await bundleFingerprint(memberBundle(own)),
        creatorFingerprint: await bundleFingerprint(memberBundle(creator)),
        expiresAt,
      };
      if (!this.isRuntimeActive(epoch, session) || !button.isConnected) return;
      await this.showDeviceInvite(invite, session, epoch, button);
    } catch (cause) {
      if (this.isRuntimeActive(epoch, session)) this.operationalError(cause, '设备链接生成失败');
    } finally {
      if (button.isConnected) setBusy(button, false);
    }
  }

  private async showDeviceInvite(invite: DeviceInvite, session = this.session, epoch = this.runtimeEpoch, returnFocus?: HTMLElement): Promise<void> {
    if (!session || !this.isRuntimeActive(epoch, session)) return;
    const url = makeDeviceInviteUrl(invite);
    this.root.querySelector('.device-link-sheet')?.remove();
    const generation = ++this.deviceInviteGeneration;
    const sheet = document.createElement('section');
    sheet.className = 'device-link-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-labelledby', 'device-link-title');
    sheet.innerHTML = `
      <div class="device-link-panel">
        <p class="eyebrow">10 分钟内有效</p>
        <h2 id="device-link-title">在新设备上打开</h2>
        <canvas width="232" height="232" aria-label="添加设备二维码"></canvas>
        <p>新设备只会收到你批准加入之后的新消息。加入前的历史密钥不会复制过去。</p>
        <input readonly aria-label="设备链接" />
        <div><button class="secondary-button" type="button" data-copy>复制链接</button><button class="primary-button" type="button" data-close>完成</button></div>
      </div>
    `;
    const input = sheet.querySelector<HTMLInputElement>('input')!;
    input.value = url;
    this.root.append(sheet);
    const dialog = mountDialog(sheet, {
      isActive: () => this.isRuntimeActive(epoch, session),
      signal: this.runtimeAbort?.signal,
      returnFocus,
      initialFocus: sheet.querySelector<HTMLButtonElement>('[data-close]'),
    });
    sheet.querySelector('[data-close]')?.addEventListener('click', () => dialog.close());
    sheet.addEventListener('click', (event) => { if (event.target === sheet) dialog.close(); });
    sheet.querySelector('[data-copy]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      try {
        const write = this.clipboardWriteChain.catch(() => undefined).then(() => navigator.clipboard.writeText(url));
        this.clipboardWriteChain = write.catch(() => undefined);
        await this.withSystemSurface(() => write);
        if (!this.isRuntimeActive(epoch, session) || !sheet.isConnected || generation !== this.deviceInviteGeneration) return;
        button.textContent = '已复制';
      } catch {
        if (!this.isRuntimeActive(epoch, session) || !sheet.isConnected || generation !== this.deviceInviteGeneration) return;
        input.select();
        button.textContent = document.execCommand('copy') ? '已复制' : '请选择链接后复制';
      }
    });
    try {
      await QRCode.toCanvas(sheet.querySelector('canvas'), url, {
        width: 232,
        margin: 1,
        color: { dark: '#2f4037', light: '#f5f3ee' },
        errorCorrectionLevel: 'M',
      });
    } catch {
      if (this.isRuntimeActive(epoch, session) && sheet.isConnected) this.showNotice('二维码暂时无法生成，可以复制设备链接');
    }
  }

  private async changeMlsMembership(
    action: 'add' | 'remove',
    target: RoomMember,
    button: HTMLButtonElement,
  ): Promise<void> {
    const session = this.session;
    if (!session?.vault.mls) return;
    const epoch = this.runtimeEpoch;
    setBusy(button, true, action === 'add' ? '正在安全加入…' : '正在移除…');
    try {
      await withVaultMutation(session, async (mutation) => {
        if (!this.isRuntimeActive(epoch, session) || !session.vault.mls) return;
        let pending = session.vault.mls.pendingMembership;
        if (pending && (pending.event.action !== action || pending.event.targetId !== target.deviceId)) {
          throw new Error('另一个设备变更尚待服务器确认，请先刷新');
        }
        if (!pending) {
          pending = await prepareMlsMembership(session.vault, action, target);
          session.vault.mls.pendingMembership = pending;
          await saveVault(session, mutation);
        }
        const result = await publishMlsMembership(session.vault.roomId, session.vault.accessToken, pending.event);
        if (this.isRuntimeActive(epoch, session)) await this.applyRoomState(result.state, mutation);
      });
      if (!this.isRuntimeActive(epoch, session)) return;
      this.showNotice(action === 'add' ? '新设备已加入；群组密钥已轮换' : '设备已移除；之后的新消息密钥已轮换');
      await this.renderDeviceManager();
    } catch (cause) {
      if (cause instanceof ApiError && !cause.retryable) {
        await withVaultMutation(session, async (mutation) => {
          if (!this.isRuntimeActive(epoch, session) || !session.vault.mls) return;
          session.vault.mls.pendingMembership = undefined;
          await saveVault(session, mutation);
        }).catch(() => undefined);
      }
      this.operationalError(cause, action === 'add' ? '设备加入失败' : '设备移除失败');
      if (button.isConnected) setBusy(button, false);
    }
  }

  private transitionPage(direction: 'forward' | 'backward', render: () => void): void {
    if (this.privacyCovered) return;
    this.closeImageViewer(true);
    this.clearMessageTextSelection();
    this.closeMessageActions(false, false);
    this.closeVoiceRecorder();
    this.voicePlayback.stop();
    if (this.root.querySelector('#message-list')) {
      this.captureChatAnchor(true);
      this.restoreChatAnchorOnNextRender = true;
    }
    if (this.pageTransitionTimer !== null) window.clearTimeout(this.pageTransitionTimer);
    this.root.querySelectorAll(':scope > .page-transition-outgoing').forEach(node => node.remove());
    this.root.querySelector(':scope > .page-transition-incoming')?.classList.remove('page-transition-incoming');
    const epoch = this.runtimeEpoch;
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const outgoing = !reducedMotion && this.root.firstElementChild instanceof HTMLElement
      ? this.root.firstElementChild : null;
    const outgoingScrollY = this.usesListScrolling && outgoing?.classList.contains('chat-shell') ? 0 : window.scrollY;
    outgoing?.remove();
    this.root.dataset.pageTransition = direction;
    render();
    if (this.privacyCovered || this.runtimeEpoch !== epoch) return;
    const incoming = this.root.firstElementChild instanceof HTMLElement ? this.root.firstElementChild : null;
    if (!outgoing || !incoming) {
      delete this.root.dataset.pageTransition;
      return;
    }
    const outgoingFrame = document.createElement('div');
    outgoingFrame.className = 'page-transition-outgoing';
    if (incoming.classList.contains('gallery-shell') && outgoing.classList.contains('chat-shell')) {
      outgoingFrame.dataset.safeDeparture = '';
    }
    outgoingFrame.append(outgoing);
    outgoing.setAttribute('aria-hidden', 'true');
    outgoing.inert = true;
    const oldList = outgoing.querySelector<HTMLElement>('.message-list');
    if (oldList && outgoingScrollY > 0) oldList.style.setProperty('--page-scroll-offset', `${-outgoingScrollY}px`);
    // Keep content reveal suppressed after the directional animation ends.
    incoming.dataset.pageNavigation = '';
    incoming.classList.add('page-transition-incoming');
    this.root.append(outgoingFrame);
    this.pageTransitionTimer = window.setTimeout(() => {
      outgoingFrame.remove();
      incoming.classList.remove('page-transition-incoming');
      delete this.root.dataset.pageTransition;
      this.pageTransitionTimer = null;
    }, 400);
  }

  private markVisibleMessagesRead(): void {
    const session = this.session;
    const list = this.root.querySelector<HTMLElement>('#message-list');
    if (!session || this.privacyCovered || document.hidden || !document.hasFocus() || document.documentElement.classList.contains('privacy-obscured')
      || this.root.classList.contains('portrait-blocked') || this.activeSurface !== 'chat' || this.callView || this.memePicker || !list || this.chatRestoreAnchor) return;
    const top = this.root.querySelector('.chat-header')?.getBoundingClientRect().bottom ?? list.getBoundingClientRect().top;
    const composer = this.root.querySelector<HTMLElement>('#composer');
    const bottom = composer ? this.chatComposerLayoutTop(composer) : list.getBoundingClientRect().bottom;
    // Rows are in document order. Jump over newer, below-screen history before
    // testing intersection; reading an old page must not measure every row.
    let low = 0;
    let high = this.renderedMessageOrder.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (this.renderedMessageOrder[middle]!.getBoundingClientRect().top < bottom) low = middle + 1;
      else high = middle;
    }
    let seq = 0;
    for (let index = low - 1; index >= 0; index--) {
      const article = this.renderedMessageOrder[index]!;
      const rect = article.getBoundingClientRect();
      if (rect.bottom < top) break;
      if (rect.top < bottom && rect.bottom > top) {
        const candidate = this.renderedMessageSeq.get(article.dataset.clientMsgId ?? '') ?? 0;
        if (candidate < Number.MAX_SAFE_INTEGER) {
          seq = Math.max(seq, candidate);
          this.queueVisibleMediaRead(article, candidate);
          this.queueVisibleMessageRead(candidate);
        }
      }
    }
    if (seq > 0) void this.unreadCounter.markRead(session.vault, seq, this.runtimeAbort?.signal);
  }

  private queueVisibleMessageRead(seq: number): void {
    const message = this.messages.get(seq);
    if (!message || !isReadableChatMessage(message) || isChatMedia(message) || this.isOwnMessage(message)
      || !document.hasFocus() || this.voiceRecorder || this.root.querySelector('.message-actions')
      || !this.activeDevicesSupport('message-read-v1') || this.messageReadQueued.has(message.clientMsgId)) return;
    const previous = [...this.messageEventHistory.values(), ...this.messages.values(), ...this.pending.values()];
    if (previous.some(event => event.payload.kind === 'message-read' && this.isOwnMessage(event)
      && event.payload.target.clientMsgId === message.clientMsgId
      && event.payload.target.serverSeq === message.seq && event.payload.target.senderId === message.senderId)) return;
    this.messageReadQueued.add(message.clientMsgId);
    const session = this.session;
    const epoch = this.runtimeEpoch;
    void this.enqueuePayload({ v: 1, kind: 'message-read', sentAt: new Date().toISOString(),
      target: { clientMsgId: message.clientMsgId, serverSeq: message.seq, senderId: message.senderId },
    }).catch(() => {
      if (session && this.isRuntimeActive(epoch, session)) this.messageReadQueued.delete(message.clientMsgId);
    });
  }

  private queueVisibleMediaRead(article: HTMLElement, seq: number): void {
    const message = this.messages.get(seq);
    if (!message || !isChatMedia(message) || this.isOwnMessage(message) || !document.hasFocus()
      || !this.activeDevicesSupport('media-read-v1') || this.mediaReadQueued.has(message.clientMsgId)) return;
    const previews = [...article.querySelectorAll<HTMLElement>('.image-preview')];
    if (!previews.length || previews.some(preview => preview.dataset.imageState !== 'loaded' || preview.dataset.revealed !== 'true')) return;
    const previous = [...this.messageEventHistory.values(), ...this.messages.values(), ...this.pending.values()];
    if (previous.some(event => event.payload.kind === 'media-read' && this.isOwnMessage(event)
      && event.payload.target.clientMsgId === message.clientMsgId
      && event.payload.target.serverSeq === message.seq && event.payload.target.senderId === message.senderId)) return;
    this.mediaReadQueued.add(message.clientMsgId);
    const session = this.session;
    const epoch = this.runtimeEpoch;
    void this.enqueuePayload({ v: 1, kind: 'media-read', sentAt: new Date().toISOString(),
      target: { clientMsgId: message.clientMsgId, serverSeq: message.seq, senderId: message.senderId },
    }).catch(() => {
      if (session && this.isRuntimeActive(epoch, session)) this.mediaReadQueued.delete(message.clientMsgId);
    });
  }

  private setActiveSurface(surface: 'away' | 'chat'): boolean {
    if (surface === 'away' && this.invalidateKeyboardHandoff()) return false;
    if (surface === 'away') this.closeMemePicker();
    this.stopViewerMedia();
    if (surface === 'away') {
      this.presenceCircuit?.destroy();
      this.presenceCircuit = null;
      this.clearKeyboardHandoff();
      this.chatImageConcealGesture?.reset();
      this.cancelViewportWork();
      this.closeVoiceRecorder();
      this.voicePlayback.stop();
    }
    if (surface === 'chat') {
      this.galleryViewportHeader = null;
      if (this.activeSurface !== 'chat') this.rolePresence = null;
    }
    this.activeSurface = surface;
    this.socket?.setChatPresence(surface === 'chat' && !this.root.classList.contains('portrait-blocked'));
    this.syncViewport();
    this.updateChatBottomControl();
    // Viewer dismissal reuses the same chat DOM and viewport geometry. Resume
    // sampling explicitly even when syncViewport has no resize work to do.
    if (surface === 'chat') this.trackChatViewport();
    return true;
  }

  private scheduleChatScroll(): void {
    if (this.chatScrollFrame !== null || this.privacyCovered || this.activeSurface !== 'chat') return;
    this.chatScrollFrame = requestAnimationFrame(() => {
      this.chatScrollFrame = null;
      const list = this.chatLayoutElements?.list;
      if (!list?.isConnected || this.privacyCovered || this.activeSurface !== 'chat') return;
      const documentMoved = Math.abs(this.chatScrollTop - this.chatLastScrollY) > 1;
      this.chatLastScrollY = this.chatScrollTop;
      const actions = this.root.querySelector<HTMLElement>('.message-actions:not(.is-closing)');
      // Menu ownership depends only on an actual document displacement. Close
      // it even while broader row/bottom geometry work is paused.
      if (actions && Math.abs(this.chatScrollTop - Number(actions.dataset.openScrollY)) > 1) this.closeMessageActions(false, false);
      // Native focus/keyboard scrolling is bookkeeping noise until the visual
      // viewport reaches its endpoint. The settled callback owns the single
      // document alignment and visibility measurement for that transition.
      if (this.chatViewportMotion?.moving) {
        if (documentMoved) {
          this.chatScrollBookkeepingPending = true;
          this.chatScrollDocumentMovedPending = true;
        }
        return;
      }
      const movedSinceLastCommit = documentMoved || this.chatScrollDocumentMovedPending;
      if (!this.chatScrollBookkeepingPending && !movedSinceLastCommit) return;
      this.chatScrollBookkeepingPending = false;
      this.chatScrollDocumentMovedPending = false;
      this.commitChatScrollBookkeeping(list, movedSinceLastCommit);
    });
  }

  private commitChatScrollBookkeeping(list: HTMLElement, documentMoved: boolean): void {
    if (!list.isConnected || this.privacyCovered || this.activeSurface !== 'chat') return;
    // The return control already owns this document movement and performs
    // one final alignment/read update. Avoid measuring rows, composer and
    // visibility on every animation frame while the keyboard compositor is
    // active; that forced layout was the main source of scroll jank.
    if (this.chatBottomControl?.scrolling) return;
    const gap = this.chatBottomGap();
    // Native focus scrolling can land after the final viewport event. Retry
    // that displacement too, without turning offset-only viewport pans into
    // document scrolls or overriding a user's history gesture.
    if (documentMoved && this.chatPinnedToBottom && this.chatScrollIntent !== 'up'
      && performance.now() < this.chatViewportFollowUntil
      && Math.abs(this.chatBottomScrollTop() - this.chatScrollTop) > 2) {
      this.chatBottomFollowPending = true;
      this.trackChatViewport();
    }
    // Content growth alone is not a reader leaving the bottom. Preserve
    // that intent until ResizeObserver aligns the settled message geometry.
    this.chatPinnedToBottom = !this.chatRestoreAnchor && this.chatScrollIntent !== 'up'
      && (gap <= 2 || this.chatBottomFollowPending || (this.chatPinnedToBottom && (!documentMoved || performance.now() < this.chatViewportFollowUntil)));
    if (this.chatScrollTop < 80) void this.loadOlderHistory(list);
    if (gap < 80) void this.loadNewerHistory(list);
    this.captureChatAnchor(true, false, gap);
    this.markVisibleMessagesRead();
    this.updateChatBottomControl();
  }

  private captureChatAnchor(persist = false, preservePosition = false, knownBottomGap?: number): ChatScrollAnchor | null {
    const list = this.root.querySelector<HTMLElement>('#message-list');
    if (!list) return this.uiPreferences.chatAnchor ?? null;
    // A tall photo can temporarily become a short placeholder after unlock.
    // Keep its saved position until it decodes, instead of switching to the next row.
    if (this.chatRestoreAnchor) return this.chatRestoreAnchor;
    const articles = this.renderedMessageOrder[0]?.parentElement === list
      ? this.renderedMessageOrder
      : [...list.querySelectorAll<HTMLElement>('.message[data-client-msg-id]')];
    if (articles.length === 0) return null;
    const pinnedToBottom = !preservePosition && this.chatPinnedToBottom && this.chatScrollIntent !== 'up'
      && (this.chatBottomFollowPending || performance.now() < this.chatViewportFollowUntil || (knownBottomGap ?? this.chatBottomGap()) <= 48);
    const listTop = this.chatViewportTop;
    // Message rows are laid out monotonically. Avoid reading every older row
    // (and sorting every payload) on each touch-scroll event.
    let low = 0;
    let high = articles.length - 1;
    while (!pinnedToBottom && low < high) {
      const middle = Math.floor((low + high) / 2);
      if (articles[middle]!.getBoundingClientRect().bottom > listTop) high = middle;
      else low = middle + 1;
    }
    const visible = pinnedToBottom ? articles.at(-1)! : articles[low]!;
    const clientMsgId = visible.dataset.clientMsgId ?? '';
    const messageSeq = this.renderedMessageSeq.get(clientMsgId);
    if (messageSeq === undefined || !clientMsgId) return null;
    const seq = Number.isSafeInteger(messageSeq) && messageSeq < Number.MAX_SAFE_INTEGER
      ? messageSeq
      : this.session?.vault.lastSeq ?? 0;
    const anchor: ChatScrollAnchor = {
      clientMsgId,
      seq,
      offset: pinnedToBottom ? 0 : visible.getBoundingClientRect().top - listTop,
      pinnedToBottom,
    };
    this.uiPreferences.chatAnchor = anchor;
    if (persist) this.scheduleUiPreferencesSave();
    return anchor;
  }

  private restoreChatAnchor(list: HTMLElement, anchor: ChatScrollAnchor | null | undefined): void {
    if (!list.isConnected) return;
    if (!anchor || anchor.pinnedToBottom) {
      this.scrollChatToBottom();
      return;
    }
    const target = list.querySelector<HTMLElement>(`.message[data-client-msg-id="${CSS.escape(anchor.clientMsgId)}"]`);
    if (!target) {
      this.scrollChatToBottom();
      return;
    }
    // A temporary empty/cold list may have queued bottom follow during restore.
    // Once the history target exists, that fallback must not replace its anchor.
    this.chatBottomFollowPending = false;
    this.chatPinnedToBottom = false;
    this.chatViewportFollowUntil = 0;
    // Page-transition transforms can temporarily move fixed composer geometry.
    // A restored history position remains a reading intent until user action.
    if (this.chatRestoreAnchor) this.chatScrollIntent = 'up';
    const delta = target.getBoundingClientRect().top - this.chatViewportTop - anchor.offset;
    if (Math.abs(delta) > 1) this.setChatScrollTop(this.chatScrollTop + delta);
  }

  private get chatScrollTop(): number {
    const list = this.chatLayoutElements?.list;
    return this.usesListScrolling && list?.isConnected ? list.scrollTop : window.scrollY;
  }

  private setChatScrollTop(top: number): void {
    const list = this.chatLayoutElements?.list;
    if (this.usesListScrolling && list?.isConnected) list.scrollTop = top;
    else window.scrollTo(0, top);
  }

  private chatBottomGap(): number {
    return Math.max(0, this.chatBottomScrollTop() - this.chatScrollTop);
  }

  private positionChatChrome(viewportTop: number, viewportHeight: number, layoutHeight: number): void {
    const chat = this.chatLayoutElements;
    if (!chat?.shell.isConnected) return;
    const setStyle = (style: CSSStyleDeclaration, property: string, value: string) => {
      if (style.getPropertyValue(property) !== value) style.setProperty(property, value);
    };
    const nativeChrome = String(this.visualClientCoordinates);
    if (chat.shell.dataset.nativeChrome !== nativeChrome) chat.shell.dataset.nativeChrome = nativeChrome;
    if (this.usesListScrolling) {
      setStyle(chat.shell.style, 'top', `${window.scrollY}px`);
      const height = this.listKeyboardLayout.sample({ height: viewportHeight, layoutHeight,
        width: window.visualViewport?.width ?? window.innerWidth }, performance.now(),
        matchMedia('(prefers-reduced-motion: reduce)').matches);
      const transition = this.listKeyboardLayout.transition;
      if (transition && transition.to !== null && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const target = transition.to;
        const baseHeight = Math.max(transition.from, target);
        setStyle(chat.shell.style, 'height', `${baseHeight}px`);
        if (this.chatKeyboardSurfaceMotion?.started !== transition.started || this.chatKeyboardSurfaceMotion.target !== transition.to) {
          this.cancelListKeyboardSurfaceMotion();
          const frames = Array.from({ length: 25 }, (_, index) => {
            const offset = index / 24;
            const current = transition.from + (target - transition.from) * chatKeyboardLayoutProgress(offset * CHAT_KEYBOARD_LAYOUT_MS);
            return { offset, transform: `translate3d(0, ${current - baseHeight}px, 0)` };
          });
          const elements = this.chatPinnedToBottom && this.chatScrollIntent !== 'up' ? [chat.composer, chat.list] : [chat.composer];
          const animations = elements.map(element => element.animate(frames, { duration: CHAT_KEYBOARD_LAYOUT_MS, fill: 'both' }));
          // DocumentTimeline shares performance's time origin. Its sampled
          // currentTime can lag during native focus; do not subtract that lag twice.
          for (const animation of animations) animation.startTime = transition.started;
          this.chatKeyboardSurfaceMotion = { started: transition.started, target: transition.to, animations };
        }
      } else {
        this.cancelListKeyboardSurfaceMotion();
        setStyle(chat.shell.style, 'height', `${height}px`);
      }
      setStyle(chat.header.style, 'top', '0px');
      setStyle(chat.header.style, 'translate', 'none');
      setStyle(chat.composer.style, 'bottom', '0px');
      setStyle(chat.notices.style, 'translate', 'none');
      setStyle(chat.notice.style, 'translate', '0 calc(var(--chat-header-height) + 8px)');
      return;
    }
    const fixedTop = this.visualClientCoordinates ? -chat.fixedOrigin.getBoundingClientRect().top : viewportTop;
    setStyle(chat.header.style, 'top', this.visualClientCoordinates ? `${fixedTop}px` : '0px');
    setStyle(chat.header.style, 'translate', this.visualClientCoordinates ? 'none' : `0 ${fixedTop}px`);
    // Safari toolbar collapse can expand the actual fixed-position bottom
    // before clientHeight updates. Measure that edge independently of the
    // top origin, or the stale height pushes the composer under native chrome.
    const fixedBottom = this.visualClientCoordinates
      ? chat.fixedBottom.getBoundingClientRect().top : layoutHeight - fixedTop;
    setStyle(chat.composer.style, 'bottom', `${fixedBottom - viewportHeight}px`);
    setStyle(chat.notices.style, 'translate', `0 ${fixedTop}px`);
    setStyle(chat.notice.style, 'translate', `0 calc(${fixedTop}px + var(--chat-header-height) + 8px)`);
  }

  private beginListKeyboardLayout(direction: 'open' | 'closed'): void {
    const chat = this.chatLayoutElements;
    if (!this.usesListScrolling || !chat?.shell.isConnected || this.privacyCovered || this.activeSurface !== 'chat') return;
    const viewport = window.visualViewport;
    if (direction === 'closed' && this.chatResumeBottomOnFocus) {
      this.chatPinnedToBottom = true;
      this.chatScrollIntent = null;
    }
    this.listKeyboardLayout.begin(direction, chat.composer.getBoundingClientRect().bottom - chat.shell.getBoundingClientRect().top,
      { height: viewport?.height ?? innerHeight, layoutHeight: document.documentElement.clientHeight,
        width: viewport?.width ?? innerWidth }, performance.now());
    this.syncViewport();
    this.trackChatViewport();
  }

  private cancelListKeyboardSurfaceMotion(): void {
    for (const animation of this.chatKeyboardSurfaceMotion?.animations ?? []) animation.cancel();
    this.chatKeyboardSurfaceMotion = null;
  }

  private refreshNativeChatChrome(): void {
    if (!this.visualClientCoordinates) return;
    const viewport = window.visualViewport;
    this.positionChatChrome(viewport?.offsetTop ?? 0, viewport?.height ?? window.innerHeight,
      document.documentElement.clientHeight || window.innerHeight);
  }

  private chatComposerLayoutTop(composer: HTMLElement): number {
    const top = composer.getBoundingClientRect().top;
    if (this.usesListScrolling) return top;
    const transform = getComputedStyle(composer).transform;
    if (!transform || transform === 'none') return top;
    try {
      // The composer uses `bottom` for viewport anchoring and `transform`
      // only for its concealed/reveal motion. Keep message geometry tied to
      // the final anchored edge while that decorative 14px transform runs.
      return top - new DOMMatrixReadOnly(transform).m42;
    } catch {
      return top;
    }
  }

  private chatBottomScrollTop(): number {
    const chat = this.chatLayoutElements;
    const latest = this.renderedMessageOrder.at(-1);
    if (!chat?.shell.isConnected || !latest?.isConnected) return 0;
    // Use the message and composer edges, not document extent: the latter can
    // include a short-history minimum height or a stale Safari layout viewport.
    return Math.max(0, this.chatScrollTop + latest.getBoundingClientRect().bottom - this.chatComposerLayoutTop(chat.composer) + CHAT_LATEST_GAP);
  }

  private scrollChatToBottom(): void {
    this.chatBottomControl?.cancel();
    this.chatScrollIntent = null;
    this.chatPinnedToBottom = true;
    this.alignChatBottom();
    if (this.chatBottomFollowPending) this.trackChatViewport();
  }

  private updateChatBottomControl(): void {
    if (this.chatViewportMotion?.moving) return;
    this.chatBottomControl?.update();
  }

  private async prepareChatBottomScroll(list: HTMLElement, signal: AbortSignal): Promise<boolean> {
    const session = this.session;
    const epoch = this.runtimeEpoch;
    const active = () => Boolean(session && this.isRuntimeActive(epoch, session) && list.isConnected && this.activeSurface === 'chat' && !signal.aborted);
    while (active() && this.historyHasNewer) {
      // Cooperate with a page already requested by ordinary scrolling. Abort
      // wakes this wait even if privacy/backgrounding stops animation frames.
      while (active() && this.historyLoading) {
        await new Promise<void>(resolve => {
          const finish = () => { cancelAnimationFrame(frame); signal.removeEventListener('abort', finish); resolve(); };
          const frame = requestAnimationFrame(finish);
          signal.addEventListener('abort', finish, { once: true });
        });
      }
      if (!active()) return false;
      const cursor = this.historyForwardCursor;
      await this.loadNewerHistory(list, signal);
      if (!active()) return false;
      // A failed read leaves the cursor and availability intact for retry.
      if (this.historyHasNewer && this.historyForwardCursor <= cursor) return false;
    }
    return active();
  }

  private beginNativeKeyboardDismiss(height = this.chatViewportHeight): void {
    const chat = this.chatLayoutElements;
    const row = this.renderedMessageOrder.at(-1);
    if (this.usesListScrolling || this.nativeKeyboardDismiss || !this.visualClientCoordinates || this.privacyCovered
      || this.activeSurface !== 'chat' || !chat?.list.isConnected || !row?.isConnected
      || !(this.chatPinnedToBottom && this.chatScrollIntent !== 'up' || this.chatResumeBottomOnFocus)
      || document.documentElement.clientHeight - height <= 120) return;
    this.cancelChatMessageMotion();
    this.nativeKeyboardOpening = false;
    const follow = this.ensureNativeChatFollow(chat.list);
    this.chatPinnedToBottom = true;
    this.chatScrollIntent = null;
    this.chatResumeBottomOnFocus = false;
    const style = getComputedStyle(chat.composer);
    const closed = this.nativeClosedComposer;
    const closedHeight = closed ? Math.max(closed.minHeight,
      chat.composer.offsetHeight + closed.paddingBottom - (parseFloat(style.paddingBottom) || 0)) : chat.composer.offsetHeight;
    const distance = Math.max(0, (this.nativeClosedViewportHeight || document.documentElement.clientHeight) - height
      - (closedHeight - chat.composer.offsetHeight));
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const animation = chat.list.animate([{ translate: '0 0' }, { translate: `0 ${distance}px` }],
      { duration: reduced ? 0 : CHAT_KEYBOARD_DISMISS_MS, easing: 'cubic-bezier(0.33, 1, 0.68, 1)', fill: 'both' });
    this.nativeKeyboardDismiss = { started: performance.now(), row, height, distance,
      offset: follow.offset, scroll: window.scrollY, animation };
  }

  private cancelNativeKeyboardDismiss(): void {
    const motion = this.nativeKeyboardDismiss;
    if (!motion) return;
    this.nativeKeyboardDismiss = null;
    const follow = this.nativeChatFollow;
    if (follow?.list.isConnected) {
      const translate = getComputedStyle(follow.list).translate.split(' ');
      follow.offset += parseFloat(translate[1] ?? '0') || 0;
      follow.list.style.top = `${follow.offset}px`;
    }
    motion.animation.cancel();
  }

  private sampleNativeKeyboardDismiss(): void {
    const motion = this.nativeKeyboardDismiss;
    const follow = this.nativeChatFollow;
    if (!motion || !follow) return;
    if (this.privacyCovered || this.activeSurface !== 'chat' || !motion.row.isConnected || !follow.list.isConnected) {
      this.cancelNativeKeyboardDismiss();
      return;
    }
    // Safari may expose only the final viewport height while UIKit animates
    // the keyboard. Start on blur/release, using the dismissal interval from
    // device captures; do not wait for the settled gate to move the messages.
    // The fixed-position origin can reset before viewport height without
    // moving normal-flow messages. Applying that origin delta here makes the
    // list jump once on reset and again at settlement. Compensate only actual
    // document scrolling; the compositor owns the animated displacement.
    const offset = motion.offset + window.scrollY - motion.scroll;
    if (Math.abs(offset - follow.offset) > 0.1) {
      follow.offset = offset;
      follow.list.style.top = `${offset}px`;
    }
    this.chatLastScrollY = window.scrollY;
    if (motion.animation.playState !== 'finished' || this.chatViewportMotion?.moving) return;
    this.cancelNativeKeyboardDismiss();
    this.commitNativeChatFollow();
    this.commitChatViewportGeometry();
    this.syncChatLayout(false);
    this.alignChatBottom();
    const documentMoved = this.chatScrollDocumentMovedPending;
    const bookkeeping = this.chatScrollBookkeepingPending;
    this.chatScrollBookkeepingPending = false;
    this.chatScrollDocumentMovedPending = false;
    if (bookkeeping) this.commitChatScrollBookkeeping(follow.list, documentMoved);
    else this.updateChatBottomControl();
    if (this.chatLayoutElements) delete this.chatLayoutElements.composer.dataset.viewportMotion;
  }

  private commitNativeChatFollow(): void {
    this.cancelNativeKeyboardDismiss();
    const follow = this.nativeChatFollow;
    if (!follow) return;
    this.nativeChatFollow = null;
    if (!follow.list.isConnected) return;
    const target = window.scrollY - follow.offset;
    follow.list.style.top = follow.top;
    follow.list.style.setProperty('padding-bottom', follow.padding, follow.priority);
    if (this.activeSurface === 'chat' && !this.privacyCovered) {
      window.scrollTo(0, target);
      this.chatLastScrollY = window.scrollY;
      this.refreshNativeChatChrome();
    }
  }

  private ensureNativeChatFollow(list: HTMLElement) {
    let follow = this.nativeChatFollow;
    if (!follow || follow.list !== list) {
      const style = list.style;
      follow = { list, offset: 0, top: style.top,
        padding: style.getPropertyValue('padding-bottom'), priority: style.getPropertyPriority('padding-bottom') };
      this.nativeChatFollow = follow;
      // A focused textarea shrinking must not clamp the document. Keep room
      // for its largest editing area until native scrolling takes ownership.
      const padding = parseFloat(getComputedStyle(list).paddingBottom) || 0;
      style.setProperty('padding-bottom', `${padding + 128}px`, 'important');
    }
    return follow;
  }

  private alignNativeChatContents(): boolean {
    const chat = this.chatLayoutElements;
    const viewport = window.visualViewport;
    if (this.usesListScrolling || !this.visualClientCoordinates || !chat?.list.isConnected
      || document.activeElement !== chat.composer.querySelector('#message-input')
      || !viewport || document.documentElement.clientHeight - viewport.height <= 120) return false;
    const follow = this.ensureNativeChatFollow(chat.list);
    // During bottom typing, move the message document's contents without
    // scrolling its native viewport. scrollTo makes Safari rebase fixed layers
    // after script has already painted their correction. Relative positioning
    // preserves native message hit testing and avoids a transformed ancestor.
    const delta = this.chatBottomScrollTop() - window.scrollY;
    const openingContent = this.nativeKeyboardOpening && delta > 1
      ? this.renderedMessageOrder.at(-1)?.firstElementChild : null;
    const openingBottom = openingContent?.getBoundingClientRect().bottom;
    follow.offset -= delta;
    chat.list.style.top = `${follow.offset}px`;
    this.chatLastScrollY = window.scrollY;
    this.chatBottomFollowPending = false;
    if (openingContent && openingBottom !== undefined) {
      // A later keyboard sample must continue the painted position, including
      // any unfinished content translation from the preceding sample.
      this.cancelChatMessageMotion();
      const distance = openingBottom - openingContent.getBoundingClientRect().bottom;
      this.animateChatMessageShift(distance, 380, distance, 'cubic-bezier(0.33, 1, 0.68, 1)');
    }
    return true;
  }

  private alignChatBottom(): void {
    if (this.composerHeightMotion || this.nativeKeyboardDismiss) {
      this.chatBottomFollowPending = true;
      return;
    }
    if (this.chatViewportMotion?.moving) {
      this.chatBottomFollowPending = true;
      return;
    }
    // Shrinking document padding can synchronously clamp scrollY and move
    // Safari's fixed origin. Measure the destination only after chrome is
    // back at its visual edge, or that clamp is counted a second time.
    this.refreshNativeChatChrome();
    if (this.alignNativeChatContents()) return;
    this.commitNativeChatFollow();
    const bottom = this.chatBottomScrollTop();
    if (Math.abs(this.chatScrollTop - bottom) > 1) {
      this.setChatScrollTop(bottom);
      this.refreshNativeChatChrome();
    }
    this.chatLastScrollY = this.chatScrollTop;
    // A keyboard/focus scroll may temporarily ignore scrollTo. Preserve the
    // requested destination until a later sampled frame can apply it.
    this.chatBottomFollowPending = Math.abs(this.chatScrollTop - bottom) > 2;
  }

  private finishChatAnchorRestore(list: HTMLElement): void {
    const anchor = this.chatRestoreAnchor;
    if (!anchor) return;
    const target = list.querySelector<HTMLElement>(`.message[data-client-msg-id="${CSS.escape(anchor.clientMsgId)}"]`);
    if (target) this.restoreChatAnchor(list, anchor);
    const unfinishedMedia = '.image-preview:not([data-image-state="loaded"]):not([data-image-state="error"])';
    if (target && !target.querySelector(unfinishedMedia)
      && Math.abs(target.getBoundingClientRect().top - this.chatViewportTop - anchor.offset) > 2) {
      // A short cold tail can clamp scrollTo before the requested offset.
      // Only later media can add the missing room below this anchor; earlier
      // offscreen media must not keep an impossible restore pending forever.
      for (let later = target.nextElementSibling; later; later = later.nextElementSibling) {
        if (later.querySelector(unfinishedMedia)) return;
      }
    }
    if (!target || !target.querySelector(unfinishedMedia)) {
      this.chatRestoreAnchor = null;
      this.captureChatAnchor(true);
    }
  }

  private scheduleUiPreferencesSave(): void {
    if (this.preferenceSaveTimer !== null) window.clearTimeout(this.preferenceSaveTimer);
    this.preferenceSaveTimer = window.setTimeout(() => {
      this.preferenceSaveTimer = null;
      this.flushUiPreferencesSave();
    }, 320);
  }

  private flushUiPreferencesSave(): void {
    void this.queueUiPreferencesSave().catch(() => undefined);
  }

  private queueUiPreferencesSave(): Promise<void> {
    const session = this.session;
    if (!session || !this.uiPreferencesHydrated) return Promise.resolve();
    const snapshot = structuredClone(this.uiPreferences);
    const operation = this.preferenceSaveChain
      .catch(() => undefined)
      .then(() => saveUiPreferences(session, snapshot));
    this.preferenceSaveChain = operation.catch(() => undefined);
    return operation;
  }

  private saveUiPreferencesNow(): Promise<void> {
    if (this.preferenceSaveTimer !== null) window.clearTimeout(this.preferenceSaveTimer);
    this.preferenceSaveTimer = null;
    return this.queueUiPreferencesSave();
  }

  private async updateBackgroundNotificationControl(): Promise<void> {
    const button = this.root.querySelector<HTMLButtonElement>('#toggle-notifications');
    if (!button || !this.session || this.privacyCovered) return;
    const label = button.querySelector('span')!;
    const status = await backgroundNotificationStatus();
    if (!button.isConnected) return;
    button.dataset.pushStatus = status;
    label.textContent = status === 'enabled'
      ? '后台通知：已开启'
      : status === 'blocked'
        ? '后台通知：浏览器已阻止'
        : status === 'unavailable'
          ? '后台通知：服务器未配置'
          : status === 'unsupported'
            ? '后台通知：当前环境不支持'
            : '开启隐私后台通知';
    button.disabled = status === 'blocked' || status === 'unavailable' || status === 'unsupported';
  }

  private async toggleBackgroundNotifications(): Promise<void> {
    const session = this.session;
    const button = this.root.querySelector<HTMLButtonElement>('#toggle-notifications');
    if (!session || !button || this.privacyCovered) return;
    const wasEnabled = button.dataset.pushStatus === 'enabled';
    button.disabled = true;
    try {
      if (wasEnabled) await disableBackgroundNotifications(session.vault);
      else await enableBackgroundNotifications(session.vault);
      this.showNotice(wasEnabled
        ? '后台通知已关闭'
        : '后台通知已开启；通知只包含通用提醒，不含发送者、正文或附件信息');
    } catch (cause) {
      this.operationalError(cause, '后台通知设置失败');
    } finally {
      if (button.isConnected) {
        button.disabled = false;
        await this.updateBackgroundNotificationControl();
      }
    }
  }

  private async handleSendText(event: Event): Promise<void> {
    event.preventDefault();
    const session = this.session;
    const epoch = this.runtimeEpoch;
    if (!session || this.privacyCovered || this.voiceRecorder) return;
    const input = this.root.querySelector<HTMLTextAreaElement>('#message-input');
    const originalDraft = input?.value ?? '';
    if (this.sendingTextDrafts.has(originalDraft)) return;
    const text = originalDraft.trim();
    const retainKeyboard = Boolean(input && (document.activeElement === input || this.keepComposerKeyboard));
    if (!text) {
      if (retainKeyboard) this.restoreComposerFocus();
      return;
    }
    const replyTarget = this.replyTarget;
    if (replyTarget && this.messageIsUnavailable(replyTarget.clientMsgId)) {
      this.replyTarget = null;
      this.renderReplyDraft();
      this.showNotice('原消息已删除，回复已取消');
      if (retainKeyboard) this.restoreComposerFocus();
      return;
    }
    const payload: MessagePayload = replyTarget
      ? {
          v: 2,
          kind: 'text',
          text,
          sentAt: new Date().toISOString(),
          replyTo: this.replyReference(replyTarget),
        }
      : { v: 1, kind: 'text', text, sentAt: new Date().toISOString() };
    this.sendingTextDrafts.add(originalDraft);
    try {
      await this.enqueuePayload(payload);
      if (!this.isRuntimeActive(epoch, session)) return;
      if (this.chatPinnedToBottom && this.chatScrollIntent !== 'up') this.trackChatViewport(!this.desktopBrowser);
      if (input?.isConnected && input.value === originalDraft) {
        // The optimistic row is inserted before the draft is cleared. Own the
        // ensuing programmatic scroll/caret adjustment for single-line sends
        // too; it is not a keyboard transition and must never hide the bar.
        this.composerViewportSettleUntil = Math.max(
          this.composerViewportSettleUntil,
          performance.now() + CHAT_COMPOSER_VIEWPORT_SETTLE_MS,
        );
        input.value = '';
        input.dispatchEvent(new Event('input'));
        this.flushUiPreferencesSave();
        if (retainKeyboard) this.restoreComposerFocus();
      }
      if (this.replyTarget?.clientMsgId === replyTarget?.clientMsgId) {
        this.replyTarget = null;
        this.renderReplyDraft();
      }
    } catch (cause) {
      if (!this.isRuntimeActive(epoch, session)) return;
      if (input?.isConnected && !input.value) {
        input.value = text;
        input.dispatchEvent(new Event('input'));
      }
      this.showNotice(cause instanceof Error ? cause.message : '消息未能安全保存', 'error');
      return;
    } finally {
      if (this.isRuntimeActive(epoch, session)) this.sendingTextDrafts.delete(originalDraft);
    }
  }

  private enqueuePayload(payload: MessagePayload, existingClientMsgId?: string, signal?: AbortSignal): Promise<void> {
    const session = this.session;
    const epoch = this.runtimeEpoch;
    const operation = this.sendChain.catch(() => undefined).then(() => {
      signal?.throwIfAborted();
      if (!session || !this.isRuntimeActive(epoch, session)) return;
      return this.sendPayload(payload, existingClientMsgId, signal);
    });
    this.sendChain = operation.catch(() => undefined);
    return operation;
  }

  private async sendPayload(payload: MessagePayload, existingClientMsgId?: string, signal?: AbortSignal): Promise<void> {
    const session = this.session;
    const epoch = this.runtimeEpoch;
    if (!session || this.privacyCovered) return;
    await withVaultMutation(session, async (mutation) => {
      signal?.throwIfAborted();
      if (this.isRuntimeActive(epoch, session)) await this.sendPayloadLocked(payload, existingClientMsgId, mutation);
    });
  }

  private async sendPayloadLocked(payload: MessagePayload, existingClientMsgId: string | undefined, mutation: VaultMutation): Promise<void> {
    const session = this.session;
    if (!session || this.privacyCovered) return;
    const capabilityError = this.payloadCapabilityError(payload);
    if (capabilityError) throw new Error(capabilityError);
    if (session.vault.protocol === 'mls-rfc9420' && session.vault.mls?.phase !== 'active') {
      throw new Error('安全会话尚未建立完成，内容不会上传或发送');
    }
    const epoch = this.runtimeEpoch;
    const clientMsgId = existingClientMsgId ?? crypto.randomUUID();
    // A draft retry must reuse the durable ciphertext and never advance MLS twice.
    if (existingClientMsgId) {
      if ([...this.messages.values()].some(message => message.clientMsgId === clientMsgId)) return;
      const existing = this.outbox.get(clientMsgId) ?? (await loadOutbox(session)).find(item => item.clientMsgId === clientMsgId);
      if (existing) { this.outbox.set(clientMsgId, existing); await this.attemptSend(clientMsgId); return; }
    }
    const outboxItem: OutboxItem = {
      clientMsgId,
      payload,
      createdAt: payload.sentAt,
    };
    try {
      if (session.vault.protocol === 'mls-rfc9420') {
        const encrypted = await encryptMlsApplication(session.vault, payload, clientMsgId);
        outboxItem.envelope = encrypted.envelope;
        await commitMlsSend(session, outboxItem, encrypted.nextGroupState, mutation);
      } else {
        await saveOutboxItem(session, outboxItem, mutation);
      }
    } catch (cause) {
      this.operationalError(cause, '消息未能写入本机加密待发箱，因此没有发送');
      throw cause;
    }
    if (!this.isRuntimeActive(epoch, session)) return;
    this.outbox.set(clientMsgId, outboxItem);
    const pending: DecryptedMessage = {
      seq: Number.MAX_SAFE_INTEGER,
      clientMsgId,
      senderId: session.vault.identity.publicBundle.deviceId,
      payload,
      acceptedAt: payload.sentAt,
      status: 'pending',
    };
    this.pending.set(clientMsgId, pending);
    if (['text', 'image', 'image-album', 'file', 'audio'].includes(payload.kind)) this.presenceCircuit?.sent();
    const projectionEvent = payload.kind === 'reaction' || payload.kind === 'message-delete' || payload.kind === 'media-read' || payload.kind === 'message-read';
    this.renderMessages({ scroll: projectionEvent ? 'preserve' : 'send' });
    if (!projectionEvent) this.trackChatViewport(!this.desktopBrowser);
    await this.attemptSend(clientMsgId);
  }

  private async attemptSend(clientMsgId: string): Promise<void> {
    const session = this.session;
    if (!session || this.privacyCovered || this.sending.has(clientMsgId)) return;
    const epoch = this.runtimeEpoch;
    const item = this.outbox.get(clientMsgId);
    if (!item) return;
    if (this.connectionState !== 'connected') return;
    if (this.deferUnsupportedPayload(item)) return;
    this.sending.add(clientMsgId);
    const pendingMessage = this.pending.get(clientMsgId);
    if (pendingMessage?.status === 'failed') pendingMessage.status = 'pending';
    try {
      const envelope = item.envelope ?? await encryptMessage(session.vault, item.payload, clientMsgId);
      if (!this.isRuntimeActive(epoch, session)) return;
      if (this.deferUnsupportedPayload(item)) return;
      this.socket?.sendEnvelope(envelope, item.payload.kind !== 'gallery-image' && item.payload.kind !== 'gallery-file'
        && item.payload.kind !== 'reaction' && item.payload.kind !== 'message-delete' && item.payload.kind !== 'media-read' && item.payload.kind !== 'message-read');
      this.scheduleRetry(clientMsgId);
    } catch (cause) {
      if (!this.isRuntimeActive(epoch, session)) return;
      const pending = this.pending.get(clientMsgId);
      if (pending && this.connectionState === 'connected') pending.status = 'failed';
      this.showNotice(cause instanceof Error ? cause.message : '消息发送失败，稍后将自动重试', 'error');
      this.renderMessages();
      this.scheduleRetry(clientMsgId);
    } finally {
      this.sending.delete(clientMsgId);
    }
  }

  private reencryptOutboxItem(clientMsgId: string, rejectedEnvelope: MessageEnvelope): Promise<void> {
    const existing = this.outboxReencryptions.get(clientMsgId);
    if (existing) return existing;
    const session = this.session;
    const epoch = this.runtimeEpoch;
    if (!session || this.privacyCovered) return Promise.resolve();
    const operation = withVaultMutation(session, async (mutation) => {
      if (this.isRuntimeActive(epoch, session)) await this.reencryptOutboxItemLocked(clientMsgId, mutation, rejectedEnvelope);
    }).finally(() => {
      if (this.outboxReencryptions.get(clientMsgId) === operation) this.outboxReencryptions.delete(clientMsgId);
    });
    this.outboxReencryptions.set(clientMsgId, operation);
    return operation;
  }

  private async reencryptOutboxItemLocked(clientMsgId: string, mutation: VaultMutation, rejectedEnvelope: MessageEnvelope): Promise<void> {
    const session = this.session;
    const epoch = this.runtimeEpoch;
    const item = this.outbox.get(clientMsgId);
    if (!session || !item || session.vault.protocol !== 'mls-rfc9420') return;
    // A delayed duplicate MLS_EPOCH_STALE may refer to the prior ciphertext
    // after a first handler has already committed a replacement. Treat it as
    // an acknowledgement of obsolete work, not permission to advance the MLS
    // sender ratchet a second time for the same logical message.
    if (!item.envelope || canonicalStringify(item.envelope) !== canonicalStringify(rejectedEnvelope)) return;
    if (this.deferUnsupportedPayload(item)) return;
    this.clearRetry(clientMsgId);
    const encrypted = await encryptMlsApplication(session.vault, item.payload, clientMsgId);
    const nextItem: OutboxItem = { ...item, envelope: encrypted.envelope };
    await commitMlsSend(session, nextItem, encrypted.nextGroupState, mutation);
    if (!this.isRuntimeActive(epoch, session)) return;
    this.outbox.set(clientMsgId, nextItem);
    const pending = this.pending.get(clientMsgId);
    if (pending) pending.status = 'pending';
    this.showNotice('设备列表刚刚更新，待发消息已使用新密钥重新加密');
    await this.attemptSend(clientMsgId);
  }

  private scheduleRetry(clientMsgId: string): void {
    this.clearRetry(clientMsgId, false);
    const count = (this.retryCounts.get(clientMsgId) ?? 0) + 1;
    this.retryCounts.set(clientMsgId, count);
    const delay = Math.min(1500 * 2 ** Math.min(count - 1, 4), 15_000);
    const timer = window.setTimeout(() => {
      this.retryTimers.delete(clientMsgId);
      void this.attemptSend(clientMsgId);
    }, delay);
    this.retryTimers.set(clientMsgId, timer);
  }

  private clearRetry(clientMsgId: string, resetCount = true): void {
    const timer = this.retryTimers.get(clientMsgId);
    if (timer !== undefined) window.clearTimeout(timer);
    this.retryTimers.delete(clientMsgId);
    if (resetCount) {
      this.retryCounts.delete(clientMsgId);
      this.deferredCapabilityItems.delete(clientMsgId);
    }
  }

  private async resumeOutbox(): Promise<void> {
    for (const clientMsgId of this.outbox.keys()) void this.attemptSend(clientMsgId);
  }

  private sendPendingReceipt(receipt: DeliveryReceipt): void {
    try {
      this.socket?.sendReceipt(receipt);
    } catch {
      // The encrypted receipt remains in IndexedDB and is resent after reconnect.
    }
  }

  private async resendPendingReceipts(): Promise<void> {
    for (const receipt of this.pendingReceipts.values()) this.sendPendingReceipt(receipt);
  }

  private async acknowledgeReceipt(clientMsgId: string): Promise<void> {
    const session = this.session;
    const epoch = this.runtimeEpoch;
    if (!session || !this.pendingReceipts.has(clientMsgId)) return;
    try {
      await deletePendingReceipt(session, clientMsgId);
      if (!this.isRuntimeActive(epoch, session)) return;
      this.pendingReceipts.delete(clientMsgId);
    } catch (cause) {
      if (!this.isRuntimeActive(epoch, session)) return;
      this.operationalError(cause, '送达回执已被服务器确认，但本机队列清理失败');
    }
  }

  private syncComposerMode(): void {
    const input = this.root.querySelector<HTMLTextAreaElement>('#message-input');
    if (input) input.dataset.voiceEligible = String(!input.value);
  }

  private closeChatTools(): void {
    const panel = this.root.querySelector<HTMLElement>('#chat-tools');
    if (panel) panel.hidden = true;
    const button = this.root.querySelector<HTMLButtonElement>('#open-chat-tools');
    button?.setAttribute('aria-expanded', 'false');
    button?.setAttribute('aria-label', '更多功能');
    if (button) button.innerHTML = createElement(Plus).outerHTML;
  }

  private toggleChatTools(): void {
    const panel = this.root.querySelector<HTMLElement>('#chat-tools');
    if (!panel || this.privacyCovered || this.voiceRecorder) return;
    if (!panel.hidden) { this.closeChatTools(); return; }
    this.closeMemePicker(); this.closeMessageActions(false, false);
    this.root.querySelector<HTMLTextAreaElement>('#message-input')?.blur();
    panel.hidden = false;
    const button = this.root.querySelector<HTMLButtonElement>('#open-chat-tools')!;
    button.setAttribute('aria-expanded', 'true'); button.setAttribute('aria-label', '收起功能');
    button.innerHTML = icons.close;
  }

  private closeVoiceRecorder(restoreFocus = false): void {
    this.voiceGesture?.cancel();
    const recorder = this.voiceRecorder;
    this.voiceRecorder = null;
    this.microphonePromptActive = false;
    this.clearNativeHandoff('microphone');
    recorder?.destroy();
    const host = this.root.querySelector<HTMLElement>('.voice-recorder');
    if (host) host.hidden = true;
    this.root.querySelector('#composer')?.classList.remove('has-voice-draft');
    this.root.querySelector('.chat-shell')?.classList.remove('is-voice-recording');
    if (restoreFocus && this.desktopBrowser) this.root.querySelector<HTMLTextAreaElement>('#message-input')?.focus({ preventScroll: true });
  }

  private beginVoiceRecording(mode: 'hold' | 'locked' = 'locked'): VoiceRecorder | null {
    const session = this.session;
    const epoch = this.runtimeEpoch;
    const host = this.root.querySelector<HTMLElement>('.voice-recorder');
    if (!session || this.privacyCovered || !host || this.voiceRecorder) return null;
    if (session.vault.protocol === 'mls-rfc9420' && session.vault.mls?.phase !== 'active') return null;
    if (!this.activeDevicesSupport('voice-message-v1')) {
      this.showNotice('请先让所有已授权设备打开一次最新版，再发送语音', 'error');
      return null;
    }
    if (this.root.querySelector('#composer.is-uploading')) {
      this.showNotice('请等文件上传完成后再录音');
      return null;
    }
    this.voicePlayback.stop();
    this.closeChatTools();
    this.closeMemePicker();
    this.closeMessageActions();
    this.root.querySelector<HTMLTextAreaElement>('#message-input')?.blur();
    this.root.querySelector('#composer')?.classList.add('has-voice-draft');
    host.hidden = false;
    this.root.querySelector('.chat-shell')?.classList.add('is-voice-recording');
    let replyTarget: DecryptedMessage | null | undefined;
    let payload: MessagePayload | undefined;
    let plan: ImageUploadPlan | undefined;
    let uploaded: ImageManifest | undefined;
    const recorder = new VoiceRecorder(host, {
      permission: active => {
        if (this.voiceRecorder === recorder) return this.setMediaPermission('microphone', active);
        return false;
      },
      cancel: () => {
        if (this.voiceRecorder === recorder) this.closeVoiceRecorder(true);
      },
      fail: message => {
        if (!this.isRuntimeActive(epoch, session) || this.voiceRecorder !== recorder) return;
        this.closeVoiceRecorder(true); this.showNotice(message, 'error');
      },
      send: async (draft, draftSignal) => {
        if (!this.isRuntimeActive(epoch, session) || this.voiceRecorder !== recorder) return;
        if (replyTarget === undefined) replyTarget = this.replyTarget;
        if (!this.activeDevicesSupport('voice-message-v1')) throw new Error('有设备尚未更新，请先让所有设备打开最新版');
        const signal = AbortSignal.any([draftSignal, this.runtimeAbort!.signal]);
        const { roomId, accessToken } = session.vault;
        uploaded ??= await encryptAudioFile(draft.file, {
          reserve: (blobId, count, size) => voiceRequest('VOICE_CONNECT_FAILED', attemptSignal => reserveBlob(roomId, accessToken, blobId, count, size, attemptSignal), signal),
          status: blobId => voiceRequest('VOICE_CONNECT_FAILED', attemptSignal => getBlobStatus(roomId, accessToken, blobId, attemptSignal), signal),
          upload: (blobId, index, bytes) => voiceRequest('VOICE_UPLOAD_INTERRUPTED', attemptSignal => uploadBlobChunk(roomId, accessToken, blobId, index, bytes, attemptSignal), signal),
          complete: blobId => confirmVoiceUpload(attemptSignal => completeBlob(roomId, accessToken, blobId, attemptSignal), attemptSignal => getBlobStatus(roomId, accessToken, blobId, attemptSignal), signal),
          // The unsent recording and its retry plan are memory-only and are
          // discarded together on lock. Never persist unencrypted audio.
          savePlan: async value => { plan = value; },
          signal,
        }, plan);
        signal.throwIfAborted();
        if (!this.isRuntimeActive(epoch, session) || this.voiceRecorder !== recorder) return;
        payload ??= {
          v: replyTarget ? 2 : 1, kind: 'audio', audio: uploaded,
          durationMs: draft.durationMs, waveform: draft.waveform, sentAt: new Date().toISOString(),
          ...(replyTarget ? { replyTo: this.replyReference(replyTarget) } : {}),
        };
        await this.enqueuePayload(payload, draft.clientMsgId);
        if (!this.isRuntimeActive(epoch, session) || this.voiceRecorder !== recorder) return;
        this.closeVoiceRecorder(true);
        if (this.replyTarget === replyTarget) { this.replyTarget = null; this.renderReplyDraft(); }
      },
    }, mode, true);
    this.voiceRecorder = recorder;
    void recorder.start();
    return recorder;
  }

  private beginImagePicker(input: HTMLInputElement, restoreComposerFocus = false): boolean {
    if (this.imagePickerInput && this.imagePickerInput !== input) this.abandonImagePicker();
    this.imagePickerInput = input;
    this.imagePickerActive = true;
    if (!this.beginNativeHandoff('picker', 5 * 60_000)) {
      this.abandonImagePicker();
      return false;
    }
    this.restoreComposerFocusAfterPicker = restoreComposerFocus;
    if (this.imagePickerFocusReturnTimer !== null) window.clearTimeout(this.imagePickerFocusReturnTimer);
    this.imagePickerFocusReturnTimer = null;
    if (this.imagePickerResetTimer !== null) window.clearTimeout(this.imagePickerResetTimer);
    this.imagePickerResetTimer = window.setTimeout(() => { void this.finishImagePicker(); }, 5 * 60_000);
    return true;
  }

  private async finishImagePicker(restoreFocus = true): Promise<boolean> {
    const completion = this.finishNativeHandoff('picker');
    this.imagePickerActive = false;
    if (this.imagePickerInput && !this.root.contains(this.imagePickerInput)) this.imagePickerInput.remove();
    this.imagePickerInput = null;
    if (this.imagePickerResetTimer !== null) window.clearTimeout(this.imagePickerResetTimer);
    this.imagePickerResetTimer = null;
    if (this.imagePickerFocusReturnTimer !== null) window.clearTimeout(this.imagePickerFocusReturnTimer);
    this.imagePickerFocusReturnTimer = null;
    const invalidated = await completion;
    if (!invalidated && restoreFocus && this.restoreComposerFocusAfterPicker) {
      this.restoreComposerFocusAfterPicker = false;
      this.restoreComposerFocus();
    }
    return invalidated;
  }

  private abandonImagePicker(): void {
    const input = this.imagePickerInput;
    this.clearNativeHandoff('picker');
    this.imagePickerActive = false;
    this.filePickerActive = false;
    this.imagePickerInput = null;
    this.deferredImageUpload = null;
    this.restoreComposerFocusAfterPicker = false;
    if (this.imagePickerResetTimer !== null) window.clearTimeout(this.imagePickerResetTimer);
    if (this.imagePickerFocusReturnTimer !== null) window.clearTimeout(this.imagePickerFocusReturnTimer);
    this.imagePickerResetTimer = null;
    this.imagePickerFocusReturnTimer = null;
    // Removing the owning input is the only portable best-effort signal a web
    // app has for dismissing a native file chooser. Late change/cancel events
    // are rejected below even if a browser keeps the detached node alive.
    input?.remove();
  }

  private mountImagePicker(
    input: HTMLInputElement | null,
    destination: 'chat' | 'gallery',
    trigger?: HTMLButtonElement | null,
  ): void {
    if (!input) return;
    let currentInput = input;
    const configure = (candidate: HTMLInputElement) => {
      if (this.session) {
        candidate.dataset.roomId = this.session.vault.roomId;
        candidate.dataset.deviceId = this.session.vault.identity.publicBundle.deviceId;
      }
      candidate.addEventListener('click', event => {
        if (!this.root.contains(candidate)) return;
        if ((!this.imagePickerActive || this.imagePickerInput !== candidate) && !this.beginImagePicker(candidate)) {
          event.preventDefault();
        }
      });
      candidate.addEventListener('cancel', () => {
        if (candidate !== this.imagePickerInput) return;
        void this.finishImagePicker();
        this.deferredImageUpload = null;
      });
      candidate.addEventListener('change', (event) => void this.handleSendImage(event, destination));
    };
    configure(currentInput);
    if (trigger) {
      trigger.addEventListener('pointerdown', (event) => {
        const textarea = this.root.querySelector<HTMLTextAreaElement>('#message-input');
        if (destination === 'chat' && textarea) this.retainComposerKeyboard(event, textarea);
      });
      trigger.addEventListener('click', () => {
        if (currentInput.disabled) return;
        // One DOM input owns exactly one native chooser invocation. Removing a
        // stranded owner can then never let its late change/cancel event act on
        // a later invocation launched from the same still-mounted trigger.
        const nextInput = currentInput.cloneNode(false) as HTMLInputElement;
        nextInput.value = '';
        if (currentInput.isConnected) currentInput.replaceWith(nextInput);
        else trigger.parentElement?.append(nextInput);
        currentInput = nextInput;
        configure(currentInput);
        if (!this.beginImagePicker(currentInput, destination === 'chat' && this.keepComposerKeyboard)) return;
        currentInput.click();
      });
    }
  }

  private async handleSendImage(event: Event, destination: 'chat' | 'gallery'): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    if (!this.imagePickerActive || input !== this.imagePickerInput) return;
    const selected = [...(input.files ?? [])];
    input.value = '';
    if (destination === 'chat' && this.restoreComposerFocusAfterPicker) {
      this.restoreComposerFocusAfterPicker = false;
      this.restoreComposerFocus();
    }
    const invalidated = await this.finishImagePicker(false);
    if (invalidated) {
      this.deferredImageUpload = null;
      return;
    }
    if (selected.length === 0) {
      this.deferredImageUpload = null;
      return;
    }
    const files = selected;
    if (!this.session || this.privacyCovered || !document.hasFocus() || document.hidden) {
      this.deferredImageUpload = { files, destination, roomId: input.dataset.roomId ?? '', deviceId: input.dataset.deviceId ?? '' };
      return;
    }
    const session = this.session;
    const epoch = this.runtimeEpoch;
    if (input.dataset.roomId !== session.vault.roomId || input.dataset.deviceId !== session.vault.identity.publicBundle.deviceId) return;
    try {
      await this.processImageFiles(files, destination);
    } finally {
      if (this.isRuntimeActive(epoch, session) && destination === 'chat' && this.restoreComposerFocusAfterPicker) {
        this.restoreComposerFocusAfterPicker = false;
        this.restoreComposerFocus();
      }
    }
  }

  private async resumeDeferredImage(): Promise<void> {
    if (!this.deferredImageUpload || !this.session || this.privacyCovered || document.hidden || !document.hasFocus()) return;
    const { files, destination, roomId, deviceId } = this.deferredImageUpload;
    this.deferredImageUpload = null;
    if (this.session.vault.roomId !== roomId || this.session.vault.identity.publicBundle.deviceId !== deviceId) return;
    if (destination === 'gallery' && !this.root.querySelector('.gallery-shell')) {
      this.restoreChatAnchorOnNextRender = true;
      this.renderGallery();
    }
    await this.processImageFiles(files, destination);
  }

  private handleComposerPaste(event: ClipboardEvent): void {
    const input = event.currentTarget;
    const data = event.clipboardData;
    if (!(input instanceof HTMLTextAreaElement) || !data) return;
    // Use the user-initiated paste payload. No asynchronous clipboard read or
    // permission prompt, and no fetching remote URLs from copied HTML.
    let files = [...data.files].filter(file => file.type.startsWith('image/'));
    if (!files.length) files = [...data.items]
      .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
      .flatMap(item => { const file = item.getAsFile(); return file ? [file] : []; });
    if (!files.length) return;
    event.preventDefault();
    const session = this.session;
    const epoch = this.runtimeEpoch;
    if (!session || this.privacyCovered || input.disabled || !input.isConnected ||
      document.documentElement.classList.contains('privacy-obscured')) return;
    if (this.imageBatchUploading) {
      this.showNotice('文件正在上传，请完成后再次粘贴');
      return;
    }
    // Images take precedence over accompanying HTML/text, while the existing
    // text draft and selection remain untouched. Reuse original-byte batching.
    void this.processImageFiles(files, 'chat').catch(cause => {
      if (this.isRuntimeActive(epoch, session)) this.operationalError(cause, '粘贴的图片未能发送，请重新粘贴重试');
    });
  }

  private async processImageFiles(files: File[], destination: 'chat' | 'gallery' = 'chat'): Promise<void> {
    const session = this.session;
    const epoch = this.runtimeEpoch;
    if (!session || this.privacyCovered || this.imageBatchUploading || files.length === 0) return;
    if (files.some(file => file.size === 0 || file.size > MAX_IMAGE_BYTES)) {
      this.showNotice('请选择非空文件，单个文件不能超过 256 MiB', 'error');
      return;
    }
    if (files.some(file => !file.type.startsWith('image/')) && !this.activeDevicesSupport('file-message-v1')) {
      this.showNotice('请先让所有已授权设备打开一次最新版，再发送文件', 'error');
      return;
    }
    this.imageBatchUploading = true;
    try {
      for (const batch of batchAttachmentFiles(files, destination)) {
        if (!this.isRuntimeActive(epoch, session)) return;
        if (!await this.processImageBatch(batch, destination)) return;
      }
    } finally {
      if (this.isRuntimeActive(epoch, session)) this.imageBatchUploading = false;
    }
  }

  private async processImageBatch(files: File[], destination: 'chat' | 'gallery', operationSignal?: AbortSignal, expression = false, videoRetryId?: string, expressionAutoHide = false): Promise<boolean> {
    const session = this.session;
    if (!session || this.privacyCovered || files.length === 0) return false;
    if (expression && (destination !== 'chat' || files.length !== 1 || !files[0]!.type.startsWith('image/'))) return false;
    if (expression && !this.activeDevicesSupport('expression-image-v1')) {
      this.showNotice('请先让所有已授权设备打开一次最新版，再发送表情', 'error');
      return false;
    }
    const isFile = !files[0]!.type.startsWith('image/');
    if ((isFile || (destination === 'chat' && this.replyTarget?.payload.kind === 'file')) && !this.activeDevicesSupport('file-message-v1')) {
      this.showNotice('请先让所有已授权设备打开一次最新版，再发送文件或回复文件', 'error');
      return false;
    }
    if ((isFile && files.length !== 1) || (!isFile && files.some(file => !file.type.startsWith('image/')))) {
      this.showNotice('文件分组无效，请重新选择文件', 'error');
      return false;
    }
    if (destination === 'chat' && files.length > 1 && !this.activeDevicesSupport('image-album-v1')) {
      this.showNotice('有活跃设备尚未确认支持多图相册；请先将所有设备升级并至少打开一次最新版', 'error');
      return false;
    }
    if (session.vault.protocol === 'mls-rfc9420' && session.vault.mls?.phase !== 'active') {
      this.showNotice('安全会话尚未建立完成，文件不会上传', 'error');
      return false;
    }
    if (destination === 'gallery' && session.vault.role !== 'creator') {
      this.showNotice('只有会话创建者可以向保险箱上传文件', 'error');
      return false;
    }
    const epoch = this.runtimeEpoch;
    const signal = operationSignal && this.runtimeAbort ? AbortSignal.any([operationSignal, this.runtimeAbort.signal]) : this.runtimeAbort?.signal;
    if (signal?.aborted) return false;
    if (files.some((file) => file.size > MAX_IMAGE_BYTES)) {
      this.showNotice('单个文件不能超过 256 MiB', 'error');
      return false;
    }
    if (files.some((file) => file.size === 0)) {
      this.showNotice('不能发送空文件', 'error');
      return false;
    }
    if (!videoRetryId && destination === 'chat' && isVideoFile({ mimeType: files[0]!.type, originalName: files[0]!.name })
      && (this.videoUploads.size >= 3 || [...this.videoUploads.values()].reduce((size, draft) => size + draft.file.size, files[0]!.size) > MAX_IMAGE_BYTES)) {
      this.showNotice('请先重试或移除列表中未发送的视频', 'error');
      return false;
    }
    const uploadScope = this.root.querySelector<HTMLElement>(destination === 'gallery' ? '.gallery-shell' : '#composer');
    const progress = this.root.querySelector<HTMLElement>('#upload-progress');
    const bar = progress?.querySelector<HTMLElement>('span');
    const output = progress?.querySelector<HTMLOutputElement>('output');
    const uploadControlSelector = destination === 'gallery'
      ? 'button, textarea, input'
      : '#open-image-picker, #image-input, #open-camera-picker, #camera-input, #open-file-picker, #file-input';
    uploadScope?.classList.add('is-uploading');
    uploadScope?.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement | HTMLInputElement>(uploadControlSelector).forEach((control) => {
      control.disabled = true;
    });
    if (progress) progress.hidden = false;
    const existingVideo = videoRetryId ? this.videoUploads.get(videoRetryId) : undefined;
    const replyTarget = existingVideo ? existingVideo.reply : destination === 'chat' ? this.replyTarget : null;
    const clientMsgId = videoRetryId ?? crypto.randomUUID();
    let videoUpload = existingVideo;
    if (destination === 'chat' && isFile && isVideoFile({ mimeType: files[0]!.type, originalName: files[0]!.name })) {
      if (!videoUpload) {
        const view = new VideoUploadView(clientMsgId, files[0]!, () => {
          const draft = this.videoUploads.get(clientMsgId);
          if (!draft || draft.busy || !this.isRuntimeActive(epoch, session)) return;
          if (this.root.querySelector('#composer.is-uploading')) { this.showNotice('请等当前文件上传结束后再重试'); return; }
          void this.processImageBatch([draft.file], 'chat', undefined, false, clientMsgId);
        }, () => {
          const draft = this.videoUploads.get(clientMsgId);
          if (!draft || draft.busy) return;
          draft.view.destroy(); this.videoUploads.delete(clientMsgId); this.renderMessages({ scroll: 'position' });
        }, () => {
          if (this.isRuntimeActive(epoch, session)) this.renderMessages({ scroll: 'preserve' });
        });
        videoUpload = { view, file: files[0]!, reply: replyTarget, sentAt: new Date().toISOString(), busy: true };
        this.videoUploads.set(clientMsgId, videoUpload);
      }
      videoUpload.busy = true;
      videoUpload.view.update('preparing');
      if (progress) progress.hidden = true; // The video bubble owns its progress.
      this.renderMessages({ scroll: 'send' });
    }
    const totalBytes = files.reduce((sum, file) => sum + Math.max(file.size, 1), 0);
    let completedBytes = 0;
    const manifests: ImageManifest[] = [];
    const usedUploadPlanIds = new Set<string>();
    const encryptFile = isFile ? encryptFileAttachment : encryptImageFile;
    try {
      const vault = session.vault;
      for (const [index, file] of files.entries()) {
        const matchingPlans = this.uploadPlans.filter((plan) =>
          plan.originalSize === file.size &&
          plan.originalName === file.name &&
          plan.mimeType === file.type &&
          plan.lastModified === file.lastModified,
        );
        for (const legacy of matchingPlans.filter((plan) => plan.v === 1)) {
          await deleteUploadPlan(session, legacy.blobId);
          if (!this.isRuntimeActive(epoch, session)) return false;
          this.uploadPlans = this.uploadPlans.filter((plan) => plan.blobId !== legacy.blobId);
        }
        const uploadCallbacks: Parameters<typeof encryptImageFile>[1] = {
          includeDimensions: this.activeDevicesSupport('media-dimensions-v1'),
          reserve: (blobId, chunkCount, encryptedSize) =>
            reserveBlob(vault.roomId, vault.accessToken, blobId, chunkCount, encryptedSize, signal),
          status: (blobId) => getBlobStatus(vault.roomId, vault.accessToken, blobId, signal),
          upload: (blobId, chunkIndex, bytes) => this.retryOperation(
            () => uploadBlobChunk(vault.roomId, vault.accessToken, blobId, chunkIndex, bytes, signal),
            3,
            signal,
          ),
          complete: (blobId) => completeBlob(vault.roomId, vault.accessToken, blobId, signal),
          savePlan: async (plan) => {
            await saveUploadPlan(session, plan);
            if (!this.isRuntimeActive(epoch, session)) return;
            const planIndex = this.uploadPlans.findIndex((item) => item.blobId === plan.blobId);
            if (planIndex >= 0) this.uploadPlans[planIndex] = plan;
            else this.uploadPlans.push(plan);
          },
          progress: (ratio) => {
            if (!this.isRuntimeActive(epoch, session)) return;
            const overall = (completedBytes + Math.max(file.size, 1) * ratio) / totalBytes;
            videoUpload?.view.update('uploading', overall);
            if (bar) bar.style.transform = `scaleX(${overall})`;
            if (output) output.textContent = files.length > 1
              ? `正在处理第 ${index + 1}/${files.length} 张 · ${Math.round(overall * 100)}%`
              : `正在加密上传${isFile ? '文件' : '原图'} ${Math.round(overall * 100)}%`;
          },
          signal,
        };
        let manifest: ImageManifest | undefined;
        const resumablePlans = matchingPlans.filter((plan) => plan.v === 2 && !usedUploadPlanIds.has(plan.blobId));
        for (const existingPlan of resumablePlans) {
          try {
            manifest = await encryptFile(file, uploadCallbacks, existingPlan);
            break;
          } catch (cause) {
            if (!(cause instanceof Error) || !['所选图片内容与待续传文件不一致', '所选文件内容与待续传文件不一致'].includes(cause.message)) throw cause;
          }
        }
        manifest ??= await encryptFile(file, uploadCallbacks);
        if (!this.isRuntimeActive(epoch, session)) return false;
        manifests.push(manifest);
        usedUploadPlanIds.add(manifest.blobId);
        if (!isFile || isVideoFile(manifest)) this.cacheLocalImage(manifest, file);
        completedBytes += Math.max(file.size, 1);
      }
      const sentAt = videoUpload?.sentAt ?? new Date().toISOString();
      const payload: MessagePayload = isFile
        ? destination === 'gallery'
          ? { v: 1, kind: 'gallery-file', file: manifests[0]!, sentAt }
          : replyTarget
            ? { v: 2, kind: 'file', file: manifests[0]!, sentAt, replyTo: this.replyReference(replyTarget) }
            : { v: 1, kind: 'file', file: manifests[0]!, sentAt }
        : destination === 'gallery'
          ? { v: 1, kind: 'gallery-image', image: manifests[0]!, sentAt }
          : manifests.length > 1
            ? replyTarget
              ? { v: 2, kind: 'image-album', images: manifests, sentAt, replyTo: this.replyReference(replyTarget) }
              : { v: 1, kind: 'image-album', images: manifests, sentAt }
            : replyTarget
              ? { v: 2, kind: 'image', image: manifests[0]!, sentAt, replyTo: this.replyReference(replyTarget) }
              : { v: 1, kind: 'image', image: manifests[0]!, sentAt };
      if (expression && payload.kind === 'image') {
        payload.presentation = expressionAutoHide ? 'expression-hidden' : 'expression';
        payload.expressionAutoHide = Boolean(expressionAutoHide);
      }
      signal?.throwIfAborted();
      videoUpload?.view.update('finishing');
      await this.enqueuePayload(payload, clientMsgId, operationSignal);
      if (!this.isRuntimeActive(epoch, session)) return false;
      videoUpload?.view.destroy();
      this.videoUploads.delete(clientMsgId);
      if (this.replyTarget?.clientMsgId === replyTarget?.clientMsgId) {
        this.replyTarget = null;
        this.renderReplyDraft();
      }
      for (const manifest of manifests) {
        await deleteUploadPlan(session, manifest.blobId);
        if (!this.isRuntimeActive(epoch, session)) return false;
        this.uploadPlans = this.uploadPlans.filter((plan) => plan.blobId !== manifest.blobId);
      }
      if (destination === 'gallery' && this.root.querySelector('.gallery-shell')) this.renderGallery(isFile && !isVideoFile(manifests[0]!) ? 'files' : 'images');
      return true;
    } catch (cause) {
      if (!this.isRuntimeActive(epoch, session)) return false;
      if (signal?.aborted) {
        videoUpload?.view.destroy(); this.videoUploads.delete(clientMsgId);
        this.renderMessages({ scroll: 'position' });
        return false;
      }
      videoUpload?.view.update('failed');
      const suffix = this.uploadPlans.length > 0 ? '。重新选择同一文件可从已完成分块继续' : '';
      this.showNotice(`${cause instanceof Error ? cause.message : '文件上传失败'}${suffix}`, 'error');
      return false;
    } finally {
      if (!this.isRuntimeActive(epoch, session)) return false;
      if (videoUpload) videoUpload.busy = false;
      uploadScope?.classList.remove('is-uploading');
      uploadScope?.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement | HTMLInputElement>(uploadControlSelector).forEach((control) => {
        control.disabled = false;
      });
      if (progress) progress.hidden = true;
      if (bar) bar.style.transform = 'scaleX(0)';
    }
  }

  private cacheLocalImage(manifest: ImageManifest, blob: Blob): void {
    this.assertImageManifestIdentity(manifest);
    if (this.imageCache.has(manifest.blobId)) return;
    while (this.imageCacheBytes + blob.size > MAX_IMAGE_CACHE_BYTES && this.imageCache.size > 0) {
      const oldest = [...this.imageCache.entries()]
        .filter(([blobId]) => !this.root.querySelector(`[data-blob-id="${CSS.escape(blobId)}"]`))
        .sort(([, left], [, right]) => left.lastUsedAt - right.lastUsedAt)[0];
      if (!oldest) break;
      URL.revokeObjectURL(oldest[1].url);
      if (oldest[1].posterUrl) URL.revokeObjectURL(oldest[1].posterUrl);
      if (oldest[1].concealedUrl) URL.revokeObjectURL(oldest[1].concealedUrl);
      this.imageCacheBytes -= oldest[1].bytes;
      this.imageCache.delete(oldest[0]);
    }
    const type = videoMimeType(manifest);
    const displayBlob = type ? blob.slice(0, blob.size, type) : blob;
    const cached = { blob, url: URL.createObjectURL(displayBlob), bytes: blob.size, lastUsedAt: Date.now() };
    this.imageCache.set(manifest.blobId, cached);
    this.imageCacheBytes += cached.bytes;
  }

  private assertImageManifestIdentity(manifest: ImageManifest): void {
    const signature = canonicalStringify(manifest);
    const known = this.imageManifestSignatures.get(manifest.blobId);
    if (known && known !== signature) {
      throw new SecurityViolation('同一媒体编号绑定了不同的加密清单，已拒绝显示');
    }
    this.imageManifestSignatures.set(manifest.blobId, signature);
  }

  private async withImageLoadSlot<T>(operation: () => Promise<T>): Promise<T> {
    if (this.activeImageLoads >= 2) {
      await new Promise<void>((resolve) => this.imageLoadWaiters.push(resolve));
    }
    this.activeImageLoads += 1;
    try {
      return await operation();
    } finally {
      this.activeImageLoads -= 1;
      this.imageLoadWaiters.shift()?.();
    }
  }

  private async retryOperation<T>(operation: () => Promise<T>, attempts = 3, signal?: AbortSignal): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      signal?.throwIfAborted();
      try {
        return await operation();
      } catch (cause) {
        lastError = cause;
        if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
        if (cause instanceof ApiError && !cause.retryable) throw cause;
        if (attempt + 1 < attempts) await this.abortableDelay(350 * 2 ** attempt, signal);
      }
    }
    throw lastError;
  }

  private abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const abort = () => {
        window.clearTimeout(timer);
        reject(signal?.reason);
      };
      const timer = window.setTimeout(() => {
        signal?.removeEventListener('abort', abort);
        resolve();
      }, milliseconds);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  private messageIsUnavailable(clientMsgId: string, deletedForEveryone = this.messageDeletions()): boolean {
    return deletedForEveryone.has(clientMsgId)
      || (this.uiPreferences.hiddenChatMessageIds ?? []).includes(clientMsgId.toLowerCase());
  }

  private orderedMessages(deletedForEveryone = this.messageDeletions()): DecryptedMessage[] {
    const hiddenOnThisDevice = new Set(this.uiPreferences.hiddenChatMessageIds ?? []);
    const visible = (message: DecryptedMessage) => message.payload.kind !== 'gallery-image' && message.payload.kind !== 'gallery-file'
      && message.payload.kind !== 'reaction' && message.payload.kind !== 'message-delete' && message.payload.kind !== 'media-read' && message.payload.kind !== 'message-read'
      && !deletedForEveryone.has(message.clientMsgId) && !hiddenOnThisDevice.has(message.clientMsgId.toLowerCase());
    const confirmed = [...this.messages.values()]
      .filter(visible)
      .sort((left, right) => left.seq - right.seq);
    const pending = [...this.pending.values()]
      .filter(visible)
      .sort((left, right) => left.acceptedAt.localeCompare(right.acceptedAt));
    return [...confirmed, ...pending];
  }

  private activeDevicesSupport(capability: string): boolean {
    const members = this.session?.vault.members.filter((member) => member.status === undefined || member.status === 'active') ?? [];
    return members.length > 0 && members.every((member) => member.capabilities?.includes(capability));
  }

  private payloadCapabilityError(payload: MessagePayload): string | null {
    const media = payload.kind === 'image' ? [payload.image]
      : payload.kind === 'image-album' ? payload.images
      : payload.kind === 'file' || payload.kind === 'gallery-file' ? [payload.file]
      : [];
    if (media.some(item => item.width !== undefined) && !this.activeDevicesSupport('media-dimensions-v1')) {
      return '请先让所有已授权设备打开一次最新版，再发送带稳定占位的媒体';
    }
    if (payload.kind === 'message-read' && !this.activeDevicesSupport('message-read-v1')) return '已读同步等待设备更新';
    if (payload.kind === 'media-read' && !this.activeDevicesSupport('media-read-v1')) return '已读同步等待设备更新';
    if (payload.kind === 'reaction' && !this.activeDevicesSupport('message-reactions-v1')) {
      return '请先让所有已授权设备打开最新版，再使用表情回应';
    }
    if (payload.kind === 'message-delete' && !this.activeDevicesSupport('message-delete-v1')) {
      return '请先让所有已授权设备打开最新版，再为所有人删除消息';
    }
    if ((payload.kind === 'audio' || ('replyTo' in payload && payload.replyTo?.kind === 'audio'))
      && !this.activeDevicesSupport('voice-message-v1')) {
      return '请先让所有已授权设备打开一次最新版，再发送语音或回复语音';
    }
    if ((payload.kind === 'file' || payload.kind === 'gallery-file'
      || ('replyTo' in payload && payload.replyTo?.kind === 'file'))
      && !this.activeDevicesSupport('file-message-v1')) {
      return '请先让所有已授权设备打开一次最新版，再发送文件或回复文件';
    }
    if (payload.kind === 'image-album' && !this.activeDevicesSupport('image-album-v1')) {
      return '请先让所有已授权设备打开一次最新版，再发送多张图片';
    }
    if (payload.kind === 'image' && payload.presentation === 'expression' && !this.activeDevicesSupport('expression-image-v1')) {
      return '请先让所有已授权设备打开一次最新版，再发送表情';
    }
    if ('replyTo' in payload && payload.replyTo && !this.activeDevicesSupport('reply-v2')) {
      return '请先让所有已授权设备打开一次最新版，再发送回复';
    }
    return null;
  }

  private deferUnsupportedPayload(item: OutboxItem): boolean {
    const capabilityError = this.payloadCapabilityError(item.payload);
    if (!capabilityError) {
      this.deferredCapabilityItems.delete(item.clientMsgId);
      return false;
    }
    const firstDeferral = !this.deferredCapabilityItems.has(item.clientMsgId);
    this.deferredCapabilityItems.add(item.clientMsgId);
    const pending = this.pending.get(item.clientMsgId);
    const projectionEvent = item.payload.kind === 'reaction' || item.payload.kind === 'message-delete' || item.payload.kind === 'media-read' || item.payload.kind === 'message-read';
    if (!projectionEvent && pending && pending.status !== 'failed') {
      pending.status = 'failed';
      this.renderMessages();
    }
    if (firstDeferral) {
      const subject = item.payload.kind === 'reaction' ? '表情回应'
        : item.payload.kind === 'message-delete' ? '删除操作' : '内容';
      this.showNotice(`${subject}已加密保存在本机待发；${capabilityError}`, 'error');
    }
    this.scheduleRetry(item.clientMsgId);
    return true;
  }

  private memberForMessage(message: Pick<DecryptedMessage, 'senderId'>): RoomMember | undefined {
    return this.session?.vault.members.find((member) => member.deviceId === message.senderId);
  }

  private isOwnMessage(message: Pick<DecryptedMessage, 'senderId'>): boolean {
    const member = this.memberForMessage(message);
    return member ? member.role === this.session?.vault.role : message.senderId === this.session?.vault.identity.publicBundle.deviceId;
  }

  private replyPreview(text: string): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    return [...normalized].slice(0, 160).join('') || '文字消息';
  }

  private replyPreviewForMessage(message: DecryptedMessage): string {
    if (message.payload.kind === 'text') return this.replyPreview(message.payload.text);
    if (message.payload.kind === 'audio') return `语音 · ${voiceTime(message.payload.durationMs)}`;
    if (message.payload.kind === 'file' || message.payload.kind === 'gallery-file') return `${isVideoFile(message.payload.file) ? '视频' : '文件'} · ${this.replyPreview(message.payload.file.originalName || '未命名文件')}`;
    if (message.payload.kind === 'image-album') return `${message.payload.images.length} 张图片`;
    if (message.payload.kind === 'message-read') return '消息已读';
    if (message.payload.kind === 'media-read') return '媒体已读';
    if (message.payload.kind === 'reaction') return '表情回应';
    return '图片';
  }

  private localReplyPreview(reference: ReplyReference, deletedForEveryone = this.messageDeletions()): string {
    if (this.messageIsUnavailable(reference.clientMsgId, deletedForEveryone)) return '消息已删除';
    const target = this.messages.get(reference.serverSeq);
    if (target?.clientMsgId === reference.clientMsgId) return this.replyPreviewForMessage(target);
    return reference.kind === 'text' ? '较早的文字消息 · 点按查看'
      : reference.kind === 'audio' ? '较早的语音 · 点按查看'
        : reference.kind === 'file' ? '较早的文件 · 点按查看' : '较早的图片 · 点按查看';
  }

  private replyReference(message: DecryptedMessage): ReplyReference {
    return {
      clientMsgId: message.clientMsgId,
      serverSeq: message.seq,
      senderId: message.senderId,
      kind: message.payload.kind === 'text' ? 'text' : message.payload.kind === 'audio' ? 'audio' : message.payload.kind === 'file' ? 'file' : 'image',
      // Keep the v2 wire field generic. Devices that own the referenced
      // history render a local preview; newly linked devices never receive a
      // copied excerpt from a message before their MLS join boundary.
      preview: message.payload.kind === 'text' ? '文字消息' : message.payload.kind === 'audio' ? '语音消息' : message.payload.kind === 'file' ? '文件' : '图片',
    };
  }

  private renderReplyDraft(): void {
    const draft = this.root.querySelector<HTMLElement>('#reply-draft');
    if (!draft) return;
    if (!this.replyTarget) {
      draft.hidden = true;
      return;
    }
    draft.querySelector('strong')!.textContent = this.isOwnMessage(this.replyTarget) ? '回复自己' : '回复对方';
    draft.querySelector('span')!.textContent = this.replyPreviewForMessage(this.replyTarget);
    draft.hidden = false;
  }

  private beginReply(message: DecryptedMessage): void {
    if (!Number.isSafeInteger(message.seq) || message.seq < 1 || message.seq >= Number.MAX_SAFE_INTEGER) return;
    if (this.messageIsUnavailable(message.clientMsgId)) {
      this.closeMessageActions(false, false);
      this.showNotice('原消息已删除');
      return;
    }
    this.replyTarget = message;
    this.closeMessageActions();
    this.renderReplyDraft();
    this.restoreComposerFocus();
  }

  private cancelMessageHold(): void {
    if (this.messageHoldTimer !== null) window.clearTimeout(this.messageHoldTimer);
    this.messageHoldTimer = null;
    this.messageHoldStart = null;
  }

  private mountMessageActions(article: HTMLElement, message: DecryptedMessage): void {
    article.addEventListener('selectstart', event => { if (!article.classList.contains('is-selecting-text')) event.preventDefault(); });
    article.addEventListener('dragstart', event => { if (!article.classList.contains('is-selecting-text')) event.preventDefault(); });
    article.addEventListener('contextmenu', event => { if (!article.classList.contains('is-selecting-text')) event.preventDefault(); });
    article.addEventListener('click', event => {
      // A completed hold on the voice play control may be followed by a
      // synthesized click. Consume only that click so opening Delete never
      // starts playback underneath the action sheet.
      if (Date.now() < this.suppressMediaClickUntil && event.target instanceof Element
        && event.target.closest('.voice-player .voice-control')) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, { capture: true });
    const currentMessage = () => this.messages.get(this.renderedMessageSeq.get(message.clientMsgId) ?? 0)
      ?? this.pending.get(message.clientMsgId) ?? message;
    let selectedBlobId: string | undefined;
    const selectImage = (target: EventTarget | null) => {
      selectedBlobId = target instanceof Element ? target.closest<HTMLElement>('[data-blob-id]')?.dataset.blobId : undefined;
    };
    const open = () => this.openMessageActions(article, currentMessage(), selectedBlobId);
    article.addEventListener('pointerdown', (event) => {
      selectImage(event.target);
      if (article.classList.contains('is-selecting-text')) return;
      const target = event.target instanceof Element ? event.target : null;
      const insideVoicePlayer = Boolean(target?.closest('.voice-player'));
      const excludedButton = target?.closest(insideVoicePlayer
        ? 'button:not(.voice-control)'
        : 'input, button:not(.image-preview):not(.album-cell):not(.file-attachment):not(.voice-control)');
      if (event.button !== 0 || event.pointerType === 'mouse' || excludedButton) return;
      this.cancelMessageHold();
      this.messageHoldStart = { x: event.clientX, y: event.clientY };
      // Match the usual native touch-and-hold cadence without letting Safari
      // select message text underneath the custom menu.
      this.messageHoldTimer = window.setTimeout(() => {
        this.messageHoldTimer = null;
        this.suppressMediaClickUntil = Date.now() + 650;
        if (typeof navigator.vibrate === 'function') navigator.vibrate(18);
        open();
      }, 500);
    });
    article.addEventListener('pointermove', (event) => {
      const start = this.messageHoldStart;
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) this.cancelMessageHold();
    });
    for (const eventName of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
      article.addEventListener(eventName, () => this.cancelMessageHold());
    }
    article.addEventListener('contextmenu', (event) => {
      selectImage(event.target);
      if (article.classList.contains('is-selecting-text')) return;
      event.preventDefault();
      this.cancelMessageHold();
      open();
    });
    article.addEventListener('keydown', (event) => {
      if (article.classList.contains('is-selecting-text')) return;
      if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
        selectImage(event.target);
        event.preventDefault();
        open();
      }
    });
    const swipeIndicator = document.createElement('span');
    swipeIndicator.className = 'message-reply-swipe-indicator';
    swipeIndicator.setAttribute('aria-hidden', 'true');
    swipeIndicator.innerHTML = icons.reply;
    article.append(swipeIndicator);
    let swipeWasArmed = false;
    const finishSwipeVisual = () => {
      article.classList.remove('is-reply-swiping', 'is-reply-armed', 'is-reply-settling');
      article.style.removeProperty('--reply-swipe-offset');
      article.style.removeProperty('--reply-swipe-progress');
      article.style.removeProperty('--reply-indicator-x');
      swipeWasArmed = false;
    };
    bindReplySwipe({
      element: article,
      enabled: () => {
        const current = currentMessage();
        return !this.privacyCovered && this.activeSurface === 'chat' && !article.classList.contains('is-selecting-text')
          && Number.isSafeInteger(current.seq) && current.seq > 0 && current.seq < Number.MAX_SAFE_INTEGER;
      },
      exclude: target => target instanceof Element && Boolean(target.closest(
        'input, textarea, audio, video, .message-reactions, .message-reply-quote, button:not(.image-preview):not(.album-cell):not(.file-attachment)',
      )),
      maxOffset: () => replySwipeMaxOffset(window.visualViewport?.width ?? window.innerWidth),
      gestureStart: () => {
        this.cancelMessageHold();
        // A clearly horizontal bubble gesture belongs to reply, even while the
        // keyboard is already open. Release the list-level dismissal gesture
        // before pointerup so it cannot blur and immediately reopen the same
        // textarea underneath the reply transition.
        this.chatKeyboardGesture?.reset();
        this.closeMessageActions(false, false);
        const bubble = article.querySelector<HTMLElement>('.message-bubble');
        // Keep the reply affordance underneath the bubble's trailing edge.
        // Moving it outside an outgoing row widens the document on narrow
        // screens even while the affordance is transparent.
        if (bubble) article.style.setProperty('--reply-indicator-x', `${Math.max(0, bubble.offsetLeft + bubble.offsetWidth - 43)}px`);
        article.classList.add('is-reply-swiping');
      },
      move: (offset, armed) => {
        article.style.setProperty('--reply-swipe-offset', `${offset}px`);
        article.style.setProperty('--reply-swipe-progress', String(Math.min(1, offset / 52)));
        article.classList.toggle('is-reply-armed', armed);
        if (armed && !swipeWasArmed) navigator.vibrate?.(12);
        swipeWasArmed = armed;
      },
      settle: activated => {
        const moved = article.classList.contains('is-reply-swiping');
        if (moved) {
          this.suppressMediaClickUntil = Date.now() + 500;
          article.classList.remove('is-reply-armed');
          article.classList.add('is-reply-settling');
          requestAnimationFrame(() => {
            article.style.setProperty('--reply-swipe-offset', '0px');
            article.style.setProperty('--reply-swipe-progress', '0');
          });
          window.setTimeout(finishSwipeVisual, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 280);
        } else finishSwipeVisual();
        if (activated) this.beginReply(currentMessage());
      },
    });
  }

  private openMessageActions(article: HTMLElement, message: DecryptedMessage, selectedBlobId?: string): void {
    if (!this.session || this.privacyCovered || !article.isConnected || this.messageIsUnavailable(message.clientMsgId)) return;
    this.clearMessageTextSelection();
    this.closeMessageActions(false, false);
    const backdrop = document.createElement('div');
    backdrop.className = 'message-actions-backdrop';
    backdrop.setAttribute('aria-hidden', 'true');
    backdrop.addEventListener('click', () => this.closeMessageActions());
    article.classList.add('is-action-source');
    const actions = document.createElement('div');
    actions.className = 'message-actions';
    actions.tabIndex = -1;
    actions.setAttribute('role', 'menu');
    actions.setAttribute('aria-label', '消息操作');
    actions.dataset.sourceId = message.clientMsgId;
    actions.dataset.openScrollY = String(this.chatScrollTop);
    const actionButtons: HTMLButtonElement[] = [];
    const confirmed = message.status !== 'pending' && message.status !== 'failed'
      && message.seq > 0 && message.seq < Number.MAX_SAFE_INTEGER;
    if (confirmed) {
      const picker = document.createElement('div');
      picker.className = 'message-reaction-picker';
      picker.setAttribute('role', 'group');
      picker.setAttribute('aria-label', '快速表情回应');
      const mine = this.messageReactions().get(message.clientMsgId)?.find(reaction => reaction.role === this.session!.vault.role);
      for (const emoji of REACTION_EMOJIS) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.reaction = emoji;
        button.setAttribute('role', 'menuitem');
        button.setAttribute('aria-label', `${mine?.emoji === emoji ? '取消' : '回应'} ${emoji}`);
        button.setAttribute('aria-pressed', String(mine?.emoji === emoji));
        button.textContent = emoji;
        button.addEventListener('click', () => void this.sendReaction(message, mine?.emoji === emoji ? null : emoji));
        picker.append(button);
        actionButtons.push(button);
      }
      actions.append(picker);
    }
    const list = document.createElement('div');
    list.className = 'message-action-list';
    const addAction = (action: string, label: string, icon: string, handler: () => void, danger = false) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.messageAction = action;
      button.setAttribute('role', 'menuitem');
      if (danger) button.dataset.danger = 'true';
      button.innerHTML = `${icon}<span>${label}</span>`;
      button.addEventListener('click', handler);
      list.append(button);
      actionButtons.push(button);
    };
    if (message.payload.kind === 'text') {
      const text = message.payload.text;
      addAction('copy', '拷贝', '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>', () => void this.copyMessageText(text, message));
      addAction('select', '选择文字', '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M8 5h8M12 5v14M9 19h6M4 3v18M20 3v18"/></svg>', () => this.openMessageTextSelection(message));
    }
    if (confirmed) addAction('reply', '回复', icons.reply, () => this.beginReply(message));
    const image = message.payload.kind === 'image' ? message.payload.image
      : message.payload.kind === 'image-album' ? message.payload.images.find(item => item.blobId === selectedBlobId) : undefined;
    if (image && MEME_TYPES.includes(image.mimeType)) addAction('favorite-meme', '收藏为表情', memeIcons.star, () => void this.favoriteChatMeme(message, image));
    const favoriteTargets = this.messageFavoriteTargets(message);
    if (favoriteTargets.length) {
      const saved = favoriteTargets.every(target => this.attachmentFavorite(target));
      addAction('favorite', saved ? '取消收藏' : '收藏', memeIcons.star, () => void this.toggleMessageFavorite(message));
    }
    // Local deletion is a projection preference, so an unsent or failed
    // outbox-backed message can be hidden without mutating its durable outbox
    // item. "For everyone" remains limited to confirmed own messages below.
    addAction('delete', '删除', icons.trash, () => this.openMessageDeleteChoices(actions, article, message), true);
    if (list.childElementCount) actions.append(list);
    if (!actionButtons.length) { article.classList.remove('is-action-source'); return; }
    this.root.append(backdrop, actions);
    const sourceBubble = article.querySelector<HTMLElement>('.message-bubble');
    if (sourceBubble) {
      const rect = sourceBubble.getBoundingClientRect();
      const preview = document.createElement('div');
      preview.className = `message-action-preview ${[...article.classList].filter(name => name !== 'is-action-source' && name !== 'message').join(' ')}`;
      preview.setAttribute('aria-hidden', 'true');
      preview.inert = true;
      preview.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`;
      const clone = sourceBubble.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
      preview.append(clone);
      backdrop.append(preview);
    }
    this.positionMessageActions(actions, article);
    actions.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Tab'].includes(event.key)) return;
      event.preventDefault();
      const navigable = actions.dataset.deleteOptions === 'true'
        ? [...actions.querySelectorAll<HTMLButtonElement>('.message-action-list > button')]
        : actionButtons;
      const index = navigable.indexOf(document.activeElement as HTMLButtonElement);
      const step = ['ArrowUp', 'ArrowLeft'].includes(event.key) || (event.key === 'Tab' && event.shiftKey) ? -1 : 1;
      const target = event.key === 'Home' ? 0 : event.key === 'End' ? navigable.length - 1
        : index < 0 ? (step < 0 ? navigable.length - 1 : 0) : (index + step + navigable.length) % navigable.length;
      navigable[target]?.focus({ preventScroll: true });
    });
    requestAnimationFrame(() => {
      if (!actions.isConnected || this.privacyCovered) return;
      actions.classList.add('is-visible');
      backdrop.classList.add('is-visible');
      // Focus the menu itself after a long press. Keyboard navigation moves to
      // a button and retains its visible ring, without selecting the first emoji.
      actions.focus({ preventScroll: true });
    });
  }

  private openMessageDeleteChoices(actions: HTMLElement, article: HTMLElement, message: DecryptedMessage): void {
    if (!actions.isConnected || !article.isConnected || this.privacyCovered || this.messageIsUnavailable(message.clientMsgId)) {
      this.closeMessageActions(false, false);
      return;
    }
    actions.querySelector('.message-reaction-picker')?.remove();
    const list = actions.querySelector<HTMLElement>('.message-action-list');
    if (!list) return;
    list.replaceChildren();
    actions.setAttribute('aria-label', '删除消息');
    actions.dataset.deleteOptions = 'true';
    const buttons: HTMLButtonElement[] = [];
    const add = (action: string, label: string, handler: () => void) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.messageAction = action;
      button.dataset.danger = 'true';
      button.setAttribute('role', 'menuitem');
      button.innerHTML = `${icons.trash}<span>${label}</span>`;
      button.addEventListener('click', handler);
      list.append(button);
      buttons.push(button);
    };
    const confirmed = message.status !== 'pending' && message.status !== 'failed'
      && Number.isSafeInteger(message.seq) && message.seq > 0 && message.seq < Number.MAX_SAFE_INTEGER;
    if (confirmed && this.isOwnMessage(message)) add('delete-everyone', '为所有人删除', () => void this.deleteMessageForEveryone(message));
    add('delete-local', '仅为我删除', () => void this.deleteMessageForThisDevice(message));
    this.positionMessageActions(actions, article);
    // These are choices, not a selected answer. Keyboard navigation can move
    // focus into either item without painting a default selected state.
    actions.focus({ preventScroll: true });
  }

  private async deleteMessageForThisDevice(message: DecryptedMessage): Promise<void> {
    const session = this.session;
    const epoch = this.runtimeEpoch;
    if (!session || this.privacyCovered || this.messageIsUnavailable(message.clientMsgId)) return;
    const previous = this.uiPreferences.hiddenChatMessageIds;
    const hidden = new Set(previous ?? []);
    if (!hidden.has(message.clientMsgId.toLowerCase()) && hidden.size >= 20_000) {
      this.closeMessageActions(false, false);
      this.showNotice('这台设备保存的本机删除记录已达上限；请先保留当前记录，不会自动恢复较早消息', 'error');
      return;
    }
    hidden.add(message.clientMsgId.toLowerCase());
    const next = [...hidden];
    this.uiPreferences.hiddenChatMessageIds = next;
    const previousReplyTarget = this.replyTarget?.clientMsgId === message.clientMsgId ? this.replyTarget : null;
    if (this.replyTarget?.clientMsgId === message.clientMsgId) this.replyTarget = null;
    this.closeMessageActions(false, false);
    this.renderMessages({ scroll: 'preserve' });
    this.renderReplyDraft();
    try {
      await this.saveUiPreferencesNow();
      if (this.isRuntimeActive(epoch, session)) this.showNotice('已仅从这台设备的聊天中删除');
    } catch (cause) {
      if (!this.isRuntimeActive(epoch, session)) return;
      if (this.uiPreferences.hiddenChatMessageIds === next) {
        this.uiPreferences.hiddenChatMessageIds = previous;
        if (!this.replyTarget && previousReplyTarget) this.replyTarget = previousReplyTarget;
        this.renderMessages({ scroll: 'preserve' });
        this.renderReplyDraft();
      }
      this.operationalError(cause, '本机删除未能保存，消息已恢复');
    }
  }

  private async deleteMessageForEveryone(message: DecryptedMessage): Promise<void> {
    const session = this.session;
    const epoch = this.runtimeEpoch;
    if (!session || this.privacyCovered || message.status === 'pending' || message.status === 'failed'
      || !this.isOwnMessage(message) || this.messageIsUnavailable(message.clientMsgId)
      || !Number.isSafeInteger(message.seq) || message.seq < 1 || message.seq >= Number.MAX_SAFE_INTEGER) return;
    this.closeMessageActions(false, false);
    if (!this.activeDevicesSupport('message-delete-v1')) {
      this.showNotice('请先让所有已授权设备打开最新版，再为所有人删除消息');
      return;
    }
    try {
      await this.enqueuePayload({
        v: 1,
        kind: 'message-delete',
        target: { clientMsgId: message.clientMsgId, serverSeq: message.seq, senderId: message.senderId },
        sentAt: new Date().toISOString(),
      });
      if (this.isRuntimeActive(epoch, session)) {
        this.showNotice(this.connectionState === 'connected'
          ? '删除请求已加密保存，正在同步到其他设备'
          : '删除请求已加密保存在本机；连接恢复并同步后才会在其他设备生效');
      }
    } catch (cause) {
      if (this.isRuntimeActive(epoch, session)) this.operationalError(cause, '消息删除操作未能保存');
    }
  }

  private positionMessageActions(actions: HTMLElement, article: HTMLElement): void {
    actions.style.setProperty('--app-height', `${this.chatViewportHeight}px`);
    const rect = article.querySelector('.message-bubble')?.getBoundingClientRect() ?? article.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? window.innerWidth;
    const height = viewport?.height ?? window.innerHeight;
    const list = actions.querySelector<HTMLElement>('.message-action-list');
    const picker = actions.querySelector<HTMLElement>('.message-reaction-picker');
    const menuWidth = list?.offsetWidth ?? 212;
    const pickerHeight = picker?.offsetHeight ?? 0;
    if (list) list.style.maxHeight = `${Math.max(48, height - pickerHeight - 32)}px`;
    const menuHeight = list?.offsetHeight ?? 0;
    const x = Math.max(left + 12, Math.min(rect.left, left + width - menuWidth - 12));
    const below = rect.bottom + 12;
    const above = rect.top - pickerHeight - 12;
    let y = below;
    let pickerY = above;
    if (above >= top + 8 && below + menuHeight <= top + height - 8) {
      // Keep the selected bubble between its reaction bar and action list.
    } else if (rect.top - menuHeight - pickerHeight - 32 >= top + 8) {
      y = rect.top - menuHeight - 12;
      pickerY = y - pickerHeight - 8;
    } else if (below + pickerHeight + menuHeight + 8 <= top + height - 8) {
      pickerY = below;
      y = below + pickerHeight + 8;
    } else {
      // Tall messages leave no free edge. Keep both controls accessible in a
      // single stack instead of independently clamping them into one another.
      pickerY = top + 8;
      y = picker ? pickerY + pickerHeight + 8 : top + 8;
    }
    actions.style.setProperty('--message-action-x', `${Math.round(x)}px`);
    actions.style.setProperty('--message-action-y', `${Math.round(y)}px`);
    if (list) {
      list.style.setProperty('--action-origin-x', `${Math.max(0, Math.min(menuWidth, rect.left + rect.width / 2 - x))}px`);
      list.style.setProperty('--action-origin-y', `${Math.max(0, Math.min(menuHeight, rect.top + rect.height / 2 - y))}px`);
    }
    if (picker) {
      const pickerX = Math.max(left + 8, Math.min(rect.left, left + width - picker.offsetWidth - 8));
      actions.style.setProperty('--message-reaction-x', `${Math.round(pickerX)}px`);
      actions.style.setProperty('--message-reaction-y', `${Math.round(pickerY)}px`);
    }
  }

  private messageReactions() {
    const members = new Map(this.session?.vault.members.map(member => [member.deviceId, member.role]) ?? []);
    return reduceMessageReactions([...this.messageEventHistory.values(), ...this.messages.values(), ...this.pending.values()], members);
  }

  private messageDeletions(additionalMessages: readonly DecryptedMessage[] = []) {
    const members = new Map(this.session?.vault.members.map(member => [member.deviceId, member.role]) ?? []);
    return reduceMessageDeletions([
      ...this.messageEventHistory.values(),
      ...this.messages.values(),
      ...this.pending.values(),
      ...additionalMessages,
    ], members);
  }

  private async sendReaction(message: DecryptedMessage, emoji: ReactionEmoji | null): Promise<void> {
    const session = this.session;
    const epoch = this.runtimeEpoch;
    if (!session || this.privacyCovered || message.seq <= 0 || message.seq >= Number.MAX_SAFE_INTEGER) return;
    if (this.messageIsUnavailable(message.clientMsgId)) {
      this.closeMessageActions(false, false);
      this.showNotice('原消息已删除');
      return;
    }
    if (!this.activeDevicesSupport('message-reactions-v1')) {
      this.closeMessageActions();
      this.showNotice('请先让所有已授权设备打开最新版，再使用表情回应');
      return;
    }
    this.closeMessageActions();
    try {
      await this.enqueuePayload({ v: 1, kind: 'reaction', target: { clientMsgId: message.clientMsgId, serverSeq: message.seq, senderId: message.senderId }, emoji, sentAt: new Date().toISOString() });
    } catch (cause) {
      if (this.isRuntimeActive(epoch, session)) this.operationalError(cause, '表情回应未能保存');
    }
  }

  private renderMessageReactions(): boolean {
    const reactions = this.messageReactions();
    let layoutChanged = false;
    for (const article of this.renderedMessageOrder) {
      const badges = reactions.get(article.dataset.clientMsgId ?? '');
      let group = article.querySelector<HTMLElement>('.message-reactions');
      if (!badges?.length) {
        if (group) { group.remove(); layoutChanged = true; }
        continue;
      }
      if (!group) group = document.createElement('div');
      group.className = 'message-reactions';
      group.style.setProperty('--reaction-width', `${badges.length * 44}px`);
      const roles = new Set(badges.map(reaction => reaction.role));
      for (const child of group.querySelectorAll<HTMLButtonElement>('button')) {
        if (!roles.has(child.dataset.role as 'creator' | 'joiner')) child.remove();
      }
      for (const reaction of badges) {
        let button = group.querySelector<HTMLButtonElement>(`[data-role="${reaction.role}"]`);
        const isNew = !button;
        if (!button) button = document.createElement('button');
        button.type = 'button';
        button.className = 'message-reaction';
        button.dataset.role = reaction.role;
        button.dataset.own = String(reaction.role === this.session?.vault.role);
        button.dataset.pending = String(reaction.pending);
        button.setAttribute('aria-label', `${reaction.role === this.session?.vault.role ? '我' : '对方'}回应了 ${reaction.emoji}${reaction.pending ? '，等待发送' : ''}`);
        if (button.textContent !== reaction.emoji) button.textContent = reaction.emoji;
        if (isNew) {
          button.addEventListener('click', () => {
            const message = this.messages.get(this.renderedMessageSeq.get(article.dataset.clientMsgId ?? '') ?? 0);
            if (message) this.openMessageActions(article, message);
          });
          group.append(button);
        }
      }
      if (!group.isConnected) {
        article.querySelector('.message-bubble')?.append(group);
        layoutChanged = true;
      }
    }
    return layoutChanged;
  }

  private async copyMessageText(text: string, message: DecryptedMessage): Promise<void> {
    const session = this.session;
    const epoch = this.runtimeEpoch;
    if (!session || !this.isRuntimeActive(epoch, session)) return;
    if (this.messageIsUnavailable(message.clientMsgId)) {
      this.closeMessageActions(false, false);
      this.showNotice('原消息已删除');
      return;
    }
    const source = this.root.querySelector<HTMLElement>('.message-actions:not(.is-closing)');
    if (source && source.dataset.sourceId !== message.clientMsgId) return;
    const isCurrent = () => this.isRuntimeActive(epoch, session)
      && this.root.querySelector('.message-actions:not(.is-closing)') === source;
    try {
      await this.withSystemSurface(() => navigator.clipboard.writeText(text));
      if (!isCurrent()) return;
      this.closeMessageActions(true);
      this.showNotice('已复制');
    } catch {
      if (!isCurrent()) return;
      this.openMessageTextSelection(message);
      this.showNotice('请选中文字后复制');
    }
  }

  private openMessageTextSelection(message: DecryptedMessage): void {
    if (!this.session || this.privacyCovered || message.payload.kind !== 'text') return;
    this.clearMessageTextSelection();
    this.closeMessageActions(false, false);
    const article = this.root.querySelector<HTMLElement>(`.message[data-client-msg-id="${CSS.escape(message.clientMsgId)}"]`);
    const text = article?.querySelector<HTMLElement>('.message-text');
    if (!article || !text) return;
    const bounds = text.getBoundingClientRect();
    const selection = document.createElement('textarea');
    selection.className = 'message-text message-text-selection';
    selection.value = message.payload.text;
    selection.readOnly = true;
    selection.spellcheck = false;
    selection.inputMode = 'none';
    selection.setAttribute('aria-label', '选择消息文字');
    selection.style.width = `${bounds.width}px`;
    selection.style.height = `${bounds.height}px`;
    article.classList.add('is-selecting-text');
    this.selectedMessageId = message.clientMsgId;
    text.replaceWith(selection);
    // Keep native selection in the original bubble and in the user's gesture.
    // WebKit owns the handles and whether its system edit menu is presented.
    selection.focus({ preventScroll: true });
    selection.select();
  }

  private clearMessageTextSelection(): void {
    if (!this.selectedMessageId) return;
    const article = this.root.querySelector<HTMLElement>(`.message[data-client-msg-id="${CSS.escape(this.selectedMessageId)}"]`);
    const selected = article?.querySelector<HTMLTextAreaElement>('.message-text-selection');
    if (selected) {
      const text = document.createElement('p');
      text.className = 'message-text';
      text.textContent = selected.value;
      selected.replaceWith(text);
    }
    article?.classList.remove('is-selecting-text');
    this.selectedMessageId = null;
    window.getSelection()?.removeAllRanges();
  }

  private closeMessageActions(restoreFocus = false, animate = true): void {
    this.cancelMessageHold();
    const backdrops = [...this.root.querySelectorAll('.message-actions-backdrop')];
    const sources = [...this.root.querySelectorAll('.is-action-source')];
    const actions = this.root.querySelector<HTMLElement>('.message-actions');
    const finish = () => {
      for (const source of sources) {
        const current = this.root.querySelector<HTMLElement>('.message-actions:not(.is-closing)');
        if (current === actions || current?.dataset.sourceId !== (source as HTMLElement).dataset.clientMsgId) source.classList.remove('is-action-source');
      }
      backdrops.forEach(element => element.remove());
      actions?.remove();
    };
    if (!actions) { finish(); return; }
    if (closeDialog(actions, { animate, restoreFocus })) { finish(); return; }
    const sourceId = actions.dataset.sourceId;
    actions.classList.remove('is-visible');
    actions.classList.add('is-closing');
    actions.inert = true;
    backdrops.forEach(element => { element.classList.remove('is-visible'); element.classList.add('is-closing'); });
    if (animate && !this.privacyCovered && !matchMedia('(prefers-reduced-motion: reduce)').matches) window.setTimeout(finish, 320);
    else finish();
    if (restoreFocus && sourceId) {
      if (!this.privacyCovered) this.root.querySelector<HTMLElement>(`.message[data-client-msg-id="${CSS.escape(sourceId)}"]`)?.focus({ preventScroll: true });
    }
  }

  private async jumpToReplyTarget(clientMsgId: string, seq?: number): Promise<void> {
    const jumpVersion = ++this.replyJumpVersion;
    const session = this.session;
    const epoch = this.runtimeEpoch;
    const list = this.root.querySelector<HTMLElement>('#message-list');
    if (!session || this.privacyCovered || !list) return;
    if (this.messageIsUnavailable(clientMsgId)) {
      this.showNotice('原消息已删除');
      return;
    }
    this.chatBottomControl?.cancel();
    this.cancelChatMessageMotion();
    this.chatRestoreAnchor = null;
    this.chatScrollIntent = 'up';
    this.chatPinnedToBottom = false;
    this.chatBottomFollowPending = false;
    this.chatViewportFollowUntil = 0;
    this.chatResumeBottomOnFocus = false;
    let target = list.querySelector<HTMLElement>(`.message[data-client-msg-id="${CSS.escape(clientMsgId)}"]`);
    if (!target && seq !== undefined) {
      try {
        const signal = this.runtimeAbort?.signal;
        const saved = await loadHistoryMessage(session, seq, signal);
        if (!this.isRuntimeActive(epoch, session) || !list.isConnected || this.replyJumpVersion !== jumpVersion) return;
        if (saved?.clientMsgId === clientMsgId && saved.payload.kind !== 'gallery-image' && saved.payload.kind !== 'gallery-file'
          && saved.payload.kind !== 'reaction' && saved.payload.kind !== 'message-delete' && saved.payload.kind !== 'media-read' && saved.payload.kind !== 'message-read') {
          const nearby = await loadHistoryPage(session, { limit: 200, beforeSeq: Math.min(seq + 101, Number.MAX_SAFE_INTEGER), signal });
          if (!this.isRuntimeActive(epoch, session) || !list.isConnected || this.replyJumpVersion !== jumpVersion) return;
          for (const message of nearby) this.messages.set(message.seq, message);
          this.messages.set(saved.seq, saved);
          if (saved.seq > 1) this.historyHasMore = true;
          this.renderMessages({ scroll: 'position' });
          target = list.querySelector<HTMLElement>(`.message[data-client-msg-id="${CSS.escape(clientMsgId)}"]`);
        }
      } catch (cause) {
        if (this.isRuntimeActive(epoch, session) && list.isConnected && this.replyJumpVersion === jumpVersion) this.operationalError(cause, '原消息暂时无法读取，请重试');
        return;
      }
    }
    if (!target) {
      this.showNotice('这台设备未保存可读取的原消息');
      return;
    }
    const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    if (this.usesListScrolling) {
      const rect = target.getBoundingClientRect();
      list.scrollTo({ top: list.scrollTop + rect.top + rect.height / 2
        - list.getBoundingClientRect().top - list.clientHeight / 2, behavior });
    } else target.scrollIntoView({ block: 'center', behavior });
    target.classList.add('is-highlighted');
    if (this.messageHighlightTimer !== null) window.clearTimeout(this.messageHighlightTimer);
    this.messageHighlightTimer = window.setTimeout(() => {
      target.classList.remove('is-highlighted');
      this.messageHighlightTimer = null;
    }, 1400);
  }

  private renderMessages({ scroll = 'preserve' }: { scroll?: 'preserve' | 'position' | 'bottom' | 'send' | 'restore' } = {}): void {
    const list = this.root.querySelector<HTMLElement>('#message-list');
    if (!list || !this.session) return;
    const reflowOrigins = new Map<HTMLElement, number>();
    if (scroll === 'preserve') {
      // Capture the pixels the user currently sees, including an in-flight
      // earlier FLIP. Rows themselves do not carry that transform—their
      // visible children do—so row bounds would make a rapid second reaction
      // snap back before starting its new animation.
      // Message rows are monotonic in document order, so avoid measuring the
      // entire loaded history when only the viewport can be animated.
      const captureTop = this.chatViewportTop - 64;
      const captureBottom = this.chatViewportTop + this.chatViewportHeight + 64;
      let first = 0;
      let high = list.children.length;
      while (first < high) {
        const middle = Math.floor((first + high) / 2);
        const row = list.children[middle] as HTMLElement;
        if (row.getBoundingClientRect().bottom < captureTop) first = middle + 1;
        else high = middle;
      }
      for (let index = first; index < list.children.length; index += 1) {
        const row = list.children[index] as HTMLElement;
        if (row.getBoundingClientRect().top > captureBottom) break;
        const contents = row.classList.contains('message-date') ? [row] : [...row.children];
        for (const content of contents) {
          if (content instanceof HTMLElement && !content.classList.contains('message-reply-swipe-indicator')) {
            reflowOrigins.set(content, content.getBoundingClientRect().top);
          }
        }
      }
    }
    const sendRequested = scroll === 'send';
    const followSend = sendRequested;
    const previousLatest = followSend ? this.renderedMessageOrder.at(-1) : null;
    const previousLatestTop = previousLatest?.isConnected ? previousLatest.querySelector('.message-bubble')?.getBoundingClientRect().top ?? null : null;
    if (followSend) {
      // A send can commit while IME wrapping is still animating. Preserve the
      // painted input height before committing the new row; otherwise the old
      // height owner blocks bottom alignment after its row animations cancel.
      const input = this.chatLayoutElements?.composer.querySelector<HTMLTextAreaElement>('#message-input');
      if (input && this.composerHeightMotion) {
        const height = input.getBoundingClientRect().height;
        if (this.composerHeightMotion.frame !== null) cancelAnimationFrame(this.composerHeightMotion.frame);
        this.composerHeightMotion = null;
        input.style.height = `${height}px`;
        input.style.removeProperty('transition');
        this.cancelChatMessageMotion();
        this.syncChatLayout();
      }
      this.cancelChatMessageMotion();
    }
    const anchor = scroll === 'restore'
      ? this.uiPreferences.chatAnchor
      : this.captureChatAnchor(false, scroll === 'position');
    if (scroll === 'bottom' || followSend || scroll === 'position') this.chatRestoreAnchor = null;
    else if (scroll === 'restore') this.chatRestoreAnchor = anchor && !anchor.pinnedToBottom ? anchor : null;
    const previousReadIds = this.readMessageIds;
    const compatibility = `${this.activeDevicesSupport('message-read-v1')}:${this.activeDevicesSupport('media-read-v1')}`;
    const sameReadCompatibility = this.readCompatibility === compatibility;
    this.readCompatibility = compatibility;
    this.readMessageIds = readMessageIds([...this.messageEventHistory.values(), ...this.messages.values()], new Map(this.session.vault.members.map(member => [member.deviceId, member.role])));
    const deletedForEveryone = this.messageDeletions();
    const messages = this.orderedMessages(deletedForEveryone);
    const visibleMessageIds = new Set(messages.map(message => message.clientMsgId));
    const openActions = this.root.querySelector<HTMLElement>('.message-actions');
    if (openActions?.dataset.sourceId && !visibleMessageIds.has(openActions.dataset.sourceId)) {
      // A remote tombstone can arrive while the source menu is open. Remove
      // the detached controls synchronously so their captured handlers cannot
      // copy, react to, reply to, or delete an already removed target.
      this.closeMessageActions(false, false);
    }
    if (this.selectedMessageId && !visibleMessageIds.has(this.selectedMessageId)) this.clearMessageTextSelection();
    if (this.replyTarget && !messages.some(message => message.clientMsgId === this.replyTarget?.clientMsgId)) {
      this.replyTarget = null;
      this.renderReplyDraft();
    }
    if (messages.length === 0 && this.videoUploads.size === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-conversation';
      const title = document.createElement('p');
      title.textContent = '会话已经准备好';
      const detail = document.createElement('span');
      detail.textContent = '文字、语音和原图都会在这台设备上加密后再发送。';
      empty.append(title, detail);
      this.renderedMessages.clear();
      this.renderedMessageOrder = [];
      this.renderedMessageDates.clear();
      this.renderedMessageSeq.clear();
      list.replaceChildren(empty);
    } else {
      const currentKeys = new Set<string>();
      const elements: HTMLElement[] = [];
      const timeline: HTMLElement[] = [];
      const dateKeys = new Set<string>();
      const currentYear = new Date().getFullYear();
      const sequences = new Map<string, number>();
      const uploadDrafts = [...this.videoUploads.entries()].filter(([id]) => !visibleMessageIds.has(id))
        .sort(([, a], [, b]) => a.sentAt.localeCompare(b.sentAt));
      for (const message of messages) {
        while (message.seq === Number.MAX_SAFE_INTEGER && uploadDrafts[0] && uploadDrafts[0][1].sentAt <= message.acceptedAt) {
          timeline.push(uploadDrafts.shift()![1].view.element);
        }
        const key = message.clientMsgId;
        currentKeys.add(key);
        const cached = this.renderedMessages.get(key);
        // Payloads are immutable after decryption/enqueue. Compare their
        // identity and mutable delivery metadata without serializing history.
        // Keep the native selection mounted while independently refreshing its
        // delivery decoration. Legacy confirmation can decrypt a fresh payload.
        const selecting = this.selectedMessageId === key && cached?.payload.kind === 'text'
          && message.payload.kind === 'text' && cached.payload.text === message.payload.text;
        const unchanged = cached?.payload === message.payload && cached.status === message.status && cached.acceptedAt === message.acceptedAt
          && previousReadIds.has(key) === this.readMessageIds.has(key) && sameReadCompatibility;
        // Legacy confirmation decrypts a fresh but equivalent payload. Compare
        // that changed object only; unchanged history retains the fast path.
        const samePayload = cached?.payload === message.payload || Boolean(cached && canonicalStringify(cached.payload) === canonicalStringify(message.payload));
        const keepContent = Boolean(cached && (selecting || samePayload));
        const element = keepContent ? cached!.element : this.createMessageElement(message, deletedForEveryone);
        if (keepContent && !unchanged) {
          // A delivery receipt updates decoration only. Preserve decoded media,
          // in-flight downloads, playback, focus and any send-motion layer.
          const meta = element.querySelector<HTMLElement>('.message-meta');
          const updated = this.createMessageMeta(message);
          if (meta) {
            meta.replaceChildren(...updated.childNodes);
            for (const attribute of ['title', 'aria-label']) {
              const value = updated.getAttribute(attribute);
              if (value === null) meta.removeAttribute(attribute);
              else meta.setAttribute(attribute, value);
            }
          }
          element.classList.remove(`is-${cached!.status}`);
          element.classList.add(`is-${message.status}`);
        }
        // Deletion is a projection event rather than a mutation of the reply
        // payload. Refresh the mounted quote even on the immutable-content
        // fast path so a tombstoned target never leaves a stale preview behind.
        if (keepContent && 'replyTo' in message.payload && message.payload.replyTo) {
          const quote = element.querySelector<HTMLButtonElement>('.message-reply-quote');
          const preview = quote?.querySelector<HTMLElement>('span');
          if (quote && preview) {
            const projected = this.localReplyPreview(message.payload.replyTo, deletedForEveryone);
            if (preview.textContent !== projected) preview.textContent = projected;
            quote.setAttribute('aria-label', projected === '消息已删除' ? '被回复的消息已删除' : `查看被回复的消息：${projected}`);
          }
        }
        if (cached && !keepContent && cached.element.parentElement === list) {
          const hadFocus = cached.element.contains(document.activeElement);
          cached.element.replaceWith(element);
          if (hadFocus) element.focus({ preventScroll: true });
        }
        this.renderedMessages.set(key, { payload: message.payload, status: message.status, acceptedAt: message.acceptedAt, element });
        sequences.set(key, message.seq);
        elements.push(element);
        const day = messageLocalDay(message.payload.sentAt, currentYear);
        if (day && !dateKeys.has(day.key)) {
          dateKeys.add(day.key);
          let separator = this.renderedMessageDates.get(day.key);
          if (!separator) {
            separator = document.createElement('div');
            separator.className = 'message-date';
            separator.dataset.dateKey = day.key;
            separator.setAttribute('role', 'heading');
            separator.setAttribute('aria-level', '3');
            const time = document.createElement('time');
            time.dateTime = day.key;
            separator.append(time);
            this.renderedMessageDates.set(day.key, separator);
          }
          separator.setAttribute('aria-label', day.description);
          if (separator.firstChild!.textContent !== day.label) separator.firstChild!.textContent = day.label;
          timeline.push(separator);
        }
        timeline.push(element);
      }
      for (const key of this.renderedMessages.keys()) {
        if (!currentKeys.has(key)) this.renderedMessages.delete(key);
      }
      for (const key of this.renderedMessageDates.keys()) {
        if (!dateKeys.has(key)) this.renderedMessageDates.delete(key);
      }
      for (const [, draft] of uploadDrafts) timeline.push(draft.view.element);
      // Keep unchanged nodes in place so focus, image decode state, selection
      // and compositing survive incoming messages and delivery receipts.
      let next = list.firstElementChild;
      for (const element of timeline) {
        if (element === next) next = next.nextElementSibling;
        else list.insertBefore(element, next);
      }
      while (next) {
        const stale = next;
        next = next.nextElementSibling;
        stale.remove();
      }
      // Upload tiles participate in scrolling/geometry, never in read cursors.
      for (const [id] of this.videoUploads) if (!visibleMessageIds.has(id)) sequences.set(id, Number.MAX_SAFE_INTEGER);
      this.renderedMessageOrder = this.videoUploads.size ? timeline.filter(element => element.classList.contains('message')) : elements;
      this.renderedMessageSeq = sequences;
    }
    const reactionLayoutChanged = this.renderMessageReactions();
    this.mountChatImageObserver(list);
    this.voicePlayback.prune();
    if (scroll === 'bottom' || followSend || !anchor) {
      this.chatPinnedToBottom = true;
      this.scrollChatToBottom();
      this.captureChatAnchor(true);
    } else {
      this.restoreChatAnchor(list, anchor);
    }
    this.finishChatAnchorRestore(list);
    this.chatPinnedToBottom = !this.chatRestoreAnchor && this.chatScrollIntent !== 'up'
      && (this.chatBottomFollowPending || this.chatBottomGap() <= 2);
    this.restoreChatAnchorOnNextRender = false;
    this.markVisibleMessagesRead();
    if (followSend && previousLatestTop !== null && previousLatest?.isConnected) {
      this.animateChatMessageShift(previousLatestTop - previousLatest.getBoundingClientRect().top);
    }
    if (reactionLayoutChanged) this.animateChatReactionReflow(reflowOrigins);
    this.updateChatBottomControl();
  }

  private cancelChatMessageMotion(): void {
    for (const animation of this.chatMessageAnimations) animation.cancel();
    this.chatMessageAnimations.clear();
    for (const content of this.chatMessageTranslations) content.style.removeProperty('translate');
    this.chatMessageTranslations.clear();
  }

  private animateChatMessageShift(distance: number, duration = 280,
    maximumOffset = Math.min(280, this.chatViewportHeight * 0.45),
    easing = 'cubic-bezier(0.16, 1, 0.3, 1)'): void {
    this.cancelChatMessageMotion();
    if (distance < 1 || matchMedia('(prefers-reduced-motion: reduce)').matches || this.chatBottomFollowPending) return;
    const offset = Math.min(distance, maximumOffset);
    // Scroll and anchors are committed once. Animate only visible content
    // inside each row, so fixed bars and all geometry used by unread/scroll
    // bookkeeping stay in their final positions throughout the transition.
    for (let row = this.chatLayoutElements?.list.lastElementChild; row; row = row.previousElementSibling) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom < this.chatViewportTop - offset) break;
      if (rect.top > this.chatViewportTop + this.chatViewportHeight) continue;
      // A newly introduced day belongs to the same visual movement as its
      // messages. It remains outside message/sequence bookkeeping.
      const contents = row.classList.contains('message-date') ? [row] : row.children;
      for (const content of contents) {
        if (!(content instanceof HTMLElement)) continue;
        const animation = content.animate(
          [{ translate: `0 ${offset}px` }, { translate: '0 0' }],
          { duration, easing, fill: 'backwards' },
        );
        this.chatMessageAnimations.add(animation);
        animation.finished.then(() => this.chatMessageAnimations.delete(animation), () => this.chatMessageAnimations.delete(animation));
      }
    }
  }

  private animateChatReactionReflow(origins: ReadonlyMap<HTMLElement, number>): void {
    if (!origins.size || matchMedia('(prefers-reduced-motion: reduce)').matches || this.privacyCovered) return;
    this.cancelChatMessageMotion();
    for (const [content, previousTop] of origins) {
      if (!content.isConnected) continue;
      const rect = content.getBoundingClientRect();
      const distance = previousTop - rect.top;
      if (Math.abs(distance) < 0.5) continue;
      if (rect.bottom < this.chatViewportTop - 32 || rect.top > this.chatViewportTop + this.chatViewportHeight + 32) continue;
      const animation = content.animate(
        [{ translate: `0 ${distance}px` }, { translate: '0 0' }],
        { duration: 300, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'backwards' },
      );
      // Force the inverse position onto the same rendering frame as the
      // reaction layout mutation. A pending WAAPI animation may otherwise
      // expose one destination frame before its first timeline sample.
      animation.currentTime = 0;
      this.chatMessageAnimations.add(animation);
      animation.finished.then(() => this.chatMessageAnimations.delete(animation), () => this.chatMessageAnimations.delete(animation));
    }
  }

  private async loadOlderHistory(list: HTMLElement): Promise<void> {
    const session = this.session;
    const epoch = this.runtimeEpoch;
    if (!session || this.privacyCovered || this.activeSurface !== 'chat'
      || this.chatLayoutElements?.list !== list || !list.isConnected
      || !this.historyHasMore || this.historyLoading) return;
    if (this.messages.size === 0) {
      this.historyHasMore = false;
      return;
    }
    const firstSeq = Math.min(...this.messages.keys());
    if (!Number.isFinite(firstSeq) || firstSeq <= 1) {
      this.historyHasMore = false;
      return;
    }
    this.historyLoading = true;
    list.dataset.historyLoading = 'true';
    try {
      const older = await loadHistoryPage(session, { limit: 200, beforeSeq: firstSeq, signal: this.runtimeAbort?.signal });
      if (!this.isRuntimeActive(epoch, session) || this.activeSurface !== 'chat'
        || this.chatLayoutElements?.list !== list || !list.isConnected) return;
      if (older.length < 200) this.historyHasMore = false;
      for (const message of older) this.messages.set(message.seq, message);
      this.renderMessages({ scroll: 'preserve' });
    } catch (cause) {
      if (this.isRuntimeActive(epoch, session) && this.activeSurface === 'chat'
        && this.chatLayoutElements?.list === list && list.isConnected) {
        this.operationalError(cause, '较早的消息暂时无法读取，请重试');
      }
    } finally {
      if (this.isRuntimeActive(epoch, session)) this.historyLoading = false;
      delete list.dataset.historyLoading;
    }
  }

  private async loadNewerHistory(list: HTMLElement, scrollSignal?: AbortSignal): Promise<void> {
    const session = this.session;
    const epoch = this.runtimeEpoch;
    if (!session || this.privacyCovered || this.activeSurface !== 'chat'
      || this.chatLayoutElements?.list !== list || !list.isConnected
      || !this.historyHasNewer || this.historyLoading) return;
    this.historyLoading = true;
    list.dataset.historyLoading = 'true';
    try {
      const newer = await loadHistoryPageAfter(session, {
        limit: 200,
        afterSeq: this.historyForwardCursor,
        signal: scrollSignal && this.runtimeAbort ? AbortSignal.any([scrollSignal, this.runtimeAbort.signal]) : scrollSignal ?? this.runtimeAbort?.signal,
      });
      if (!this.isRuntimeActive(epoch, session) || this.activeSurface !== 'chat'
        || this.chatLayoutElements?.list !== list || !list.isConnected || scrollSignal?.aborted) return;
      if (newer.length === 0) {
        this.historyHasNewer = false;
        return;
      }
      for (const message of newer) {
        this.messages.set(message.seq, {
          ...message,
          status: message.status === 'sent'
            ? (message.senderId === session.vault.identity.publicBundle.deviceId ? 'stored' : 'delivered')
            : message.status,
        });
      }
      this.historyForwardCursor = Math.max(
        this.historyForwardCursor,
        ...newer.map((message) => message.seq),
      );
      this.historyHasNewer = this.historyForwardCursor < session.vault.lastSeq;
      this.renderMessages({ scroll: 'position' });
    } catch (cause) {
      if (this.isRuntimeActive(epoch, session) && this.activeSurface === 'chat'
        && this.chatLayoutElements?.list === list && list.isConnected && !scrollSignal?.aborted) {
        this.operationalError(cause, '后续消息暂时无法读取，请重试');
      }
    } finally {
      if (this.isRuntimeActive(epoch, session)) this.historyLoading = false;
      delete list.dataset.historyLoading;
    }
  }

  private createMessageElement(message: DecryptedMessage, deletedForEveryone = this.messageDeletions()): HTMLElement {
    const own = this.isOwnMessage(message);
    const article = document.createElement('article');
    article.className = `message ${own ? 'outgoing' : 'incoming'} is-${message.status}`;
    article.dataset.clientMsgId = message.clientMsgId;
    article.tabIndex = 0;
    article.setAttribute('aria-label', own
      ? '我的消息，可向左滑动回复，或长按回应、复制、删除'
      : '对方消息，可向左滑动回复，或长按回应、回复、复制、删除');
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    if ('replyTo' in message.payload && message.payload.replyTo) {
      const quote = document.createElement('button');
      quote.type = 'button';
      quote.className = 'message-reply-quote';
      const projectedReplyPreview = this.localReplyPreview(message.payload.replyTo, deletedForEveryone);
      quote.setAttribute('aria-label', projectedReplyPreview === '消息已删除'
        ? '被回复的消息已删除'
        : `查看被回复的消息：${projectedReplyPreview}`);
      const label = document.createElement('strong');
      label.textContent = this.isOwnMessage({ senderId: message.payload.replyTo.senderId }) ? '你' : '对方';
      const preview = document.createElement('span');
      preview.textContent = projectedReplyPreview;
      quote.append(label, preview);
      const targetId = message.payload.replyTo.clientMsgId;
      const targetSeq = message.payload.replyTo.serverSeq;
      quote.addEventListener('click', () => void this.jumpToReplyTarget(targetId, targetSeq));
      bubble.append(quote);
    }
    if (message.payload.kind === 'text') {
      bubble.classList.add('text-bubble');
      const text = document.createElement('p');
      text.className = 'message-text';
      text.textContent = message.payload.text;
      bubble.append(text);
    } else if (message.payload.kind === 'audio') {
      bubble.classList.add('voice-bubble');
      const payload = message.payload;
      const session = this.session!;
      const epoch = this.runtimeEpoch;
      const player = new VoicePlayer(payload, this.voicePlayback, async (playbackSignal) => {
        if (!this.isRuntimeActive(epoch, session)) throw new DOMException('Session locked', 'AbortError');
        if (this.voiceRecorder) throw new Error('请先结束录音');
        const signal = AbortSignal.any([playbackSignal, this.runtimeAbort!.signal]);
        const blob = await decryptAudioFile(payload.audio,
          (blobId, index) => voiceRequest('VOICE_DOWNLOAD_INTERRUPTED', attemptSignal => fetchBlobChunk(session.vault.roomId, session.vault.accessToken, blobId, index, attemptSignal), signal), undefined, signal);
        signal.throwIfAborted();
        if (!this.isRuntimeActive(epoch, session)) throw new DOMException('Session locked', 'AbortError');
        return blob;
      });
      bubble.append(player.element);
    } else if (message.payload.kind === 'file') {
      if (isVideoFile(message.payload.file)) {
        bubble.classList.add('image-bubble');
        bubble.append(this.createImagePreview(message.payload.file, [message.payload.file], 0, message.clientMsgId));
      } else {
        bubble.classList.add('file-bubble');
        bubble.append(this.createFileAttachment(message.payload.file, true, message));
      }
    } else if (message.payload.kind === 'image-album') {
      article.classList.add('has-media');
      bubble.classList.add('image-bubble');
      const album = document.createElement('div');
      const countClass = message.payload.images.length <= 4 ? String(message.payload.images.length) : 'many';
      album.className = `image-album album-count-${countClass}`;
      album.setAttribute('aria-label', `${message.payload.images.length} 张图片`);
      for (const [index, manifest] of message.payload.images.entries()) {
        const preview = this.createImagePreview(manifest, message.payload.images, index, message.clientMsgId, `第 ${index + 1} 张，共 ${message.payload.images.length} 张`);
        preview.classList.add('album-cell');
        album.append(preview);
      }
      bubble.append(album);
    } else if (message.payload.kind === 'image' || message.payload.kind === 'gallery-image') {
      article.classList.add('has-media');
      bubble.classList.add('image-bubble');
      const expression = isExpressionPayload(message.payload);
      if (expression) bubble.classList.add('expression-bubble');
      const preview = this.createImagePreview(message.payload.image, [message.payload.image], 0, message.clientMsgId);
      if (expression) {
        preview.dataset.expression = 'true';
        if (message.payload.kind === 'image' && message.payload.expressionAutoHide !== undefined) preview.dataset.expressionAutoHide = String(message.payload.expressionAutoHide);
        const image = preview.querySelector('img');
        if (image) image.style.width = `${image.width * 2 / 3}px`;
        this.updateChatImageVisibility(preview);
      }
      bubble.append(preview);
    }
    const dimensionedPreview = bubble.querySelector<HTMLButtonElement>(':scope > .image-preview[data-media-dimensions="known"]');
    if (dimensionedPreview) {
      bubble.dataset.mediaDimensions = 'known';
      for (const property of [
        '--chat-media-aspect', '--chat-media-ratio', '--chat-media-source-width',
        '--chat-expression-natural-width', '--chat-media-height-width', '--chat-expression-height-width',
      ]) bubble.style.setProperty(property, dimensionedPreview.style.getPropertyValue(property));
    }
    bubble.append(this.createMessageMeta(message));
    article.append(bubble);
    this.mountMessageActions(article, message);
    return article;
  }

  private createMessageMeta(message: DecryptedMessage): HTMLElement {
    const own = this.isOwnMessage(message);
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const read = this.readMessageIds.has(message.clientMsgId);
    const status = own
      ? message.status === 'pending'
        ? ' · 等待发送'
        : message.status === 'stored' || message.status === 'sent' || message.status === 'delivered'
          ? read ? '已读' : '已发送'
          : ' · 发送失败'
      : '';
    const time = document.createElement('time');
    time.dateTime = message.payload.sentAt;
    time.textContent = timeLabel(message.payload.sentAt);
    meta.append(time);
    if (own && (message.status === 'stored' || message.status === 'sent' || message.status === 'delivered')) {
      const delivery = document.createElement('span');
      delivery.className = 'message-delivery';
      delivery.dataset.state = read ? 'read' : 'sent';
      // One complete check; a read receipt adds the second rising arm, matching
      // the compact Telegram receipt rather than placing two glyphs side by side.
      delivery.innerHTML = `<svg aria-hidden="true" viewBox="0 0 22 16"><path d="m2 8 4 4L16 2"/>${read ? '<path d="m10 12 10-10"/>' : ''}</svg>`;
      const label = document.createElement('span');
      label.className = 'sr-only';
      label.textContent = status;
      delivery.append(label);
      meta.append(delivery);
    } else if (own && message.status === 'pending') {
      const waiting = document.createElement('span');
      waiting.className = 'message-pending';
      waiting.innerHTML = '<svg aria-hidden="true" viewBox="0 0 22 16"><circle cx="11" cy="8" r="6"/><path d="M11 4.5V8l2.5 1.5"/></svg>';
      const label = document.createElement('span');
      label.className = 'sr-only';
      label.textContent = '等待发送';
      waiting.append(label);
      meta.append(waiting);
    } else if (status) meta.append(document.createTextNode(status));
    if (own) {
      meta.title = read ? '对方已读：至少一台设备已在前台显示这条消息'
        : message.status === 'delivered' ? '服务器已保存加密消息，对方设备已接收，尚无已读回执'
        : message.status === 'stored' || message.status === 'sent' ? '服务器已保存加密消息，等待对方接收'
          : message.status === 'pending' ? '已保存在本机，等待发送到服务器' : '发送失败，可以重试';
      if (message.payload.kind === 'audio' && message.status === 'failed') { meta.title = VOICE_FAILURE_TEXT.VOICE_ACK_UNKNOWN; meta.dataset.errorCode = 'VOICE_ACK_UNKNOWN'; }
      meta.setAttribute('aria-label', `${timeLabel(message.payload.sentAt)}，${meta.title}`);
    }
    if (own && message.status === 'failed') {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'message-retry';
      retry.textContent = '重试';
      retry.addEventListener('click', () => {
        message.status = 'pending';
        this.renderMessages();
        void this.attemptSend(message.clientMsgId);
      });
      meta.append(' · ', retry);
    }
    return meta;
  }

  private createFileAttachment(manifest: FileManifest, allowExport = true, source?: DecryptedMessage): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'file-attachment';
    button.dataset.blobId = manifest.blobId;
    button.dataset.fileState = 'idle';
    const filename = manifest.originalName || '未命名文件';
    const size = this.fileSize(manifest.originalSize);
    const readableType = documentReaderMimeType(manifest.mimeType, filename);
    const actionLabel = readableType ? '打开文件' : '下载文件';
    button.setAttribute('aria-label', `${actionLabel} ${filename}，${size}`);
    button.innerHTML = `<span class="file-attachment-copy"><strong class="file-attachment-name"></strong><span class="file-attachment-meta" aria-live="polite"></span></span><span class="file-attachment-action" aria-hidden="true">${icons.download}</span>`;
    button.prepend(createFileFormatIcon(manifest.mimeType, filename));
    if (readableType === 'application/epub+zip' && manifest.originalSize <= documentReaderLimit(readableType) && this.runtimeAbort && this.session) {
      const session = this.session, epoch = this.runtimeEpoch;
      observeEpubCover(button, async signal => {
        if (!this.isRuntimeActive(epoch, session)) throw new Error('RUNTIME_CLOSED');
        this.assertImageManifestIdentity(manifest);
        return this.withImageLoadSlot(() => decryptFileAttachment(manifest,
          (id, index) => fetchBlobChunk(session.vault.roomId, session.vault.accessToken, id, index, signal), undefined, signal));
      }, this.runtimeAbort.signal);
    }
    button.querySelector<HTMLElement>('.file-attachment-name')!.textContent = filename;
    const meta = button.querySelector<HTMLElement>('.file-attachment-meta')!;
    meta.textContent = `${size} · ${actionLabel}`;
    if (!allowExport) {
      button.setAttribute('aria-label', `${filename}，${size}，收藏操作`);
      meta.textContent = size;
      button.querySelector('.file-attachment-action')!.innerHTML = icons.more;
      return button;
    }
    button.addEventListener('click', () => {
      if (button.dataset.galleryHoldCommitted === 'true') {
        delete button.dataset.galleryHoldCommitted;
        return;
      }
      if (Date.now() < this.suppressMediaClickUntil) return;
      const session = this.session;
      const epoch = this.runtimeEpoch;
      const runtimeSignal = this.runtimeAbort?.signal;
      if (!session || this.privacyCovered || !button.isConnected || button.disabled) return;
      let reader: DocumentReader | undefined;
      if (readableType) {
        this.closeImageViewer(true);
        const previous = this.activeSurface;
        if (!this.setActiveSurface('away')) return;
        this.closeMessageActions(false, false);
        reader = new DocumentReader(this.root, filename, readableType, () => this.closeDocumentReader());
        this.documentReader = { view: reader, previous, returnFocus: button, source };
        const view = reader;
        runtimeSignal?.addEventListener('abort', () => this.closeDocumentReader(true), { once: true, signal: view.signal });
        if (manifest.originalSize > documentReaderLimit(readableType)) {
          reader.fail(`文件过大，阅读上限为 ${documentReaderLimit(readableType) / 1024 / 1024} MB`);
          return;
        }
      }
      const signal = reader?.signal ?? runtimeSignal;
      button.disabled = true;
      button.dataset.fileState = 'loading';
      button.setAttribute('aria-busy', 'true');
      meta.textContent = `${size} · 正在读取`;
      void (async () => {
        try {
          this.assertImageManifestIdentity(manifest);
          const blob = await decryptFileAttachment(manifest,
            (blobId, index) => fetchBlobChunk(session.vault.roomId, session.vault.accessToken, blobId, index, signal),
            ratio => {
              if (this.isRuntimeActive(epoch, session) && button.isConnected) meta.textContent = `${size} · 正在读取 ${Math.round(ratio * 100)}%`;
              reader?.progress(ratio);
            }, signal);
          if (!this.isRuntimeActive(epoch, session) || !button.isConnected || signal?.aborted) return;
          if (reader) {
            await reader.load(blob);
          } else {
            // Unsupported types remain inert downloads; the app never renders
            // arbitrary HTML, SVG, Office macros or executable content.
            this.beginFileExport();
            await this.withSystemSurface(() => downloadBlob(blob.slice(0, blob.size, 'application/octet-stream'), filename));
          }
          if (!this.isRuntimeActive(epoch, session) || !button.isConnected) return;
          button.dataset.fileState = 'idle';
          meta.textContent = `${size} · ${readableType ? '再次打开' : '再次下载'}`;
        } catch (cause) {
          if (!this.isRuntimeActive(epoch, session) || !button.isConnected) return;
          if (reader) {
            if (!reader.signal.aborted) reader.fail();
            button.dataset.fileState = 'idle';
            meta.textContent = `${size} · ${actionLabel}`;
            return;
          }
          this.finishFileExport();
          if (cause instanceof DOMException && cause.name === 'AbortError') {
            button.dataset.fileState = 'idle';
            meta.textContent = `${size} · ${actionLabel}`;
          } else {
            button.dataset.fileState = 'error';
            meta.textContent = `${size} · 下载失败，点按重试`;
            this.operationalError(cause, '文件下载失败，请重试');
          }
        } finally {
          if (this.isRuntimeActive(epoch, session) && button.isConnected) {
            if (signal?.aborted) { button.dataset.fileState = 'idle'; meta.textContent = `${size} · ${actionLabel}`; }
            button.disabled = false;
            button.setAttribute('aria-busy', 'false');
          }
        }
      })();
    });
    return button;
  }

  private renderRecoveryRotation(): void {
    const session = this.session;
    if (!session || this.privacyCovered) return;
    const epoch = this.runtimeEpoch;
    this.gatewayTemplate('更新恢复保护', '正在用新恢复码保护会话和历史备份。此步骤不会读取历史消息或保险箱。', `
      <p class="form-error" role="status"></p><button class="primary-button" id="retry-recovery-rotation" type="button">完成更新</button>
      <button class="text-button" id="lock-recovery-rotation" type="button">锁定，稍后继续</button>`);
    const button = this.root.querySelector<HTMLButtonElement>('#retry-recovery-rotation')!;
    const error = this.root.querySelector<HTMLElement>('[role=status]')!;
    this.root.querySelector('#lock-recovery-rotation')?.addEventListener('click', () => this.lockNow());
    const complete = async () => {
      if (button.disabled) return;
      setBusy(button, true, '正在保存新的恢复保护…');
      try {
        await syncCloudBackup(session, this.runtimeAbort!.signal);
        if (!button.isConnected || !this.isRuntimeActive(epoch, session)) return;
        const backup = session.vault.backup;
        if (!backup?.syncedAt || backup.replaces || session.vault.recoverySource) throw new Error('新恢复保护尚未保存成功');
        this.gatewayTemplate('请保存新的恢复码', '设备已恢复。以后恢复历史消息和保险箱，请使用这份新码。旧码已停止在线取件。', `
          <code class="local-recovery-code"></code><p class="field-hint">恢复码已在本机加密保管，也请单独保存一份。历史内容尚未载入。</p>
          <button class="primary-button" id="confirm-new-recovery" type="button">我已保存，进入会话</button>
          <button class="text-button" id="lock-new-recovery" type="button">锁定</button><p class="form-error" role="alert"></p>`);
        const codeNode = this.root.querySelector<HTMLElement>('code')!;
        codeNode.textContent = backup.code;
        const timer = window.setTimeout(() => { if (codeNode.isConnected) this.lockNow(); }, 60_000);
        this.runtimeAbort!.signal.addEventListener('abort', () => { window.clearTimeout(timer); codeNode.textContent = ''; }, { once: true });
        this.root.querySelector('#lock-new-recovery')?.addEventListener('click', () => this.lockNow());
        this.root.querySelector('#confirm-new-recovery')?.addEventListener('click', async () => {
          try {
            await withVaultMutation(session, async mutation => {
              if (!this.isRuntimeActive(epoch, session)) return;
              session.vault.backup!.newCodePending = false;
              try { await saveVault(session, mutation); } catch (cause) { session.vault.backup!.newCodePending = true; throw cause; }
            });
            window.clearTimeout(timer); codeNode.textContent = '';
            if (this.isRuntimeActive(epoch, session)) await this.openSession();
          } catch (cause) { if (codeNode.isConnected) this.showFormError(cause); }
        });
      } catch (cause) {
        if (button.isConnected && this.isRuntimeActive(epoch, session)) error.textContent = cause instanceof Error ? cause.message : '恢复保护更新未完成，请重试';
      } finally { if (button.isConnected) setBusy(button, false); }
    };
    button.addEventListener('click', () => void complete());
    void complete();
  }

  private startAutomaticBackup(): void {
    if (this.backupTimer !== null) window.clearInterval(this.backupTimer);
    this.backupTimer = window.setInterval(() => void this.runAutomaticBackup(), 15_000);
    void this.runAutomaticBackup(true);
  }

  private runAutomaticBackup(force = false): Promise<void> {
    if (this.backupRun) return this.backupRun;
    const session = this.session;
    const signal = this.runtimeAbort?.signal;
    if (!session || !signal || this.privacyCovered || document.hidden) return Promise.resolve();
    const epoch = this.runtimeEpoch;
    const run = syncCloudBackup(session, signal, { force }).then(() => {
      if (this.isRuntimeActive(epoch, session)) this.backupError = '';
    }).catch(cause => {
      if (this.isRuntimeActive(epoch, session)) this.backupError = cause instanceof Error ? cause.message : '自动备份暂未完成';
    }).finally(() => {
      if (this.backupRun === run) this.backupRun = null;
      if (this.isRuntimeActive(epoch, session)) this.updateBackupStatus();
    });
    this.backupRun = run;
    this.updateBackupStatus();
    return run;
  }

  private updateBackupStatus(): void {
    const status = this.root.querySelector<HTMLElement>('#backup-status');
    if (!status || !this.session) return;
    const backup = this.session.vault.backup;
    const state = this.backupError ? 'error' : this.backupRun ? 'syncing' : backup?.syncedAt ? 'ready' : 'pending';
    status.closest<HTMLElement>('[data-backup-state]')!.dataset.backupState = state;
    status.textContent = this.backupError || (this.backupRun ? '正在加密并备份…' : backup?.syncedAt
      ? `上次备份：${new Date(backup.syncedAt).toLocaleString()}\n已保存 ${backup.archives.reduce((total, archive) => total + archive.parts.reduce((sum, part) => sum + part.count, 0), 0)} 条历史记录。`
      : '尚未完成首次备份，联网并保持页面解锁后会自动重试。');
    const ready = Boolean(backup?.syncedAt && !backup.replaces && !this.session.vault.recoverySource);
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-backup-ready]')) button.disabled = !ready;
  }

  private renderBackupSettings(): void {
    const session = this.session;
    if (!session || this.privacyCovered) return;
    this.captureChatAnchor(false);
    this.closeVoiceRecorder();
    this.voicePlayback.stop();
    if (!this.setActiveSurface('away')) return;
    const epoch = this.runtimeEpoch;
    this.root.innerHTML = `<main class="backup-page">
      <header class="subpage-header backup-header">
        <button class="icon-button" id="backup-back" type="button" aria-label="返回聊天">${icons.back}</button>
        <div class="backup-heading"><h1>备份与恢复</h1><p>本机加密 · 自动同步</p></div>
        <span class="backup-header-spacer" aria-hidden="true"></span>
      </header>
      <section class="backup-content">
        <p class="backup-intro">恢复码只保存在你的设备上，请另行妥善保存。Quiet Room 和管理员都无法替你找回。</p>
        <div class="backup-settings-group">
          <section class="backup-setting backup-sync-setting" data-backup-state="pending">
            <div class="backup-setting-copy"><span class="backup-setting-icon" aria-hidden="true">${icons.download}</span>
              <div><h2>自动备份</h2><p id="backup-status" role="status"></p></div></div>
            <button class="secondary-button" id="backup-retry" type="button">立即备份</button>
          </section>
          <section class="backup-setting">
            <div class="backup-setting-copy"><span class="backup-setting-icon" aria-hidden="true">${icons.lock}</span>
              <div><h2>本设备恢复码</h2><p>再次验证通行密钥后在本机查看。</p></div></div>
            <button class="secondary-button" id="view-local-recovery" data-backup-ready type="button" disabled>查看本设备恢复码</button>
          </section>
          <section class="backup-setting backup-restore-setting">
            <div class="backup-setting-copy"><span class="backup-setting-icon" aria-hidden="true">${icons.safe}</span>
              <div><h2>恢复历史内容</h2><p>旧内容不会自动出现，请选择要恢复的范围。</p></div></div>
            <div class="backup-actions"><button class="secondary-button" data-restore="chat" data-backup-ready type="button" disabled>恢复历史消息</button>
            ${session.vault.role === 'creator' ? '<button class="secondary-button" data-restore="gallery" data-backup-ready type="button" disabled>恢复保险箱</button>' : ''}</div>
            <div id="history-restore-form"></div>
          </section>
        </div>
        <p class="backup-footnote">自动备份仅在页面解锁且联网时运行，锁定后暂停。</p>
      </section>
    </main>`;
    let restoreOperation: AbortController | undefined;
    let historyChanged = false;
    const cancelRestore = () => restoreOperation?.abort();
    this.runtimeAbort!.signal.addEventListener('abort', cancelRestore, { once: true });
    this.root.querySelector('#backup-back')?.addEventListener('click', async () => {
      cancelRestore();
      this.runtimeAbort?.signal.removeEventListener('abort', cancelRestore);
      this.transitionPage('backward', () => { if (historyChanged) void this.openSession(); else this.renderChat(); });
    });
    this.root.querySelector('#backup-retry')?.addEventListener('click', () => void this.runAutomaticBackup(true));
    this.root.querySelector('#view-local-recovery')?.addEventListener('click', () => this.verifyLocalRecoveryCode());
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-restore]')) button.addEventListener('click', () => {
      if (!this.isRuntimeActive(epoch, session)) return;
      cancelRestore();
      const scope = button.dataset.restore === 'gallery' ? 'gallery' : 'chat';
      const host = this.root.querySelector<HTMLElement>('#history-restore-form')!;
      host.innerHTML = `<form><label>本设备当前恢复码<input name="code" type="password" autocomplete="off" spellcheck="false" required placeholder="QR3-…" /></label>
        <p class="field-hint">${scope === 'chat' ? '仅恢复历史消息。' : '仅恢复保险箱，不把旧消息加入聊天列表。'}图片原件在你查看时才下载解密。</p>
        <button class="primary-button" type="submit">验证并恢复${scope === 'chat' ? '历史消息' : '保险箱'}</button><p role="status"></p></form>`;
      const form = host.querySelector('form')!;
      const input = form.querySelector('input')!;
      input.focus();
      form.addEventListener('submit', async event => {
        event.preventDefault();
        const submit = form.querySelector<HTMLButtonElement>('button')!;
        if (submit.disabled || !this.isRuntimeActive(epoch, session)) return;
        let code = input.value.trim(); input.value = '';
        const status = form.querySelector<HTMLElement>('[role=status]')!;
        setBusy(submit, true, '正在恢复…');
        const operation = new AbortController();
        restoreOperation = operation;
        try {
          const count = await restoreCloudHistory(session, code, scope, operation.signal, (count, changed) => {
            if (changed) historyChanged = true;
            if (form.isConnected && this.isRuntimeActive(epoch, session)) status.textContent = `已恢复 ${count} 条记录…`;
          });
          code = '';
          if (!form.isConnected || !this.isRuntimeActive(epoch, session)) return;
          status.textContent = `恢复完成，新增 ${count} 条记录。返回会话后即可查看。`;
          // A retry may add only an encrypted delete projection while all
          // content rows were imported by an interrupted prior attempt.
          // `progress.changed` keeps that event-only commit from reviving the
          // old Safe/chat projection until the next unlock.
        } catch (cause) {
          if (form.isConnected && this.isRuntimeActive(epoch, session)) status.textContent = `${cause instanceof Error ? cause.message : '恢复未完成'}。已通过验证的记录会保留，可安全重试。`;
        } finally { code = ''; if (restoreOperation === operation) restoreOperation = undefined; if (submit.isConnected) setBusy(submit, false); }
      });
    });
    this.updateBackupStatus();
  }

  private verifyLocalRecoveryCode(): void {
    const original = this.session;
    if (!original || this.privacyCovered) return;
    const roomId = original.vault.roomId;
    const deviceId = original.vault.identity.publicBundle.deviceId;
    this.lockNow();
    this.privacyCovered = false;
    document.body.className = 'app-mode';
    this.gatewayTemplate('查看本设备恢复码', '请再次验证通行密钥。恢复码只在这台设备上解密显示。', `
      <button class="primary-button" id="verify-recovery-passkey" type="button">验证通行密钥</button>
      <p class="form-error" role="alert"></p><button class="text-button" id="cancel-recovery-view" type="button">取消并锁定</button>`);
    const button = this.root.querySelector<HTMLButtonElement>('#verify-recovery-passkey')!;
    const error = this.root.querySelector<HTMLElement>('.form-error')!;
    const epoch = this.runtimeEpoch;
    this.root.querySelector('#cancel-recovery-view')?.addEventListener('click', () => this.lockNow());
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      error.textContent = '';
      setBusy(button, true, '正在验证…');
      try {
        const unlocked = await this.withDeviceVerification(() => unlockVault());
        if (!button.isConnected || this.privacyCovered || this.runtimeEpoch !== epoch) return;
        if (unlocked.vault.roomId !== roomId || unlocked.vault.identity.publicBundle.deviceId !== deviceId) throw new Error('本设备会话已变化，请重新进入');
        const backup = unlocked.vault.backup;
        if (!backup?.syncedAt || backup.replaces || unlocked.vault.recoverySource) throw new Error('新恢复码还未完成备份，请先联网完成更新');
        this.session = unlocked;
        this.runtimeAbort = new AbortController();
        this.resetIdleLock();
        this.gatewayTemplate('本设备恢复码', '请单独保存。恢复码不会发送到服务器，此页面将在一分钟后锁定。', `
          <code class="local-recovery-code"></code><button class="secondary-button" id="copy-local-recovery" type="button">复制恢复码</button>
          <button class="primary-button" id="hide-local-recovery" type="button">隐藏并返回</button><p class="field-hint" role="status"></p>`);
        const codeNode = this.root.querySelector<HTMLElement>('.local-recovery-code')!;
        codeNode.textContent = backup.code;
        const timer = window.setTimeout(() => { if (codeNode.isConnected) this.lockNow(); }, 60_000);
        this.runtimeAbort.signal.addEventListener('abort', () => { window.clearTimeout(timer); codeNode.textContent = ''; }, { once: true });
        this.root.querySelector('#copy-local-recovery')?.addEventListener('click', async () => {
          try {
            await this.withSystemSurface(() => navigator.clipboard.writeText(codeNode.textContent ?? ''));
            if (codeNode.isConnected) this.root.querySelector<HTMLElement>('[role=status]')!.textContent = '已复制到系统剪贴板，请妥善保管。';
          } catch { if (codeNode.isConnected) this.root.querySelector<HTMLElement>('[role=status]')!.textContent = '复制失败，请手动保存。'; }
        });
        this.root.querySelector('#hide-local-recovery')?.addEventListener('click', async () => {
          window.clearTimeout(timer); codeNode.textContent = '';
          await this.openSession();
          if (this.isRuntimeActive(epoch, unlocked)) this.renderBackupSettings();
        });
      } catch (cause) {
        if (button.isConnected && !this.privacyCovered) {
          if (isPlatformVaultCancellation(cause)) button.dataset.label = '重新验证';
          else error.textContent = cause instanceof Error ? cause.message : '验证未完成';
        }
      } finally { if (button.isConnected) setBusy(button, false); }
    });
  }

  private renderCloudRecovery(): void {
    this.gatewayTemplate('恢复已有会话', '输入恢复码，自动取得服务器上的加密备份并在本机解密。', `
      <form id="cloud-recovery-form" class="gateway-form"><label>恢复码<input name="code" type="password" autocomplete="off" spellcheck="false" required placeholder="QR3-…" /></label>
      <p class="field-hint">设备恢复需要另一台已授权设备在线。历史消息和保险箱将在恢复后由你主动选择读取。</p>
      <p class="form-error" role="alert"></p><button class="primary-button" type="submit">验证并恢复设备</button></form>
      <button class="text-button" id="cloud-recovery-cancel" type="button">取消并锁定</button>`);
    const form = this.root.querySelector<HTMLFormElement>('#cloud-recovery-form')!;
    const epoch = this.runtimeEpoch;
    const controller = new AbortController();
    this.runtimeAbort?.abort();
    this.runtimeAbort = controller;
    this.root.querySelector('#cloud-recovery-cancel')?.addEventListener('click', () => this.lockNow());
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const button = form.querySelector<HTMLButtonElement>('button')!;
      if (button.disabled) return;
      let code = String(new FormData(form).get('code') ?? '').trim(); form.reset();
      setBusy(button, true, '正在读取加密备份…');
      try {
        const unlocked = await recoverFromCloud(code, controller.signal);
        code = '';
        if (!form.isConnected || this.privacyCovered || epoch !== this.runtimeEpoch) return;
        this.session = unlocked;
        this.renderRecoveredVaultBinding();
      } catch (cause) {
        if (form.isConnected && !this.privacyCovered) form.querySelector<HTMLElement>('.form-error')!.textContent = cause instanceof Error ? cause.message : '恢复失败';
      } finally { code = ''; if (button.isConnected) setBusy(button, false); }
    });
  }

  private beginFileExport(): void {
    this.fileExportActive = true;
    if (this.fileExportResetTimer !== null) window.clearTimeout(this.fileExportResetTimer);
    // Identify the native handoff so even a brief blur covers the page.
    this.fileExportResetTimer = window.setTimeout(() => this.finishFileExport(), 1800);
  }

  private finishFileExport(): void {
    this.fileExportActive = false;
    if (this.fileExportResetTimer !== null) window.clearTimeout(this.fileExportResetTimer);
    this.fileExportResetTimer = null;
  }

  private videoPlayBadge(): HTMLElement {
    const badge = document.createElement('span');
    badge.className = 'video-play';
    badge.setAttribute('aria-hidden', 'true');
    badge.innerHTML = '<svg viewBox="0 0 24 24"><path d="m9 5 11 7-11 7Z"/></svg>';
    return badge;
  }

  private async ensureVideoPoster(manifest: ImageManifest, cached: CachedImage): Promise<void> {
    if (cached.posterUrl || cached.posterUnavailable) return;
    if (cached.posterPromise) return cached.posterPromise;
    const session = this.session;
    const epoch = this.runtimeEpoch;
    const signal = this.runtimeAbort?.signal;
    if (!session || this.privacyCovered) return;
    cached.posterPromise = (async () => {
      try {
        const poster = await this.withImageLoadSlot(() => createVideoPoster(cached.url, signal));
        if (!this.isRuntimeActive(epoch, session) || this.imageCache.get(manifest.blobId) !== cached) return;
        cached.posterUrl = URL.createObjectURL(poster.blob);
        cached.width = poster.width;
        cached.height = poster.height;
        cached.bytes += poster.blob.size;
        this.imageCacheBytes += poster.blob.size;
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
        // Decoding support varies by codec. Keep a playable/downloadable video
        // tile when a verified original has no browser-decodable poster.
        if (this.isRuntimeActive(epoch, session)) cached.posterUnavailable = true;
      } finally { cached.posterPromise = undefined; }
    })();
    return cached.posterPromise;
  }

  private stopViewerMedia(): void {
    this.viewerWorkAbort?.abort();
    this.viewerWorkAbort = null;
    this.viewerDetailsCleanup?.();
    this.viewerDetailsCleanup = null;
    this.viewerMediaCleanup?.();
    this.viewerMediaCleanup = null;
  }

  private renderViewerVideo(
    stage: HTMLElement,
    cached: CachedImage,
    manifest: ImageManifest,
    { autoplay, requestNative }: { autoplay: boolean; requestNative: boolean },
  ): { video: HTMLVideoElement; cleanup: () => void } {
    const video = document.createElement('video');
    const nativeVideo = video as HTMLVideoElement & {
      webkitEnterFullscreen?: () => void;
      webkitExitFullscreen?: () => void;
      webkitDisplayingFullscreen?: boolean;
    };
    const viewer = stage.closest<HTMLElement>('.image-viewer')!;
    video.controls = requestNative;
    video.autoplay = autoplay;
    // iPhone may enter its system player as part of play() while its metadata
    // is still loading. Do not force that playback back into an inline player.
    video.playsInline = !requestNative || typeof nativeVideo.webkitEnterFullscreen !== 'function';
    video.preload = 'auto';
    video.disablePictureInPicture = true;
    video.disableRemotePlayback = true;
    video.setAttribute('controlslist', 'nodownload noremoteplayback');
    video.setAttribute('aria-label', `播放视频 ${manifest.originalName}`);
    if (cached.posterUrl) video.poster = cached.posterUrl;
    const feedback = document.createElement('button');
    feedback.type = 'button';
    feedback.className = 'viewer-video-feedback';
    feedback.hidden = true;
    const controls = document.createElement('div');
    controls.className = 'viewer-video-controls';
    controls.innerHTML = `
      <input class="viewer-video-seek" type="range" min="0" max="0" value="0" step="0.1" aria-label="视频进度" disabled>
      <div class="viewer-video-transport">
        <button class="viewer-control" type="button" data-video-play></button>
        <span class="viewer-video-time" aria-live="off">0:00 / 0:00</span>
        <button class="viewer-control" type="button" data-video-mute></button>
        <button class="viewer-control" type="button" data-video-fullscreen aria-label="全屏播放" title="全屏播放"></button>
      </div>`;
    const playButton = controls.querySelector<HTMLButtonElement>('[data-video-play]')!;
    const muteButton = controls.querySelector<HTMLButtonElement>('[data-video-mute]')!;
    const fullscreenButton = controls.querySelector<HTMLButtonElement>('[data-video-fullscreen]')!;
    const seek = controls.querySelector<HTMLInputElement>('input')!;
    const time = controls.querySelector<HTMLElement>('.viewer-video-time')!;
    fullscreenButton.append(createElement(Maximize));
    const formatTime = (value: number) => {
      const seconds = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor(seconds / 60) % 60;
      return `${hours ? `${hours}:${String(minutes).padStart(2, '0')}` : Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    };
    const updateControls = () => {
      const paused = video.paused || video.ended;
      const muted = video.muted || video.volume === 0;
      playButton.setAttribute('aria-label', paused ? '播放视频' : '暂停视频');
      playButton.title = paused ? '播放视频' : '暂停视频';
      playButton.replaceChildren(createElement(paused ? Play : Pause));
      muteButton.setAttribute('aria-label', muted ? '开启声音' : '静音');
      muteButton.title = muted ? '开启声音' : '静音';
      muteButton.setAttribute('aria-pressed', String(muted));
      muteButton.replaceChildren(createElement(muted ? VolumeX : Volume2));
      seek.disabled = !Number.isFinite(video.duration) || video.duration <= 0;
      seek.max = String(seek.disabled ? 0 : video.duration);
      seek.value = String(video.currentTime);
      seek.setAttribute('aria-valuetext', `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`);
      time.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
    };
    const events = new AbortController();
    let active = true;
    let nativeEntered = false;
    let nativePendingTimer: number | null = null;
    const live = () => active && !this.privacyCovered && video.isConnected;
    const revealFallback = () => {
      if (!live() || nativeEntered) return;
      delete viewer.dataset.nativeVideo;
      video.playsInline = true;
      video.controls = false;
    };
    const nativeBegan = () => {
      if (!live()) return;
      nativeEntered = true;
      viewer.dataset.nativeVideo = 'active';
      if (nativePendingTimer !== null) window.clearTimeout(nativePendingTimer);
    };
    const nativeEnded = () => {
      if (!live() || !nativeEntered) return;
      if (requestNative) this.closeImageViewer(true);
      else {
        nativeEntered = false;
        revealFallback();
        updateControls();
      }
    };
    const showError = () => {
      if (!live()) return;
      revealFallback();
      feedback.textContent = '此浏览器无法播放该视频';
      feedback.disabled = true;
      feedback.hidden = false;
    };
    const play = () => {
      if (!live()) return;
      feedback.hidden = true;
      void video.play().catch(cause => {
        if (!live()) return;
        if (cause instanceof DOMException && cause.name === 'NotAllowedError') {
          revealFallback();
          feedback.textContent = '点按播放视频';
          feedback.disabled = false;
          feedback.hidden = false;
        } else if (!(cause instanceof DOMException && cause.name === 'AbortError')) showError();
      });
    };
    const requestNativePlayer = () => {
      if (!live() || nativeEntered) return;
      video.controls = true;
      viewer.dataset.nativeVideo = 'pending';
      if (nativePendingTimer !== null) window.clearTimeout(nativePendingTimer);
      nativePendingTimer = window.setTimeout(revealFallback, 1200);
      try {
        // These calls must stay in the original thumbnail click stack when the
        // original is already verified. Awaiting play()/metadata loses the
        // activation required by browsers for entering full screen.
        if (typeof nativeVideo.webkitEnterFullscreen === 'function') {
          nativeVideo.webkitEnterFullscreen();
        } else if (typeof video.requestFullscreen === 'function' && document.fullscreenEnabled) {
          void video.requestFullscreen().then(() => {
            // A closing/locked viewer may outlive the native request briefly.
            // Its event listeners are already removed, so undo a late entry.
            if (!live() && document.fullscreenElement === video) void document.exitFullscreen().catch(() => undefined);
          }, revealFallback);
        } else revealFallback();
      } catch {
        // Safari can require loaded metadata. play() without playsinline may
        // already open its system player; retry its API once after metadata.
        if (video.readyState === 0 && typeof nativeVideo.webkitEnterFullscreen === 'function') {
          video.addEventListener('loadedmetadata', () => {
            if (!live() || nativeEntered) return;
            try { nativeVideo.webkitEnterFullscreen!(); } catch { revealFallback(); }
          }, { once: true, signal: events.signal });
        } else revealFallback();
      }
    };
    video.addEventListener('webkitbeginfullscreen', nativeBegan, { signal: events.signal });
    video.addEventListener('webkitendfullscreen', nativeEnded, { signal: events.signal });
    document.addEventListener('fullscreenchange', () => {
      if (document.fullscreenElement === video) nativeBegan();
      else if (nativeEntered) nativeEnded();
    }, { signal: events.signal });
    video.addEventListener('error', showError, { signal: events.signal });
    video.addEventListener('playing', () => { feedback.hidden = true; }, { signal: events.signal });
    for (const event of ['play', 'pause', 'ended', 'volumechange', 'durationchange', 'loadedmetadata', 'timeupdate']) {
      video.addEventListener(event, updateControls, { signal: events.signal });
    }
    playButton.addEventListener('click', () => { if (video.paused) play(); else video.pause(); }, { signal: events.signal });
    muteButton.addEventListener('click', () => {
      const muted = video.muted || video.volume === 0;
      video.muted = !muted;
      if (muted && video.volume === 0) video.volume = 1;
    }, { signal: events.signal });
    fullscreenButton.addEventListener('click', () => { requestNativePlayer(); play(); }, { signal: events.signal });
    seek.addEventListener('input', () => {
      if (!seek.disabled && live()) video.currentTime = Number(seek.value);
    }, { signal: events.signal });
    feedback.addEventListener('click', () => { if (requestNative) requestNativePlayer(); play(); }, { signal: events.signal });
    const cleanup = () => {
      active = false;
      events.abort();
      if (nativePendingTimer !== null) window.clearTimeout(nativePendingTimer);
      if (document.fullscreenElement === video) void document.exitFullscreen().catch(() => undefined);
      if (nativeVideo.webkitDisplayingFullscreen) {
        try { nativeVideo.webkitExitFullscreen?.(); } catch { /* Source removal still stops playback. */ }
      }
      video.pause();
      video.removeAttribute('src');
      video.removeAttribute('poster');
      video.load();
    };
    updateControls();
    stage.replaceChildren(video, controls, feedback);
    video.src = cached.url;
    if (requestNative) {
      requestNativePlayer();
    }
    if (autoplay) play();
    return { video, cleanup };
  }

  private updateChatImageVisibility(button: HTMLButtonElement): void {
    const key = button.dataset.revealKey!;
    const expression = button.dataset.expression === 'true';
    const autoHide = button.dataset.expressionAutoHide === 'true';
    const explicitExpressionVisibility = button.dataset.expressionAutoHide !== undefined;
    const revealed = !this.privacyCovered && (expression && explicitExpressionVisibility ? (!autoHide || this.chatRevealedAssets.has(key)) : this.chatRevealedAssets.has(key));
    button.dataset.revealed = String(revealed);
    button.setAttribute('aria-label', (revealed ? button.dataset.openLabel : button.dataset.revealLabel)!);
  }

  private setChatImagePreviewSource(button: HTMLButtonElement, source: string): void {
    // Use one cover-fitted layer for concealment; the hidden foreground keeps
    // the original geometry for reveal. JSON string quoting is valid CSS string
    // syntax and keeps the object URL out of generated markup.
    button.style.setProperty('--chat-preview-source', `url(${JSON.stringify(source)})`);
  }

  private async ensureChatConcealedImage(manifest: ImageManifest, cached: CachedImage, image: HTMLImageElement): Promise<void> {
    if (cached.concealedUrl) return;
    if (cached.concealedPromise) return cached.concealedPromise;
    const session = this.session;
    const epoch = this.runtimeEpoch;
    const signal = this.runtimeAbort?.signal;
    if (!session || this.privacyCovered) return;
    cached.concealedPromise = (async () => {
      try {
        const blob = await createConcealedImage(image, signal);
        if (!this.isRuntimeActive(epoch, session) || this.imageCache.get(manifest.blobId) !== cached) return;
        cached.concealedUrl = URL.createObjectURL(blob);
        cached.bytes += blob.size;
        this.imageCacheBytes += blob.size;
      } finally { cached.concealedPromise = undefined; }
    })();
    return cached.concealedPromise;
  }

  private concealChatImages(): void {
    this.chatImageConcealGesture?.reset();
    this.chatRevealedAssets.clear();
    this.root.querySelectorAll<HTMLButtonElement>('#message-list .image-preview').forEach(button => {
      this.chatExplicitlyConcealedAssets.add(button.dataset.revealKey!);
      if (button.dataset.expression === 'true') this.chatConcealedExpressions.add(button.dataset.revealKey!);
      this.updateChatImageVisibility(button);
    });
  }

  private mountChatImageConcealGesture(list: HTMLElement): void {
    this.chatImageConcealGesture?.destroy();
    const session = this.session;
    const epoch = this.runtimeEpoch;
    this.chatImageConcealGesture = bindChatImageConcealGesture({
      list,
      active: () => Boolean(session && this.isRuntimeActive(epoch, session) && list.isConnected && this.activeSurface === 'chat'),
      canStart: () => document.documentElement.dataset.keyboardOpen !== 'true' && list.dataset.keyboardGesture !== 'true',
      conceal: () => this.concealChatImages(),
      moving: () => { this.cancelMessageHold(); this.cancelChatMessageMotion(); },
      suppressClick: () => { this.suppressMediaClickUntil = Date.now() + 650; },
    });
  }

  private createImagePreview(manifest: ImageManifest, album: ImageManifest[], index: number, clientMsgId: string, description = manifest.originalName || '聊天图片'): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    const video = isVideoFile(manifest);
    button.className = `image-preview${video ? ' video-preview' : ''}`;
    button.dataset.blobId = manifest.blobId;
    button.dataset.mediaMessageId = clientMsgId;
    button.dataset.revealKey = `${clientMsgId}:${manifest.blobId}`;
    button.dataset.imageState = 'pending';
    if (manifest.width && manifest.height) {
      button.dataset.mediaDimensions = 'known';
      button.style.setProperty('--chat-media-aspect', `${manifest.width} / ${manifest.height}`);
      button.style.setProperty('--chat-media-ratio', String(manifest.width / manifest.height));
      button.style.setProperty('--chat-media-source-width', `${manifest.width}px`);
      button.style.setProperty('--chat-expression-natural-width', `${manifest.width * 2 / 3}px`);
      button.style.setProperty('--chat-media-height-width', `${Math.min(window.innerHeight * .42, 320) * manifest.width / manifest.height}px`);
      button.style.setProperty('--chat-expression-height-width', `${Math.min(window.innerHeight * .28, 213.333) * manifest.width / manifest.height}px`);
    }
    button.dataset.openLabel = `${video ? '播放视频' : '放大查看'} ${description}`;
    button.dataset.revealLabel = `${video ? '显示视频预览' : '显示图片'} ${description}`;
    this.updateChatImageVisibility(button);
    button.setAttribute('aria-busy', 'true');
    this.mountChatImageLoadingFeedback(button, video);
    this.renderChatImageLoadFeedback(button, video, this.imageLoadStatus.get(manifest.blobId) ?? { stage: 'queued' });
    const cached = this.imageCache.get(manifest.blobId);
    if (cached) {
      this.assertImageManifestIdentity(manifest);
      cached.lastUsedAt = Date.now();
      if (cached.width && cached.height && cached.concealedUrl && (!video || cached.posterUrl)) {
        const image = document.createElement('img');
        image.src = cached.posterUrl ?? cached.url;
        image.alt = manifest.originalName || '聊天图片';
        image.draggable = false;
        image.width = cached.width;
        image.height = cached.height;
        this.setChatImagePreviewSource(button, cached.concealedUrl);
        button.replaceChildren(image);
        if (video) button.append(this.videoPlayBadge());
        button.dataset.imageState = 'loaded';
        button.setAttribute('aria-busy', 'false');
        delete button.dataset.loadStage;
        this.updateChatImageVisibility(button);
      } else queueMicrotask(() => { if (button.isConnected) void this.hydrateImagePreview(button, manifest); });
    }
    button.addEventListener('click', () => {
      if (Date.now() < this.suppressMediaClickUntil || !button.isConnected || !this.session || this.privacyCovered ||
          document.documentElement.classList.contains('privacy-obscured') || this.root.querySelector('.message-actions')) return;
      if (button.dataset.imageState === 'error') {
        void this.hydrateImagePreview(button, manifest);
        return;
      }
      if (button.dataset.imageState !== 'loaded') {
        // A pending thumbnail has no verified pixels to reveal yet. Treat a
        // tap as an explicit request to start/continue preparation, while the
        // visible status explains why the viewer cannot open immediately.
        if (button.dataset.imageState === 'pending') void this.hydrateImagePreview(button, manifest);
        return;
      }
      if (button.dataset.revealed !== 'true') {
        this.chatRevealedAssets.add(button.dataset.revealKey!);
        this.updateChatImageVisibility(button);
        this.markVisibleMessagesRead();
        return;
      }
      const assets = this.orderedMessages().flatMap(source => {
        if (isExpressionPayload(source.payload)) return [];
        const payload = source.payload;
        const media = payload.kind === 'image-album' ? payload.images
          : payload.kind === 'image' ? [payload.image]
          : payload.kind === 'file' && isVideoFile(payload.file) ? [payload.file] : [];
        return media.map((item, assetIndex) => ({ manifest: item, clientMsgId: source.clientMsgId, assetIndex, source }));
      });
      const currentIndex = assets.findIndex(asset => asset.clientMsgId === clientMsgId && asset.assetIndex === index);
      if (currentIndex < 0) {
        const source = this.orderedMessages().find(message => message.clientMsgId === clientMsgId);
        if (source && isExpressionPayload(source.payload)) this.openImageViewer(album, index, button, [],
          album.map((_, assetIndex) => ({ clientMsgId, assetIndex, source })));
        return;
      }
      this.openImageViewer(
        assets.map(asset => asset.manifest),
        currentIndex,
        button,
        assets.map(asset => asset.source.payload.sentAt),
        assets,
      );
    });
    return button;
  }

  private async renderImageIntoButton(button: HTMLButtonElement, manifest: ImageManifest, cached: CachedImage): Promise<void> {
    const ownerList = () => {
      const list = this.chatLayoutElements?.list;
      return this.activeSurface === 'chat' && list?.isConnected && list.contains(button) ? list : null;
    };
    const video = isVideoFile(manifest);
    this.updateChatImageLoadFeedback(manifest, 'decode');
    if (video) {
      await this.ensureVideoPoster(manifest, cached);
      if (!button.isConnected || this.privacyCovered) return;
      if (!cached.posterUrl) {
        button.style.removeProperty('--chat-preview-source');
        button.replaceChildren(this.videoPlayBadge());
        button.dataset.imageState = 'loaded';
        button.dataset.posterUnavailable = 'true';
        button.setAttribute('aria-busy', 'false');
        delete button.dataset.loadStage;
        this.updateChatImageVisibility(button);
        this.imageLoadStatus.delete(manifest.blobId);
        const list = ownerList();
        if (list) this.finishChatAnchorRestore(list);
        return;
      }
    }
    const image = document.createElement('img');
    image.src = cached.posterUrl ?? cached.url;
    image.alt = manifest.originalName || '聊天图片';
    image.draggable = false;
    // Resolve intrinsic dimensions before replacing the placeholder. Capture
    // the user's current anchor after decoding, as they may scroll meanwhile.
    await image.decode();
    if (!button.isConnected || this.privacyCovered) return;
    await this.ensureChatConcealedImage(manifest, cached, image);
    if (!button.isConnected || this.privacyCovered || !cached.concealedUrl || this.imageCache.get(manifest.blobId) !== cached) return;
    // Committing intrinsic media size during touch/inertia interrupts Safari's
    // scroll trajectory. Decode ahead, then settle geometry at the shared gate.
    const signal = this.runtimeAbort?.signal;
    while (ownerList() && this.chatViewportMotion?.moving && signal && !signal.aborted) {
      await this.abortableDelay(60, signal);
    }
    if (!button.isConnected || this.privacyCovered || signal?.aborted || this.imageCache.get(manifest.blobId) !== cached) return;
    cached.width = image.width = image.naturalWidth;
    cached.height = image.height = image.naturalHeight;
    if (button.dataset.expression === 'true') {
      image.style.width = `${image.naturalWidth * 2 / 3}px`;
    }
    const anchor = ownerList() ? this.captureChatAnchor() : null;
    this.setChatImagePreviewSource(button, cached.concealedUrl);
    button.replaceChildren(image);
    if (video) button.append(this.videoPlayBadge());
    button.dataset.imageState = 'loaded';
    button.setAttribute('aria-busy', 'false');
    delete button.dataset.loadStage;
    this.updateChatImageVisibility(button);
    this.imageLoadStatus.delete(manifest.blobId);
    const list = ownerList();
    if (list && anchor) this.restoreChatAnchor(list, anchor);
    if (list) this.finishChatAnchorRestore(list);
    this.markVisibleMessagesRead();
  }

  private async hydrateImagePreview(button: HTMLButtonElement, manifest: ImageManifest): Promise<void> {
    if (button.dataset.imageState === 'loading' || button.dataset.imageState === 'loaded') return;
    button.dataset.imageState = 'loading';
    button.setAttribute('aria-busy', 'true');
    if (!button.querySelector('.media-load-status')) this.mountChatImageLoadingFeedback(button, isVideoFile(manifest));
    this.renderChatImageLoadFeedback(button, isVideoFile(manifest), this.imageLoadStatus.get(manifest.blobId) ?? { stage: 'queued' });
    try {
      const cached = await this.loadImage(manifest);
      if (!button.isConnected || this.privacyCovered) return;
      await this.renderImageIntoButton(button, manifest, cached);
    } catch (cause) {
      if (!button.isConnected || cause instanceof DOMException && cause.name === 'AbortError') return;
      button.dataset.imageState = 'error';
      button.setAttribute('aria-busy', 'false');
      this.imageLoadStatus.delete(manifest.blobId);
      button.style.removeProperty('--chat-preview-source');
      const error = document.createElement('span');
      error.textContent = cause instanceof Error ? `${cause.message}，点按重试` : '载入失败，点按重试';
      button.replaceChildren(error);
      button.setAttribute('aria-label', error.textContent);
      const list = this.root.querySelector<HTMLElement>('#message-list');
      if (list) this.finishChatAnchorRestore(list);
    }
  }

  private mountChatImageObserver(list: HTMLElement): void {
    this.chatImageObserver?.disconnect();
    const pending = [...list.querySelectorAll<HTMLButtonElement>('.image-preview[data-image-state="pending"]')];
    const load = (button: HTMLButtonElement) => {
      const messageElement = button.closest<HTMLElement>('.message[data-client-msg-id]');
      const message = messageElement
        ? this.orderedMessages().find((item) => item.clientMsgId === messageElement.dataset.clientMsgId)
        : undefined;
      if (!message) return;
      let manifest: ImageManifest | undefined;
      if (message.payload.kind === 'image') manifest = message.payload.image;
      if (message.payload.kind === 'file' && isVideoFile(message.payload.file)) manifest = message.payload.file;
      if (message.payload.kind === 'image-album') {
        manifest = message.payload.images.find((item) => item.blobId === button.dataset.blobId);
      }
      if (manifest) void this.hydrateImagePreview(button, manifest);
    };
    // The saved row may be above the viewport while it is still a short
    // placeholder; explicitly load it so restoring cannot wait indefinitely.
    if (this.chatRestoreAnchor) {
      for (const button of pending) {
        if (button.closest<HTMLElement>('.message')?.dataset.clientMsgId === this.chatRestoreAnchor.clientMsgId) load(button);
      }
    }
    if (!('IntersectionObserver' in window)) {
      pending.forEach(load);
      return;
    }
    this.chatImageObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const button = entry.target as HTMLButtonElement;
        this.chatImageObserver?.unobserve(button);
        load(button);
      }
    }, { root: null, rootMargin: '75% 0px', threshold: 0.01 });
    pending.forEach((button) => this.chatImageObserver?.observe(button));
  }

  private async loadImage(manifest: ImageManifest): Promise<CachedImage> {
    this.assertImageManifestIdentity(manifest);
    const existing = this.imageCache.get(manifest.blobId);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    const inFlight = this.imageLoadPromises.get(manifest.blobId);
    if (inFlight) return inFlight;
    const session = this.session;
    if (!session || this.privacyCovered) throw new Error('会话已锁定');
    const epoch = this.runtimeEpoch;
    const signal = this.runtimeAbort?.signal;
    const { roomId, accessToken } = session.vault;
    const operation = this.withImageLoadSlot(async () => {
      signal?.throwIfAborted();
      const decrypt = isVideoFile(manifest) ? decryptFileAttachment : decryptImageFile;
      let usedPersistentCiphertext = false;
      const decryptWithCiphertextCache = (allowCache: boolean) => decrypt(
          manifest,
          async (blobId, chunkIndex) => {
            const expectedPlaintextBytes = Math.min(
              manifest.chunkSize,
              manifest.originalSize - chunkIndex * manifest.chunkSize,
            );
            if (allowCache) {
              const cachedChunk = await loadCachedMediaChunk(
                session, blobId, chunkIndex, expectedPlaintextBytes + 16,
              ).catch(() => null);
              signal?.throwIfAborted();
              if (cachedChunk) {
                usedPersistentCiphertext = true;
                this.updateChatImageLoadFeedback(manifest, 'decrypt', chunkIndex / manifest.chunkCount);
                return cachedChunk;
              }
            }
            this.updateChatImageLoadFeedback(manifest, 'download', chunkIndex / manifest.chunkCount);
            const chunk = await fetchBlobChunk(roomId, accessToken, blobId, chunkIndex, signal);
            signal?.throwIfAborted();
            // Cache only the already encrypted server chunk. A lock still
            // revokes every plaintext object URL and clears decoded media.
            await saveCachedMediaChunk(session, blobId, chunkIndex, chunk).catch(() => undefined);
            this.updateChatImageLoadFeedback(manifest, 'decrypt', chunkIndex / manifest.chunkCount);
            return chunk;
          },
          ratio => this.updateChatImageLoadFeedback(manifest, 'decrypt', ratio),
          signal,
        );
      let blob: Blob;
      try {
        blob = await decryptWithCiphertextCache(true);
      } catch (cause) {
        await deleteCachedMediaBlob(session, manifest.blobId).catch(() => undefined);
        if (!usedPersistentCiphertext) throw cause;
        signal?.throwIfAborted();
        // A partial, stale or externally corrupted local cache must not make a
        // valid server attachment permanently unreadable. Discard it and
        // perform one complete authenticated network reconstruction.
        try {
          blob = await decryptWithCiphertextCache(false);
        } catch (retryCause) {
          await deleteCachedMediaBlob(session, manifest.blobId).catch(() => undefined);
          throw retryCause;
        }
      }
      if (!this.isRuntimeActive(epoch, session)) throw new DOMException('Session locked', 'AbortError');
      this.cacheLocalImage(manifest, blob);
      const cached = this.imageCache.get(manifest.blobId);
      if (!cached) throw new Error('媒体缓存失败');
      return cached;
    }).finally(() => {
      if (this.imageLoadPromises.get(manifest.blobId) === operation) this.imageLoadPromises.delete(manifest.blobId);
    });
    this.imageLoadPromises.set(manifest.blobId, operation);
    return operation;
  }

  private renderChatImageLoadFeedback(
    button: HTMLButtonElement,
    video: boolean,
    status: { stage: 'queued' | 'download' | 'decrypt' | 'decode'; ratio?: number },
  ): void {
    if (button.dataset.imageState === 'loaded' || button.dataset.imageState === 'error') return;
    const kind = video ? '视频' : '图片';
    const percent = status.ratio === undefined ? undefined : Math.round(Math.max(0, Math.min(1, status.ratio)) * 100);
    const text = status.stage === 'queued' ? `等待加载${kind}`
      : status.stage === 'download' ? `正在下载${kind} ${percent}%`
        : status.stage === 'decrypt' ? `正在解密${kind} ${percent}%`
          : video ? '正在生成视频预览' : '正在生成模糊预览';
    button.dataset.loadStage = status.stage;
    button.querySelector<HTMLElement>('.media-load-status')!.textContent = text;
    const progress = button.querySelector<HTMLElement>('.media-load-progress')!;
    if (percent === undefined || status.stage === 'decode') {
      progress.removeAttribute('aria-valuenow');
      progress.dataset.indeterminate = 'true';
    } else {
      progress.setAttribute('aria-valuenow', String(percent));
      delete progress.dataset.indeterminate;
      progress.style.setProperty('--media-load-progress', `${percent}%`);
    }
    button.setAttribute('aria-label', `${text}，点按继续准备`);
  }

  private mountChatImageLoadingFeedback(button: HTMLButtonElement, video: boolean): void {
    button.innerHTML = `${video ? icons.video : icons.image}<span class="media-load-status" role="status" aria-live="polite"></span><span class="media-load-progress" role="progressbar" aria-label="媒体准备进度" aria-valuemin="0" aria-valuemax="100"><i></i></span>`;
  }

  private updateChatImageLoadFeedback(
    manifest: ImageManifest,
    stage: 'queued' | 'download' | 'decrypt' | 'decode',
    ratio?: number,
  ): void {
    const status = { stage, ...(ratio === undefined ? {} : { ratio }) };
    this.imageLoadStatus.set(manifest.blobId, status);
    const selector = `.image-preview[data-blob-id="${CSS.escape(manifest.blobId)}"]`;
    for (const button of this.root.querySelectorAll<HTMLButtonElement>(selector)) {
      this.renderChatImageLoadFeedback(button, isVideoFile(manifest), status);
    }
  }

  private openImageViewer(
    manifests: ImageManifest[],
    startIndex = 0,
    returnFocus?: HTMLElement,
    sentAt: readonly string[] = [],
    identities: readonly { clientMsgId: string; assetIndex: number; source?: DecryptedMessage }[] = [],
    showDetailsOnOpen = false,
  ): void {
    if (manifests.length === 0 || !this.session || this.privacyCovered) return;
    this.closeImageViewer(true);
    const favoriteViewer = this.galleryMode === 'favorites' && Boolean(this.root.querySelector('.gallery-shell'));
    const allowPhotoDetails = !favoriteViewer && this.session.vault.role === 'creator' && this.activeSurface === 'away'
      && Boolean(this.root.querySelector('.gallery-shell'));
    const workAbort = new AbortController();
    this.viewerProjectionSources = [...new Map(identities.flatMap(identity => identity.source
      ? [[identity.source.seq, identity.source] as const] : [])).values()];
    this.voicePlayback.stop();
    this.closeMessageActions();
    this.viewerPreviousSurface = this.activeSurface;
    if (!this.setActiveSurface('away')) return;
    this.viewerWorkAbort = workAbort;
    this.viewerReturnFocus = returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const viewer = document.createElement('section');
    if (allowPhotoDetails) viewer.dataset.safeViewer = '';
    viewer.className = 'image-viewer';
    viewer.setAttribute('role', 'dialog');
    viewer.setAttribute('aria-modal', 'true');
    viewer.setAttribute('aria-label', '图片查看器');
    viewer.dataset.viewerClientMsgIds = JSON.stringify([...new Set(identities.map(identity => identity.clientMsgId))]);
    viewer.innerHTML = `
      <header class="viewer-header">
        <button class="viewer-control" type="button" data-viewer-close aria-label="关闭查看器">${icons.close}</button>
        <div><strong data-viewer-name></strong><div class="viewer-metadata"><span data-viewer-counter></span><time data-viewer-time title="发送或上传时间" hidden></time></div></div>
        ${allowPhotoDetails
          ? '<button class="viewer-control" type="button" data-viewer-details aria-label="查看图片详情" title="查看图片详情" aria-expanded="false" hidden></button>'
          : !favoriteViewer && identities.some(identity => identity.source && this.messageFavoriteTargets(identity.source).length)
            ? `<button class="viewer-control" type="button" data-viewer-favorite aria-label="收藏当前附件">${memeIcons.star}</button>` : '<span></span>'}
      </header>
      <div class="viewer-photo-tools">
        <button class="viewer-motion-toggle" type="button" data-viewer-motion aria-pressed="true" hidden></button>
        <span class="viewer-motion-error" role="status" hidden></span>
      </div>
      <p class="notice viewer-notice" role="status" data-viewer-notice hidden></p>
      <div class="viewer-stage" aria-live="polite"></div>
      <button class="viewer-nav viewer-previous" type="button" aria-label="上一张">${icons.back}</button>
      <button class="viewer-nav viewer-next" type="button" aria-label="下一张">${icons.back}</button>
    `;
    this.root.append(viewer);
    let current = Math.max(0, Math.min(startIndex, manifests.length - 1));
    let renderToken = 0;
    let transitionActive = false;
    const stage = viewer.querySelector<HTMLElement>('.viewer-stage')!;
    const previous = viewer.querySelector<HTMLButtonElement>('.viewer-previous')!;
    const next = viewer.querySelector<HTMLButtonElement>('.viewer-next')!;
    let activeLayer: HTMLElement | null = null;
    let activeMotion: ImageMotion | null = null;
    const motionButton = viewer.querySelector<HTMLButtonElement>('[data-viewer-motion]')!;
    const detailsButton = viewer.querySelector<HTMLButtonElement>('[data-viewer-details]');
    detailsButton?.append(createElement(Info));
    const closeDetails = (focus = true, animate = true) => {
      this.viewerDetailsCleanup?.(animate);
      this.viewerDetailsCleanup = null;
      detailsButton?.setAttribute('aria-expanded', 'false');
      if (focus) detailsButton?.focus({ preventScroll: true });
    };
    const openDetails = () => {
      if (!allowPhotoDetails || this.privacyCovered || workAbort.signal.aborted || isVideoFile(manifests[current]!)) return;
      closeDetails(false, false);
      gestures.reset();
      detailsButton?.setAttribute('aria-expanded', 'true');
      const manifest = manifests[current]!;
      this.viewerDetailsCleanup = mountPhotoDetails(viewer, {
        manifest, sentAt: sentAt[current], signal: workAbort.signal,
        load: () => this.loadImage(manifest), close: () => closeDetails(),
      });
    };
    detailsButton?.addEventListener('click', () => {
      if (this.viewerDetailsCleanup) closeDetails();
      else openDetails();
    });
    const updateMotionButton = () => {
      motionButton.hidden = !activeMotion;
      if (!activeMotion) return;
      const playing = activeMotion.playing();
      motionButton.setAttribute('aria-pressed', String(playing));
      motionButton.setAttribute('aria-label', playing ? '关闭动态播放' : '开启动图播放');
      motionButton.title = playing ? '关闭动态播放' : '开启动图播放';
      const label = document.createElement('span');
      label.textContent = playing ? '动态开启' : '动态关闭';
      motionButton.replaceChildren(createElement(playing ? Pause : Play), label);
    };
    motionButton.addEventListener('click', () => {
      if (!activeMotion || workAbort.signal.aborted || transitionActive) return;
      if (activeMotion.playing()) activeMotion.pause(); else activeMotion.resume();
      updateMotionButton();
    });
    const gestures = bindImageViewerGestures({
      stage, viewer, itemCount: manifests.length,
      media: () => activeLayer?.querySelector<HTMLImageElement | HTMLVideoElement>('img, video') ?? null,
      zoomTarget: () => activeLayer?.classList.contains('is-image')
        ? activeLayer.querySelector<HTMLImageElement>('img')
        : null,
      dismiss: downward => {
        if (downward && this.viewerPreviousSurface === 'chat') this.concealChatImages();
        this.closeImageViewer(false, true);
      },
      page: (direction, gesture?: { offsetX: number; stageWidth: number }) => {
        if (!transitionActive && !viewer.dataset.nativeVideo) {
          void render(current + direction, { direction, gesture, reason: 'page' });
        }
      },
    });
    this.viewerGestureCleanup = gestures.destroy;
    const updateMetadata = (index: number) => {
      const manifest = manifests[index]!;
      const identity = identities[index];
      const video = isVideoFile(manifest);
      const favoriteButton = viewer.querySelector<HTMLButtonElement>('[data-viewer-favorite]');
      if (favoriteButton) {
        const target = identity?.source && this.messageFavoriteTargets(identity.source).find(item => item.assetIndex === identity.assetIndex);
        const saved = Boolean(target && this.attachmentFavorite(target));
        favoriteButton.hidden = !target;
        favoriteButton.setAttribute('aria-pressed', String(saved));
        favoriteButton.setAttribute('aria-label', saved ? '取消收藏当前附件' : '收藏当前附件');
        favoriteButton.title = saved ? '取消收藏' : '收藏';
      }
      viewer.classList.toggle('video-viewer', video);
      viewer.setAttribute('aria-label', video ? '视频播放器' : '图片查看器');
      viewer.querySelector<HTMLElement>('[data-viewer-name]')!.textContent = manifest.originalName || (video ? '视频' : '原图');
      const available = manifests.map((_, candidate) => candidate)
        .filter(candidate => !identities[candidate] || !this.messageDeletions().has(identities[candidate]!.clientMsgId));
      const position = available.indexOf(index);
      viewer.querySelector<HTMLElement>('[data-viewer-counter]')!.textContent = available.length > 1
        ? `${Math.max(position, 0) + 1} / ${available.length}` : this.fileSize(manifest.originalSize);
      const time = viewer.querySelector<HTMLTimeElement>('[data-viewer-time]')!;
      const timestamp = sentAt[index];
      const date = timestamp ? new Date(timestamp) : null;
      const validDate = date && Number.isFinite(date.getTime());
      time.hidden = !validDate;
      time.dateTime = validDate ? timestamp! : '';
      time.textContent = validDate ? new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(date) : '';
      time.setAttribute('aria-label', validDate ? `发送或上传时间 ${time.textContent}` : '');
      stage.dataset.blobId = manifest.blobId;
      if (identity) {
        viewer.dataset.viewerClientMsgId = identity.clientMsgId;
        viewer.dataset.viewerAssetIndex = String(identity.assetIndex);
      } else {
        delete viewer.dataset.viewerClientMsgId;
        delete viewer.dataset.viewerAssetIndex;
      }
    };
    const finishTransitionState = () => {
      transitionActive = false;
      viewer.classList.remove('is-transitioning');
      previous.disabled = false;
      next.disabled = false;
      stage.setAttribute('aria-busy', 'false');
      motionButton.disabled = false;
      if (detailsButton) { detailsButton.disabled = false; detailsButton.hidden = isVideoFile(manifests[current]!); }
      updateMotionButton();
    };
    const render = async (
      index: number,
      options: {
        direction?: number;
        gesture?: { offsetX: number; stageWidth: number };
        reason?: 'initial' | 'page' | 'control' | 'retry';
      } = {},
    ) => {
      if (transitionActive || viewer.dataset.nativeVideo) return;
      let target = (index + manifests.length) % manifests.length;
      const directionHint = Math.sign(options.direction ?? (target === current ? 1 : target > current ? 1 : -1)) || 1;
      // A tombstoned non-current page must not become visible from an already
      // mounted viewer. Walk to the next still-projected item; the queue path
      // below closes immediately when the current item itself is deleted.
      for (let checked = 0; checked < manifests.length; checked++) {
        const identity = identities[target];
        if (!identity || !this.messageDeletions().has(identity.clientMsgId)) break;
        target = (target + directionHint + manifests.length) % manifests.length;
      }
      if (identities[target] && this.messageDeletions().has(identities[target]!.clientMsgId)) {
        this.closeImageViewer(true);
        return;
      }
      if (activeLayer && target === current && options.reason !== 'retry') return;
      closeDetails(false, false);
      activeMotion?.pause();
      motionButton.disabled = true;
      if (detailsButton) detailsButton.disabled = true;
      viewer.querySelector<HTMLElement>('.viewer-motion-error')!.hidden = true;
      transitionActive = true;
      viewer.classList.add('is-transitioning');
      previous.disabled = true;
      next.disabled = true;
      stage.setAttribute('aria-busy', 'true');
      const token = ++renderToken;
      const manifest = manifests[target]!;
      const video = isVideoFile(manifest);
      const availableCount = manifests.filter((_, candidate) =>
        !identities[candidate] || !this.messageDeletions().has(identities[candidate]!.clientMsgId)).length;
      previous.hidden = availableCount < 2;
      next.hidden = availableCount < 2;
      let incomingLayer: HTMLElement | null = null;
      let incomingCleanup: (() => void) | null = null;
      let outgoingLayer: HTMLElement | null = null;
      let outgoingCleanup: (() => void) | null = null;
      let incomingMotion: ImageMotion | null = null;
      try {
        outgoingLayer = activeLayer;
        outgoingCleanup = this.viewerMediaCleanup;
        this.assertImageManifestIdentity(manifest);
        const cached = this.imageCache.get(manifest.blobId);
        // Accepting a page change pauses the current page immediately. A slow
        // download/decrypt/decode must never leave the previous video's audio
        // playing behind a stationary transition frame.
        if (outgoingLayer) {
          outgoingLayer.inert = true;
          outgoingLayer.setAttribute('aria-hidden', 'true');
          outgoingLayer.querySelectorAll('video').forEach(item => item.pause());
        }
        if (!cached && !activeLayer) {
          updateMetadata(target);
          const loading = document.createElement('p');
          loading.className = 'viewer-loading';
          loading.setAttribute('role', 'status');
          loading.innerHTML = `${video ? icons.video : icons.image}<span class="sr-only">正在加载${video ? '视频' : '图片'}</span>`;
          stage.replaceChildren(loading);
        }
        const loaded = cached ?? await this.loadImage(manifest);
        if (!viewer.isConnected || viewer.classList.contains('is-closing') || token !== renderToken) {
          finishTransitionState();
          return;
        }
        const direction = directionHint;
        const width = Math.max(options.gesture?.stageWidth ?? stage.clientWidth, 1);
        const offset = Math.max(-width, Math.min(width, options.gesture?.offsetX ?? 0));
        const layer = document.createElement('div');
        incomingLayer = layer;
        layer.className = `viewer-media-layer${video ? ' is-video' : ' is-image'}`;
        layer.dataset.viewerIndex = String(target);
        if (outgoingLayer) {
          layer.inert = true;
          layer.setAttribute('aria-hidden', 'true');
          layer.style.transform = `translate3d(${offset + direction * width}px, 0, 0)`;
          layer.style.opacity = '0.88';
        }
        if (video) {
          // The native-player request must run while the video is connected so
          // cached direct opens retain the original trusted activation stack.
          if (outgoingLayer) stage.append(layer);
          else stage.replaceChildren(layer);
          const rendered = this.renderViewerVideo(layer, loaded, manifest, {
            autoplay: !outgoingLayer,
            requestNative: !outgoingLayer,
          });
          incomingCleanup = rendered.cleanup;
        } else {
          const image = document.createElement('img');
          image.src = loaded.url;
          image.alt = manifest.originalName || `第 ${target + 1} 张图片`;
          image.draggable = false;
          layer.replaceChildren(image);
          // Byte verification and object-URL creation do not guarantee that a
          // frame is decoded. Keep the incoming layer offscreen until decode
          // completes so it cannot pop in halfway through the page animation.
          await image.decode();
          if (!workAbort.signal.aborted) {
            try {
              incomingMotion = await prepareImageMotion(image, loaded.blob, workAbort.signal);
              if (incomingMotion) incomingCleanup = incomingMotion.destroy;
            } catch {
              if (!workAbort.signal.aborted) {
                const error = viewer.querySelector<HTMLElement>('.viewer-motion-error')!;
                error.textContent = '动态开关暂不可用';
                error.hidden = false;
              }
            }
          }
          if (!viewer.isConnected || viewer.classList.contains('is-closing') || token !== renderToken) {
            incomingCleanup?.();
            finishTransitionState();
            return;
          }
          if (outgoingLayer) stage.append(layer);
          else stage.replaceChildren(layer);
        }
        if (!outgoingLayer) {
          activeLayer = layer;
          activeMotion = incomingMotion;
          current = target;
          this.viewerMediaCleanup = incomingCleanup;
          updateMetadata(current);
          gestures.reset();
          if (!reducedMotion) layer.animate([
            { opacity: 0.72 },
            { opacity: 1 },
          ], { duration: 260, easing: 'cubic-bezier(.16, 1, .3, 1)' });
        } else {
          outgoingLayer.inert = true;
          outgoingLayer.setAttribute('aria-hidden', 'true');
          // Transfer the finger's residual offset from the child media to its
          // page layer before reset() flushes styles. Reversing this order lets
          // WebKit paint one centered frame between the drag and page motion.
          outgoingLayer.style.transform = `translate3d(${offset}px, 0, 0)`;
          outgoingLayer.style.opacity = '1';
          gestures.reset();
          this.viewerMediaCleanup = () => { outgoingCleanup?.(); incomingCleanup?.(); };
          if (!reducedMotion) {
            const timing: KeyframeAnimationOptions = {
              duration: 380,
              easing: 'cubic-bezier(.22, .76, .18, 1)',
              fill: 'forwards',
            };
            const outgoingAnimation = outgoingLayer.animate([
              { transform: `translate3d(${offset}px, 0, 0)`, opacity: 1 },
              { transform: `translate3d(${-direction * width}px, 0, 0)`, opacity: 0.92 },
            ], timing);
            const incomingAnimation = layer.animate([
              { transform: `translate3d(${offset + direction * width}px, 0, 0)`, opacity: 0.88 },
              { transform: 'translate3d(0, 0, 0)', opacity: 1 },
            ], timing);
            await Promise.allSettled([outgoingAnimation.finished, incomingAnimation.finished]);
          }
          if (!viewer.isConnected || viewer.classList.contains('is-closing') || token !== renderToken) return;
          outgoingCleanup?.();
          outgoingLayer.remove();
          layer.style.removeProperty('transform');
          layer.style.removeProperty('opacity');
          layer.inert = false;
          layer.removeAttribute('aria-hidden');
          activeLayer = layer;
          activeMotion = incomingMotion;
          current = target;
          this.viewerMediaCleanup = incomingCleanup;
          updateMetadata(current);
          gestures.reset();
        }
        const adjacent = manifests[(current + 1) % manifests.length];
        const preceding = manifests[(current - 1 + manifests.length) % manifests.length];
        if (!(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) {
          for (const neighbor of [adjacent, preceding]) {
            if (neighbor && neighbor !== manifest) void this.loadImage(neighbor).catch(() => undefined);
          }
        }
        finishTransitionState();
        if (showDetailsOnOpen) { showDetailsOnOpen = false; openDetails(); }
      } catch (cause) {
        if (!viewer.isConnected || workAbort.signal.aborted || viewer.classList.contains('is-closing') || token !== renderToken) {
          incomingCleanup?.();
          return;
        }
        gestures.reset();
        if (activeLayer) {
          incomingCleanup?.();
          if (incomingLayer && incomingLayer !== activeLayer) incomingLayer.remove();
          this.viewerMediaCleanup = outgoingCleanup;
          activeLayer.style.removeProperty('transform');
          activeLayer.style.removeProperty('opacity');
          activeLayer.inert = false;
          activeLayer.removeAttribute('aria-hidden');
          this.showNotice(cause instanceof Error ? `${cause.message}，请重试` : '媒体载入失败，请重试', 'error');
          finishTransitionState();
          return;
        }
        incomingCleanup?.();
        this.viewerMediaCleanup = null;
        const error = document.createElement('button');
        error.type = 'button';
        error.className = 'viewer-error';
        error.textContent = cause instanceof Error ? `${cause.message}，点按重试` : '原图载入失败，点按重试';
        error.addEventListener('click', () => void render(target, { reason: 'retry' }));
        stage.replaceChildren(error);
        finishTransitionState();
        if (showDetailsOnOpen) { showDetailsOnOpen = false; openDetails(); }
      }
    };
    previous.addEventListener('click', () => void render(current - 1, { direction: -1, reason: 'control' }));
    next.addEventListener('click', () => void render(current + 1, { direction: 1, reason: 'control' }));
    viewer.querySelector<HTMLButtonElement>('[data-viewer-favorite]')?.addEventListener('click', async event => {
      if (transitionActive || workAbort.signal.aborted) return;
      const button = event.currentTarget as HTMLButtonElement;
      if (button.disabled) return;
      button.disabled = true;
      const identity = identities[current];
      if (identity?.source) await this.toggleMessageFavorite(identity.source, identity.assetIndex);
      if (!workAbort.signal.aborted && viewer.isConnected) {
        button.disabled = false;
        updateMetadata(current);
      }
    });
    viewer.querySelector('[data-viewer-close]')?.addEventListener('click', () => this.closeImageViewer());
    stage.addEventListener('contextmenu', (event) => event.preventDefault());
    this.viewerKeyHandler = (event: KeyboardEvent) => {
      if (!viewer.isConnected || viewer.classList.contains('is-closing')) return;
      if (event.key === 'ArrowLeft' && !viewer.dataset.nativeVideo && !(event.target instanceof HTMLVideoElement) && manifests.length > 1) {
        event.preventDefault();
        void render(current - 1, { direction: -1, reason: 'control' });
      }
      if (event.key === 'ArrowRight' && !viewer.dataset.nativeVideo && !(event.target instanceof HTMLVideoElement) && manifests.length > 1) {
        event.preventDefault();
        void render(current + 1, { direction: 1, reason: 'control' });
      }
      if (event.key === 'Tab') {
        const buttons = [...viewer.querySelectorAll<HTMLElement>('button:not([hidden]):not(:disabled), video[controls], .photo-details-content')]
          .filter(element => element.tabIndex >= 0 && element.getClientRects().length > 0 && !element.closest('[inert], [aria-hidden="true"]'));
        const first = buttons[0];
        const last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', this.viewerKeyHandler);
    requestAnimationFrame(() => { if (viewer.isConnected) viewer.classList.add('is-visible'); });
    viewer.querySelector<HTMLButtonElement>('[data-viewer-close]')?.focus({ preventScroll: true });
    void render(current, { reason: 'initial' });
  }

  private closeDocumentReader(immediate = false): void {
    const reader = this.documentReader;
    if (!reader) return;
    this.documentReader = null;
    reader.view.destroy();
    if (!immediate && !this.privacyCovered && this.session) {
      this.setActiveSurface(reader.previous);
      if (reader.returnFocus.isConnected) reader.returnFocus.focus({ preventScroll: true });
      if (reader.previous === 'away' && this.galleryRefreshPending) {
        const tab = this.galleryRefreshPending;
        this.galleryRefreshPending = null;
        this.renderGallery(tab);
      } else if (reader.previous === 'away') this.mountGalleryViewport();
    }
  }

  private closeImageViewer(immediate = false, dragged = false): void {
    this.closeDocumentReader(immediate);
    const viewer = this.root.querySelector<HTMLElement>('.image-viewer');
    const departingImage = dragged ? viewer?.querySelector<HTMLImageElement>('.viewer-stage img') : null;
    const departingTransform = departingImage?.style.transform;
    if (this.viewerKeyHandler) document.removeEventListener('keydown', this.viewerKeyHandler);
    this.viewerKeyHandler = null;
    this.viewerGestureCleanup?.();
    this.viewerGestureCleanup = null;
    this.viewerWorkAbort?.abort();
    this.viewerWorkAbort = null;
    this.viewerDetailsCleanup?.();
    this.viewerDetailsCleanup = null;
    if (!viewer || (!immediate && viewer.classList.contains('is-closing'))) return;
    this.viewerProjectionSources = [];
    this.stopViewerMedia();
    const previousSurface = this.viewerPreviousSurface;
    const returnFocus = this.viewerReturnFocus;
    this.viewerReturnFocus = null;
    const finish = () => {
      if (!viewer.isConnected) return;
      viewer.remove();
      if (this.privacyCovered || this.root.querySelector('.image-viewer')) return;
      if (!this.setActiveSurface(previousSurface)) return;
      if (previousSurface === 'away' && this.galleryRefreshPending) {
        const pendingTab = this.galleryRefreshPending;
        this.galleryRefreshPending = null;
        this.renderGallery(pendingTab);
        this.root.querySelector<HTMLElement>('#gallery-grid')?.focus({ preventScroll: true });
      } else {
        if (previousSurface === 'away') this.mountGalleryViewport();
        if (!immediate && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
      }
    };
    if (immediate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      finish();
      return;
    }
    viewer.classList.remove('is-visible', 'is-dragging');
    viewer.classList.add('is-closing');
    if (departingImage && departingTransform) {
      departingImage.style.transform = departingTransform;
      departingImage.animate([
        { transform: departingTransform },
        { transform: `translate3d(0, ${viewer.clientHeight}px, 0) scale(.35)` },
      ], { duration: 220, easing: 'cubic-bezier(.2,.65,.3,1)', fill: 'forwards' });
    }
    window.setTimeout(finish, 220);
  }

  private closeViewerIfProjectionDeleted(): boolean {
    if (this.documentReader?.source && this.messageDeletions([this.documentReader.source]).has(this.documentReader.source.clientMsgId)) {
      this.closeDocumentReader();
      return true;
    }
    const viewer = this.root.querySelector<HTMLElement>('.image-viewer');
    if (!viewer) return false;
    let clientMsgIds: string[] = [];
    try {
      const parsed = JSON.parse(viewer.dataset.viewerClientMsgIds ?? '[]') as unknown;
      if (Array.isArray(parsed)) clientMsgIds = parsed.filter((value): value is string => typeof value === 'string');
    } catch {
      // A malformed DOM-only identity cannot authorize continued disclosure.
      this.closeImageViewer(true);
      return true;
    }
    const deleted = this.messageDeletions(this.viewerProjectionSources);
    if (!clientMsgIds.some(clientMsgId => deleted.has(clientMsgId))) return false;
    this.closeImageViewer(true);
    return true;
  }

  private mountGalleryViewport(): void {
    if (this.privacyCovered || this.activeSurface !== 'away') return;
    // Cache once per mount/return. The shared sampler never queries the grid
    // or measures its contents, even when WebKit withholds viewport events.
    this.galleryViewportHeader = this.root.querySelector<HTMLElement>('.gallery-header');
    if (!this.galleryViewportHeader) return;
    this.syncViewport();
    this.trackChatViewport();
  }

  private galleryCurationRecord(target: GalleryCurationTarget): GalleryCurationRecord | undefined {
    if (this.galleryMode === 'favorites') {
      const favorite = this.attachmentFavorite(target);
      return favorite ? { v: 1, ...target, hidden: false, pinnedAt: favorite.pinnedAt } : undefined;
    }
    const key = galleryCurationKey(target);
    return (this.uiPreferences.galleryCuration ?? []).find(record => galleryCurationKey(record) === key);
  }

  private attachmentFavorite(target: GalleryCurationTarget) {
    const key = galleryCurationKey(target);
    return this.uiPreferences.attachmentFavorites?.find(record => galleryCurationKey(record) === key);
  }

  private messageFavoriteTargets(message: DecryptedMessage): GalleryCurationTarget[] {
    if (this.messageIsUnavailable(message.clientMsgId)) return [];
    const payload = message.payload;
    const count = payload.kind === 'image-album' ? payload.images.length : payload.kind === 'image' || payload.kind === 'file' ? 1 : 0;
    const targets: GalleryCurationTarget[] = Array.from({ length: count }, (_, assetIndex) => ({ clientMsgId: message.clientMsgId, assetIndex,
      category: payload.kind === 'file' && !isVideoFile(payload.file) ? 'files' : 'images' }));
    // Unsupported older identities must not break the rest of the message menu.
    try { targets.forEach(galleryCurationKey); return targets; }
    catch { return []; }
  }

  private async saveAttachmentFavorites(records: NonNullable<UiPreferences['attachmentFavorites']>): Promise<void> {
    if (!this.session || !this.uiPreferencesHydrated || this.privacyCovered) throw new Error('本机收藏尚未就绪');
    const next = normalizeAttachmentFavorites(records);
    const previous = this.uiPreferences.attachmentFavorites;
    this.uiPreferences.attachmentFavorites = next;
    try { await this.saveUiPreferencesNow(); }
    catch (cause) {
      if (this.uiPreferences.attachmentFavorites === next) this.uiPreferences.attachmentFavorites = previous;
      throw cause;
    }
  }

  private async toggleMessageFavorite(message: DecryptedMessage, assetIndex?: number): Promise<void> {
    const session = this.session; const epoch = this.runtimeEpoch;
    if (!session || this.privacyCovered) return;
    const targets = this.messageFavoriteTargets(message).filter(target => assetIndex === undefined || target.assetIndex === assetIndex);
    if (!targets.length) return;
    const remove = targets.every(target => this.attachmentFavorite(target));
    const keys = new Set(targets.map(galleryCurationKey));
    const previous = this.uiPreferences.attachmentFavorites ?? [];
    const next = remove ? previous.filter(record => !keys.has(galleryCurationKey(record)))
      : [...previous, ...targets.filter(target => !this.attachmentFavorite(target)).map(target => ({ ...target, savedAt: Date.now(), pinnedAt: null }))];
    this.closeMessageActions(false, false);
    try {
      await this.saveAttachmentFavorites(next);
      if (this.isRuntimeActive(epoch, session)) this.showNotice(remove ? '已取消收藏' : '已收藏');
    } catch (cause) { if (this.isRuntimeActive(epoch, session)) this.operationalError(cause, '收藏未能保存'); }
  }

  private async updateGalleryCuration(target: GalleryCurationTarget, action: 'pin' | 'unpin' | 'hide'): Promise<void> {
    if (this.galleryMode === 'favorites') {
      const key = galleryCurationKey(target);
      const previous = this.uiPreferences.attachmentFavorites ?? [];
      await this.saveAttachmentFavorites(previous.flatMap(record => galleryCurationKey(record) !== key ? [record]
        : action === 'hide' ? [] : [{ ...record, pinnedAt: action === 'pin' ? Date.now() : null }]));
      return;
    }
    const key = galleryCurationKey(target);
    const previous = this.uiPreferences.galleryCuration;
    const records = (previous ?? []).filter(record => galleryCurationKey(record) !== key);
    if (action === 'pin') records.push({ v: 1, ...target, hidden: false, pinnedAt: Date.now() });
    else if (action === 'hide') records.push({ v: 1, ...target, hidden: true, pinnedAt: null });
    const next = normalizeGalleryCurationRecords(records);
    this.uiPreferences.galleryCuration = next;
    try {
      // A destructive-looking Safe action must be durable before its sheet
      // closes. Background debounce errors are intentionally non-blocking for
      // scroll anchors, but silently losing a pin/delete would be misleading.
      await this.saveUiPreferencesNow();
    } catch (cause) {
      if (this.uiPreferences.galleryCuration === next) this.uiPreferences.galleryCuration = previous;
      throw cause;
    }
  }

  private mountGalleryCurationActions(source: HTMLElement, target: GalleryCurationTarget, tab: GalleryTab, countKey: string,
    openDetails?: () => void, onSaved?: (action: 'pin' | 'unpin' | 'hide') => boolean): void {
    let start: { x: number; y: number; pointerId: number } | null = null;
    const cancel = () => { this.cancelMessageHold(); start = null; };
    const release = () => {
      cancel();
      // Keep the committed latch until the synthesized click consumes it. If a
      // browser emits no click after the hold, the next distinct pointerdown
      // clears it so the following intentional tap still works.
    };
    const open = (fromPointerHold = false) => {
      if (this.root.querySelector('.image-viewer') || !source.isConnected) return;
      this.suppressMediaClickUntil = Date.now() + 650;
      if (fromPointerHold) source.dataset.galleryHoldCommitted = 'true';
      navigator.vibrate?.(18);
      this.openGalleryCurationActions(source, target, tab, countKey, openDetails, onSaved);
    };
    source.addEventListener('pointerdown', event => {
      if (!event.isPrimary || event.button !== 0 || event.pointerType === 'mouse' || this.privacyCovered) return;
      delete source.dataset.galleryHoldCommitted;
      cancel();
      start = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
      this.messageHoldTimer = window.setTimeout(() => {
        this.messageHoldTimer = null;
        if (!start || start.pointerId !== event.pointerId || !source.isConnected) return;
        open(true);
      }, 500);
    });
    source.addEventListener('pointermove', event => {
      if (start && start.pointerId === event.pointerId && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) cancel();
    });
    for (const eventName of ['pointerup', 'pointercancel', 'pointerleave'] as const) source.addEventListener(eventName, release);
    source.addEventListener('contextmenu', event => {
      event.preventDefault();
      cancel();
      if (source.dataset.galleryHoldCommitted === 'true') return;
      open();
    });
    source.addEventListener('keydown', event => {
      if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
        event.preventDefault();
        cancel();
        open();
      }
    });
  }

  private openGalleryCurationActions(source: HTMLElement, target: GalleryCurationTarget, tab: GalleryTab, countKey: string,
    openDetails?: () => void, onSaved?: (action: 'pin' | 'unpin' | 'hide') => boolean): void {
    const session = this.session;
    const epoch = this.runtimeEpoch;
    if (!session || !this.isRuntimeActive(epoch, session) || !source.isConnected) return;
    const existing = this.root.querySelector<HTMLElement>('.gallery-actions-sheet');
    if (existing) closeDialog(existing, { animate: false, restoreFocus: false });
    const pinned = this.galleryCurationRecord(target)?.pinnedAt != null;
    const sheet = document.createElement('section');
    sheet.className = 'gallery-actions-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', target.category === 'images' ? '照片或视频操作' : '文件操作');
    sheet.innerHTML = `<div class="gallery-actions-menu" role="menu">
      ${openDetails ? '<button type="button" role="menuitem" data-gallery-action="details"><span>查看详情</span></button>' : ''}
      <button type="button" role="menuitem" data-gallery-action="pin">${icons.pin}<span>${pinned ? '取消置顶' : '置顶'}</span></button>
      <button type="button" role="menuitem" data-gallery-action="delete" ${this.galleryMode === 'safe' ? 'data-danger="true"' : ''}>${this.galleryMode === 'favorites' ? memeIcons.star : icons.trash}<span>${this.galleryMode === 'favorites' ? '取消收藏' : '删除'}</span></button>
    </div>`;
    this.root.append(sheet);
    const dialog = mountDialog(sheet, {
      isActive: () => this.isRuntimeActive(epoch, session),
      signal: this.runtimeAbort?.signal,
      returnFocus: source,
      initialFocus: sheet.querySelector<HTMLButtonElement>('[data-gallery-action="pin"]'),
    });
    const details = sheet.querySelector<HTMLButtonElement>('[data-gallery-action="details"]');
    details?.prepend(createElement(Info));
    // Keep Safari's compatibility focus on the menu until the connected
    // viewer takes it; a delayed activation must not replace that viewer.
    details?.addEventListener('pointerdown', event => {
      if (event.isPrimary && event.button === 0) event.preventDefault();
    });
    let openingDetails = false;
    details?.addEventListener('click', () => {
      if (openingDetails || !sheet.isConnected || !openDetails || !this.isRuntimeActive(epoch, session) || session.vault.role !== 'creator') return;
      openingDetails = true;
      openDetails();
      // Transfer focus to the connected viewer before removing the focused menu.
      dialog.close({ animate: false, restoreFocus: false });
    });
    let saving = false;
    const finish = async (action: 'pin' | 'unpin' | 'hide') => {
      if (saving) return;
      saving = true;
      for (const button of sheet.querySelectorAll<HTMLButtonElement>('button')) button.disabled = true;
      sheet.setAttribute('aria-busy', 'true');
      this.galleryScrollTop[tab] = this.root.querySelector<HTMLElement>('#gallery-grid')?.scrollTop ?? 0;
      try {
        await this.updateGalleryCuration(target, action);
        if (!this.isRuntimeActive(epoch, session)) return;
        if (action === 'hide') this.galleryKnownCounts[tab]?.keys.delete(countKey);
        dialog.close({ animate: false, restoreFocus: false });
        if (!onSaved?.(action)) this.renderGallery(tab);
      } catch (cause) {
        if (!this.isRuntimeActive(epoch, session) || !sheet.isConnected) return;
        saving = false;
        sheet.removeAttribute('aria-busy');
        for (const button of sheet.querySelectorAll<HTMLButtonElement>('button')) button.disabled = false;
        this.operationalError(cause, '保险箱操作未能保存，未做更改');
      }
    };
    sheet.querySelector('[data-gallery-action="pin"]')?.addEventListener('click', () => void finish(pinned ? 'unpin' : 'pin'));
    sheet.querySelector('[data-gallery-action="delete"]')?.addEventListener('click', () => void finish('hide'));
    sheet.addEventListener('click', event => { if (event.target === sheet) dialog.close(); });
    requestAnimationFrame(() => {
      if (!sheet.isConnected || !source.isConnected) return;
      const menu = sheet.querySelector<HTMLElement>('.gallery-actions-menu')!;
      const rect = source.getBoundingClientRect();
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const x = Math.max(left + 12, Math.min(rect.left, left + width - menu.offsetWidth - 12));
      const below = rect.bottom + 10;
      const y = below + menu.offsetHeight <= top + height - 12 ? below : Math.max(top + 12, rect.top - menu.offsetHeight - 10);
      menu.style.left = `${Math.round(x)}px`;
      menu.style.top = `${Math.round(y)}px`;
      menu.style.setProperty('--action-origin-x', `${Math.max(0, Math.min(menu.offsetWidth, rect.left + rect.width / 2 - x))}px`);
      menu.style.setProperty('--action-origin-y', `${Math.max(0, Math.min(menu.offsetHeight, rect.top + rect.height / 2 - y))}px`);
    });
  }

  private renderGallery(tab: GalleryTab = 'images'): void {
    const session = this.session;
    if (!session || this.privacyCovered) return;
    // Incoming messages, reactions, deletes, and upload completion can refresh
    // the Safe while its viewer is open. Keep the mounted viewer/gesture state
    // stable and project the newest gallery once the overlay closes.
    if (this.root.querySelector('.image-viewer, .document-reader')) {
      this.galleryRefreshPending = tab;
      return;
    }
    const actions = this.root.querySelector<HTMLElement>('.gallery-actions-sheet');
    if (actions) closeDialog(actions, { animate: false, restoreFocus: false });
    const epoch = this.runtimeEpoch;
    const signal = this.runtimeAbort?.signal;
    if (!this.setActiveSurface('away')) return;
    if (this.galleryMode === 'safe' && session.vault.role !== 'creator') {
      this.renderChat();
      return;
    }
    // Reveals belong to this visit, never to stored preferences or the verified
    // image cache. Tab changes and upload refreshes retain only explicit reveals.
    if (!this.root.querySelector('.gallery-shell')) this.galleryRevealedAssets.clear();
    const cryptoReady = session.vault.protocol !== 'mls-rfc9420' || session.vault.mls?.phase === 'active';
    const filesTab = tab === 'files';
    const favorites = this.galleryMode === 'favorites';
    const surfaceName = favorites ? '收藏' : '保险箱';
    const category = filesTab ? '文件' : '照片和视频';
    const knownCount = this.galleryKnownCounts[tab] ??= { keys: new Set(), complete: false };
    let assets: GalleryAsset[] = [];
    let fileAssets: GalleryFileAsset[] = [];
    const assetKeys = new Set<string>();
    let fileCount = 0;
    const imageButtons = new Map<string, HTMLButtonElement>();
    const fileButtons = new Map<string, HTMLButtonElement>();
    const curationRecords = favorites ? [] : this.uiPreferences.galleryCuration ?? [];
    const deletedForEveryone = this.messageDeletions();
    // Counts survive tab switches, but global deletion is a later projection
    // event rather than a mutation of the original media record. Reconcile the
    // retained keys before painting either tab so a deleted item cannot leave
    // a stale number (or briefly add a misleading `+`) behind.
    for (const deletedClientMsgId of deletedForEveryone.keys()) this.removeDeletedGalleryKnownCount(deletedClientMsgId);
    this.galleryObserver?.disconnect();
    this.galleryObserver = null;
    // Keep the segment control mounted across category changes so its capsule
    // can finish one continuous translation without a header layout reset.
    const retainedShell = this.root.querySelector<HTMLElement>(':scope > .gallery-shell');
    const retainedHeader = retainedShell?.querySelector<HTMLElement>('.gallery-header');
    const retainedTabs = retainedHeader?.querySelector<HTMLElement>('.gallery-tabs');
    retainedTabs?.remove();
    const template = document.createElement('template');
    template.innerHTML = `
      <section class="gallery-shell" data-gallery-mode="${this.galleryMode}" aria-label="${surfaceName}">
        <header class="subpage-header gallery-header" aria-label="${surfaceName}操作">
          <button class="icon-button" id="gallery-back" type="button" aria-label="返回聊天">${icons.back}</button>
          <div class="gallery-tabs" role="tablist" aria-label="${surfaceName}分类" data-active-tab="${tab}">
            <button class="gallery-tab" id="gallery-tab-images" type="button" role="tab" aria-controls="gallery-grid" aria-selected="${!filesTab}" tabindex="${filesTab ? -1 : 0}"><span>相册</span><span class="gallery-tab-count" aria-hidden="true" data-gallery-count="images" hidden></span></button>
            <button class="gallery-tab" id="gallery-tab-files" type="button" role="tab" aria-controls="gallery-grid" aria-selected="${filesTab}" tabindex="${filesTab ? 0 : -1}"><span>文件</span><span class="gallery-tab-count" aria-hidden="true" data-gallery-count="files" hidden></span></button>
          </div>
          <nav class="gallery-header-actions" aria-label="${surfaceName}操作">
            ${favorites ? '' : `<button class="icon-button gallery-upload-button${cryptoReady ? '' : ' is-disabled'}" id="open-gallery-image-picker" type="button" aria-label="上传照片、视频或文件到保险箱" title="上传照片、视频或文件到保险箱" ${cryptoReady ? '' : 'disabled'}>${icons.upload}</button>`}
          </nav>
          ${favorites ? '' : `<input id="gallery-image-input" type="file" multiple ${cryptoReady ? '' : 'disabled'} hidden />`}
        </header>
        ${filesTab ? '' : `<button class="icon-button gallery-visibility-button" id="gallery-toggle-visibility" type="button" aria-label="显示全部" title="显示全部" aria-controls="gallery-grid" disabled>${icons.eye}</button>`}
        <div class="notice gallery-notice" id="notice" role="status" hidden></div>
        <div class="upload-progress gallery-upload-progress" id="upload-progress" hidden><span></span><output></output></div>
        <div class="gallery-grid${filesTab ? ' gallery-file-list' : ''}" id="gallery-grid" role="tabpanel" aria-labelledby="gallery-tab-${tab}" tabindex="0"></div>
      </section>
    `;
    if (retainedShell && retainedHeader && retainedTabs) {
      const nextShell = template.content.firstElementChild!;
      const nextHeader = nextShell.querySelector('.gallery-header')!;
      retainedHeader.replaceChildren(...nextHeader.childNodes);
      nextHeader.replaceWith(retainedHeader);
      retainedShell.replaceChildren(...nextShell.childNodes);
      retainedShell.style.animation = 'none';
    } else this.root.replaceChildren(template.content);
    if (retainedTabs) {
      this.root.querySelector('.gallery-tabs')!.replaceWith(retainedTabs);
      this.root.querySelector<HTMLElement>('.gallery-shell')!.style.animation = 'none';
    }
    this.mountGalleryViewport();
    const tabs = this.root.querySelector<HTMLElement>('.gallery-tabs')!;
    tabs.dataset.activeTab = tab;
    for (const kind of ['images', 'files'] as const) {
      const button = tabs.querySelector<HTMLButtonElement>(`#gallery-tab-${kind}`)!;
      button.setAttribute('aria-selected', String(kind === tab));
      button.tabIndex = kind === tab ? 0 : -1;
      // Upload rerenders can move these controls out of the old upload scope
      // before its finally block re-enables them. The batch guard still blocks
      // switching until the current upload finishes.
      button.disabled = false;
    }
    this.root.querySelector('#gallery-back')?.addEventListener('click', () => this.transitionPage('backward', () => this.renderChat()));
    this.mountImagePicker(
      this.root.querySelector<HTMLInputElement>('#gallery-image-input'),
      'gallery',
      this.root.querySelector<HTMLButtonElement>('#open-gallery-image-picker'),
    );
    const grid = this.root.querySelector<HTMLElement>('#gallery-grid')!;
    if (retainedTabs) grid.style.animation = 'none';
    if (favorites && knownCount.complete && knownCount.keys.size === 0) {
      const empty = document.createElement('p'); empty.className = 'gallery-empty'; empty.textContent = '暂无收藏'; grid.append(empty);
    }
    const updateCounts = () => {
      for (const kind of ['images', 'files'] as const) {
        const count = this.galleryKnownCounts[kind];
        const categoryName = kind === 'images' ? '相册' : '文件';
        const button = this.root.querySelector<HTMLButtonElement>(`#gallery-tab-${kind}`)!;
        const label = button.querySelector<HTMLElement>('[data-gallery-count]')!;
        const value = count?.keys.size ?? 0;
        const pending = count && !count.complete && value === 0;
        const compactValue = value >= 10_000 ? `${Math.floor(value / 1000) / 10}万`
          : value >= 1000 ? `${Math.floor(value / 100) / 10}千` : String(value);
        // A pending or empty category has no visual placeholder. Its loading
        // distinction remains in the accessible description below.
        label.hidden = value === 0;
        label.textContent = value === 0 ? '' : `${compactValue}${count?.complete ? '' : '+'}`;
        const description = !count ? '数量尚未加载' : pending ? '正在加载数量'
          : `已加载 ${value}${kind === 'images' ? ' 项照片和视频' : ' 个文件'}${count.complete ? '' : '，还有更早记录待加载'}`;
        button.setAttribute('aria-label', `${categoryName}，${description}`);
        button.title = description;
      }
    };
    updateCounts();
    const visibilityButton = this.root.querySelector<HTMLButtonElement>('#gallery-toggle-visibility');
    const allImagesRevealed = () => assets.length > 0 && assets.every(asset =>
      this.galleryRevealedAssets.has(`${asset.clientMsgId}:${asset.assetIndex}`));
    const updateVisibilityButton = () => {
      if (!visibilityButton) return;
      visibilityButton.disabled = assets.length === 0;
      const revealed = allImagesRevealed();
      const label = revealed ? '隐藏全部' : '显示全部';
      visibilityButton.innerHTML = revealed ? icons.eyeOff : icons.eye;
      visibilityButton.setAttribute('aria-label', label);
      visibilityButton.title = label;
    };
    const updateTileVisibility = (button: HTMLButtonElement, key: string, manifest: ImageManifest, animate = true) => {
      const revealed = this.galleryRevealedAssets.has(key);
      const changed = button.dataset.revealed !== undefined && button.dataset.revealed !== String(revealed);
      button.dataset.revealed = String(revealed);
      button.setAttribute('aria-label', `${isVideoFile(manifest) ? revealed ? '播放视频' : '显示视频' : revealed ? '查看原图' : '显示图片'} ${manifest.originalName}`);
      const image = button.querySelector('img');
      // Conceal immediately, then fade the concealed result in. This never
      // leaves a clear outgoing frame during hide or privacy teardown.
      if (changed && image && animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        image.getAnimations().forEach(animation => animation.cancel());
        image.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 220, easing: 'ease-in-out' });
      }
    };
    visibilityButton?.addEventListener('click', () => {
      if (!this.isRuntimeActive(epoch, session) || !grid.isConnected) return;
      const reveal = !allImagesRevealed();
      const buttons = [...grid.querySelectorAll<HTMLButtonElement>('.gallery-tile')];
      // Read geometry together before changing concealment. Older decoded
      // pages still update, but only on-screen pixels need a fade animation.
      const viewport = grid.getBoundingClientRect();
      const visible = new Set(buttons.filter(button => {
        if (!button.querySelector('img')) return false;
        const bounds = button.getBoundingClientRect();
        return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
      }));
      // Also forget revealed older pages that are not mounted after a tab switch.
      if (!reveal) this.galleryRevealedAssets.clear();
      for (const button of buttons) {
        const asset = assets[Number(button.dataset.galleryIndex)];
        if (!asset) continue;
        const key = `${asset.clientMsgId}:${asset.assetIndex}`;
        if (reveal) this.galleryRevealedAssets.add(key);
        updateTileVisibility(button, key, asset.manifest, visible.has(button));
      }
      updateVisibilityButton();
    });
    let switchTimer: number | null = null;
    const switchTab = (next: GalleryTab) => {
      if (!this.isRuntimeActive(epoch, session) || !grid.isConnected || this.imageBatchUploading) return;
      if (switchTimer !== null) window.clearTimeout(switchTimer);
      tabs.dataset.activeTab = next;
      for (const kind of ['images', 'files'] as const) {
        const button = tabs.querySelector<HTMLButtonElement>(`#gallery-tab-${kind}`)!;
        button.setAttribute('aria-selected', String(kind === next));
        button.tabIndex = kind === next ? 0 : -1;
      }
      grid.getAnimations().forEach(animation => animation.cancel());
      if (next === tab) return;
      this.galleryScrollTop[tab] = grid.scrollTop;
      const finish = () => {
        if (!this.isRuntimeActive(epoch, session) || !grid.isConnected) return;
        this.renderGallery(next);
        this.root.querySelector<HTMLButtonElement>(`#gallery-tab-${next}`)?.focus({ preventScroll: true });
      };
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) finish();
      else {
        grid.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 100, easing: 'ease-in', fill: 'forwards' });
        switchTimer = window.setTimeout(finish, 100);
      }
    };
    for (const next of ['images', 'files'] as const) {
      const button = this.root.querySelector<HTMLButtonElement>(`#gallery-tab-${next}`)!;
      button.onclick = () => switchTab(next);
      button.onkeydown = event => {
        let target: GalleryTab;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') target = next === 'images' ? 'files' : 'images';
        else if (event.key === 'Home') target = 'images';
        else if (event.key === 'End') target = 'files';
        else return;
        event.preventDefault();
        switchTab(target);
      };
    }
    const footer = document.createElement('div');
    footer.className = 'gallery-pagination';
    footer.innerHTML = `<p role="status" class="gallery-scan-status">正在查找${category}…</p><button class="secondary-button" type="button" data-gallery-load-more>加载更早${category}</button>`;
    const more = footer.querySelector<HTMLButtonElement>('button')!;
    const status = footer.querySelector<HTMLElement>('[role="status"]')!;
    grid.append(footer);
    const removeGalleryAsset = (source: HTMLElement, target: GalleryCurationTarget, key: string,
      action: 'pin' | 'unpin' | 'hide'): boolean => {
      if (action !== 'hide' || target.category !== 'images') return false;
      const finish = () => {
        if (!this.isRuntimeActive(epoch, session) || !grid.isConnected || !source.isConnected) return;
        const scrollTop = grid.scrollTop;
        const moving = [...grid.querySelectorAll<HTMLElement>('.gallery-tile, .gallery-file')];
        const sourceIndex = moving.indexOf(source);
        const before = new Map(moving.filter(node => node !== source).map(node => [node, node.getBoundingClientRect()]));
        this.galleryObserver?.unobserve(source);
        source.remove();
        assetKeys.delete(key);
        assets = assets.filter(asset => galleryCurationKey(asset) !== galleryCurationKey(target));
        imageButtons.delete(key);
        this.galleryRevealedAssets.delete(key);
        for (const [index, asset] of assets.entries()) {
          const button = imageButtons.get(`${asset.clientMsgId}:${asset.assetIndex}`);
          if (button) button.dataset.galleryIndex = String(index);
        }
        grid.scrollTop = scrollTop;
        updateCounts();
        updateVisibilityButton();
        const remaining = [...grid.querySelectorAll<HTMLElement>('.gallery-tile, .gallery-file')];
        if (!remaining.length && knownCount.complete && !grid.querySelector('.gallery-empty')) {
          const empty = document.createElement('p');
          empty.className = 'gallery-empty';
          empty.textContent = favorites ? '暂无收藏' : `还没有${category}`;
          grid.insertBefore(empty, footer);
        }
        if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
          for (const node of remaining) {
            const start = before.get(node); if (!start) continue;
            const end = node.getBoundingClientRect();
            const x = start.left - end.left; const y = start.top - end.top;
            if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) continue;
            node.animate([{ transform: `translate3d(${x}px, ${y}px, 0)` }, { transform: 'translate3d(0, 0, 0)' }],
              { duration: 260, easing: 'cubic-bezier(.16, 1, .3, 1)' });
          }
        }
        remaining[Math.min(Math.max(0, sourceIndex), remaining.length - 1)]?.focus({ preventScroll: true });
      };
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) finish();
      else {
        const animation = source.animate([
          { opacity: 1, transform: 'scale(1)' },
          { opacity: 0, transform: 'scale(.92)' },
        ], { duration: 140, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' });
        void animation.finished.then(finish, finish);
      }
      return true;
    };
    const addMessages = (messages: DecryptedMessage[]) => {
      // A delete event is loaded independently from the visible chat page. An
      // older media target may only become available during this Safe scan, so
      // project the event again with this decrypted page before adding tiles.
      for (const [clientMsgId, tombstone] of this.messageDeletions(messages)) {
        deletedForEveryone.set(clientMsgId, tombstone);
        this.removeDeletedGalleryKnownCount(clientMsgId);
      }
      for (const message of messages) {
        if (deletedForEveryone.has(message.clientMsgId)) continue;
        if (!favorites && isExpressionPayload(message.payload)) continue;
        if ((message.payload.kind === 'file' || message.payload.kind === 'gallery-file') && !isVideoFile(message.payload.file)) {
          if (!filesTab) continue;
          const key = `${message.clientMsgId}:file`;
          if (assetKeys.has(key)) continue;
          assetKeys.add(key);
          const target: GalleryCurationTarget = { category: 'files', clientMsgId: message.clientMsgId, assetIndex: 0 };
          if (favorites && (!this.attachmentFavorite(target) || message.payload.kind === 'gallery-file')) continue;
          if (curationRecords.some(record => record.hidden && galleryCurationKey(record) === galleryCurationKey(target))) continue;
          knownCount.keys.add(key);
          fileCount += 1;
          fileAssets.push({ ...target, seq: message.seq, manifest: message.payload.file, sentAt: message.payload.sentAt, source: message });
          const button = this.createFileAttachment(message.payload.file, !favorites, message);
          button.classList.add('gallery-file');
          button.dataset.galleryAssetKey = key;
          const time = document.createElement('time');
          time.className = 'gallery-file-time';
          time.textContent = timeLabel(message.payload.sentAt);
          button.querySelector('.file-attachment-copy')!.append(time);
          this.mountGalleryCurationActions(button, target, tab, key, undefined,
            action => removeGalleryAsset(button, target, key, action));
          if (favorites) button.addEventListener('click', () => {
            if (button.dataset.galleryHoldCommitted === 'true') { delete button.dataset.galleryHoldCommitted; return; }
            if (Date.now() < this.suppressMediaClickUntil) return;
            this.openGalleryCurationActions(button, target, tab, key);
          });
          fileButtons.set(key, button);
          grid.insertBefore(button, footer);
          continue;
        }
        if (filesTab) continue;
        const manifests = message.payload.kind === 'image-album' ? message.payload.images
          : message.payload.kind === 'image' || message.payload.kind === 'gallery-image' ? [message.payload.image]
          : (message.payload.kind === 'file' || message.payload.kind === 'gallery-file') && isVideoFile(message.payload.file) ? [message.payload.file] : [];
        for (const [assetIndex, manifest] of manifests.entries()) {
          const key = `${message.clientMsgId}:${assetIndex}`;
          if (assetKeys.has(key)) continue;
          assetKeys.add(key);
          const target: GalleryCurationTarget = { category: 'images', clientMsgId: message.clientMsgId, assetIndex };
          if (favorites && (!this.attachmentFavorite(target) || message.payload.kind === 'gallery-image' || message.payload.kind === 'gallery-file')) continue;
          if (curationRecords.some(record => record.hidden && galleryCurationKey(record) === galleryCurationKey(target))) continue;
          knownCount.keys.add(key);
          const index = assets.length;
          assets.push({ ...target, seq: message.seq, manifest, sentAt: message.payload.sentAt, source: message });
          const button = document.createElement('button');
          button.type = 'button';
          const video = isVideoFile(manifest);
          button.className = `gallery-tile${video ? ' video-preview' : ''}`;
          button.dataset.galleryIndex = String(index);
          button.dataset.galleryAssetKey = key;
          button.dataset.blobId = manifest.blobId;
          updateTileVisibility(button, key, manifest);
          button.innerHTML = `<span class="gallery-skeleton" aria-hidden="true"></span><span class="tile-loading sr-only" role="status">正在加载${video ? '视频' : '图片'}</span>`;
          button.dataset.thumbnailState = 'pending';
          button.setAttribute('aria-busy', 'true');
          button.addEventListener('click', () => {
            if (button.dataset.galleryHoldCommitted === 'true') {
              delete button.dataset.galleryHoldCommitted;
              return;
            }
            if (Date.now() < this.suppressMediaClickUntil || !this.isRuntimeActive(epoch, session) || !button.isConnected) return;
            if (button.dataset.thumbnailState === 'error') {
              this.mountGalleryThumbnails(grid, assets);
              return;
            }
            if (!this.galleryRevealedAssets.has(key)) {
              this.galleryRevealedAssets.add(key);
              updateTileVisibility(button, key, manifest);
              updateVisibilityButton();
              return;
            }
            this.galleryScrollTop.images = grid.scrollTop;
            const currentIndex = assets.findIndex(asset => asset.clientMsgId === message.clientMsgId && asset.assetIndex === assetIndex);
            if (currentIndex >= 0) this.openImageViewer(
              assets.map((asset) => asset.manifest),
              currentIndex,
              button,
              assets.map((asset) => asset.sentAt),
              assets.map((asset) => ({ clientMsgId: asset.clientMsgId, assetIndex: asset.assetIndex, source: asset.source })),
            );
          });
          this.mountGalleryCurationActions(button, target, tab, key, video || favorites ? undefined : () => {
            if (!this.isRuntimeActive(epoch, session) || !button.isConnected) return;
            this.galleryScrollTop.images = grid.scrollTop;
            const currentIndex = assets.findIndex(asset => asset.clientMsgId === message.clientMsgId && asset.assetIndex === assetIndex);
            if (currentIndex >= 0) this.openImageViewer(
              assets.map(asset => asset.manifest), currentIndex, button,
              assets.map(asset => asset.sentAt),
              assets.map(asset => ({ clientMsgId: asset.clientMsgId, assetIndex: asset.assetIndex, source: asset.source })), true,
            );
          }, action => removeGalleryAsset(button, target, key, action));
          imageButtons.set(key, button);
          grid.insertBefore(button, footer);
        }
      }
      if (filesTab && (favorites || curationRecords.some(record => record.category === 'files'))) {
        fileAssets = favorites ? sortFavoriteAssets(fileAssets, this.uiPreferences.attachmentFavorites ?? []) : curateGalleryAssets('files', fileAssets, curationRecords);
        for (const asset of fileAssets) {
          const button = fileButtons.get(`${asset.clientMsgId}:file`);
          if (button) grid.insertBefore(button, footer);
        }
        fileCount = fileAssets.length;
      }
      if (!filesTab && (favorites || curationRecords.some(record => record.category === 'images'))) {
        assets = favorites ? sortFavoriteAssets(assets, this.uiPreferences.attachmentFavorites ?? []) : curateGalleryAssets('images', assets, curationRecords);
        for (const [index, asset] of assets.entries()) {
          const button = imageButtons.get(`${asset.clientMsgId}:${asset.assetIndex}`);
          if (!button) continue;
          button.dataset.galleryIndex = String(index);
          grid.insertBefore(button, footer);
        }
      }
      updateCounts();
      updateVisibilityButton();
      if (!filesTab) this.mountGalleryThumbnails(grid, assets);
    };
    addMessages([...this.pending.values()].sort((left, right) => right.acceptedAt.localeCompare(left.acceptedAt)));
    let beforeSeq: number | undefined;
    let hasMore = true;
    let loading = false;
    let initial = true;
    const loadMore = async () => {
      if (loading || !hasMore || !this.isRuntimeActive(epoch, session) || !grid.isConnected) return;
      loading = true;
      more.disabled = true;
      status.textContent = initial && favorites ? '' : `正在查找${category}…`;
      const startedWith = assets.length + fileCount;
      try {
        // Skip text-only batches without exposing plaintext media metadata in
        // IndexedDB or coupling the album to the chat's current history page.
        do {
          const page = await loadMediaHistoryPage(session, { beforeSeq, signal, includeExpressions: favorites });
          if (!this.isRuntimeActive(epoch, session) || !grid.isConnected) return;
          beforeSeq = page.beforeSeq ?? undefined;
          hasMore = page.hasMore;
          addMessages(page.messages);
          if (hasMore && assets.length + fileCount - startedWith < 36) await this.abortableDelay(0, signal);
        } while (hasMore && assets.length + fileCount - startedWith < 36);
        knownCount.complete = !hasMore;
        updateCounts();
        status.textContent = hasMore ? '' : assets.length + fileCount ? `已加载本机保存的全部${category}`
          : favorites ? '' : filesTab ? '从保险箱上传的文档、压缩包等文件会显示在这里。' : '聊天中的照片、视频和从保险箱上传的照片、视频会显示在这里。';
        if (assets.length || fileCount) grid.querySelector('.gallery-empty')?.remove();
        if (!hasMore && !assets.length && !fileCount && !grid.querySelector('.gallery-empty')) {
          const empty = document.createElement('p');
          empty.className = 'gallery-empty';
          empty.textContent = favorites ? '暂无收藏' : `还没有${category}`;
          grid.insertBefore(empty, footer);
        }
        more.hidden = !hasMore;
        if (initial) {
          grid.scrollTop = this.galleryScrollTop[tab];
          initial = false;
        }
      } catch (cause) {
        if (this.isRuntimeActive(epoch, session) && grid.isConnected) {
          status.textContent = '保险箱记录暂时无法读取';
          more.textContent = '重试';
          this.operationalError(cause, '保险箱读取失败');
        }
      } finally {
        loading = false;
        if (grid.isConnected) more.disabled = false;
      }
    };
    more.addEventListener('click', () => void loadMore());
    void loadMore();
  }

  private removeDeletedGalleryKnownCount(clientMsgId: string): void {
    const prefix = `${clientMsgId}:`;
    for (const count of Object.values(this.galleryKnownCounts)) {
      if (!count) continue;
      for (const key of count.keys) if (key.startsWith(prefix)) count.keys.delete(key);
    }
  }

  private mountGalleryThumbnails(grid: HTMLElement, assets: GalleryAsset[]): void {
    const session = this.session;
    if (!session || this.privacyCovered) return;
    const epoch = this.runtimeEpoch;
    const loadThumbnail = async (tile: HTMLButtonElement) => {
      if (!this.isRuntimeActive(epoch, session) || !tile.isConnected) return;
      const index = Number(tile.dataset.galleryIndex);
      const manifest = Number.isSafeInteger(index) ? assets[index]?.manifest : undefined;
      if (!manifest || tile.dataset.thumbnailState === 'loading' || tile.dataset.thumbnailState === 'loaded') return;
      tile.dataset.thumbnailState = 'loading';
      tile.setAttribute('aria-busy', 'true');
      const loading = tile.querySelector<HTMLElement>('.tile-loading');
      if (loading) { loading.classList.add('sr-only'); loading.textContent = isVideoFile(manifest) ? '正在加载视频' : '正在加载图片'; }
      try {
        const cached = await this.loadImage(manifest);
        if (!this.isRuntimeActive(epoch, session) || !tile.isConnected) return;
        if (isVideoFile(manifest)) {
          await this.ensureVideoPoster(manifest, cached);
          if (!this.isRuntimeActive(epoch, session) || !tile.isConnected) return;
          if (!cached.posterUrl) {
            tile.replaceChildren(this.videoPlayBadge());
            tile.dataset.thumbnailState = 'loaded';
            tile.setAttribute('aria-busy', 'false');
            return;
          }
        }
        const image = document.createElement('img');
        image.src = cached.posterUrl ?? cached.url;
        image.alt = manifest.originalName || '保险箱图片';
        image.decoding = 'async';
        await image.decode();
        if (!this.isRuntimeActive(epoch, session) || !tile.isConnected) return;
        cached.width = image.naturalWidth;
        cached.height = image.naturalHeight;
        tile.replaceChildren(image);
        if (isVideoFile(manifest)) tile.append(this.videoPlayBadge());
        tile.dataset.thumbnailState = 'loaded';
        tile.setAttribute('aria-busy', 'false');
      } catch {
        if (!this.isRuntimeActive(epoch, session) || !tile.isConnected) return;
        tile.dataset.thumbnailState = 'error';
        tile.setAttribute('aria-busy', 'false');
        const label = tile.querySelector<HTMLElement>('.tile-loading');
        if (label) {
          label.classList.remove('sr-only');
          label.textContent = '载入失败，点按重试';
        }
      }
    };

    if (!('IntersectionObserver' in window)) {
      grid.querySelectorAll<HTMLButtonElement>('.gallery-tile').forEach((tile) => void loadThumbnail(tile));
      return;
    }
    this.galleryObserver?.disconnect();
    this.galleryObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const tile = entry.target as HTMLButtonElement;
        this.galleryObserver?.unobserve(tile);
        void loadThumbnail(tile);
      }
    }, { root: grid, rootMargin: '240px 0px', threshold: 0.01 });
    grid.querySelectorAll<HTMLButtonElement>('.gallery-tile').forEach((tile) => this.galleryObserver?.observe(tile));
  }

  private async renderImageDetail(manifest: ImageManifest): Promise<void> {
    const session = this.session;
    if (!session || this.privacyCovered) return;
    if (!this.setActiveSurface('away')) return;
    if (session.vault.role !== 'creator') {
      this.renderChat();
      this.showNotice('保险箱仅对会话创建者开放', 'error');
      return;
    }
    const epoch = this.runtimeEpoch;
    this.root.innerHTML = `
      <section class="image-detail">
        <header class="subpage-header detail-header">
          <button class="icon-button" id="detail-back" type="button" aria-label="返回图片列表">${icons.back}</button>
          <div><h1 id="detail-name"></h1><p>${this.fileSize(manifest.originalSize)}</p></div>
          <button class="icon-button" id="download-image" type="button" aria-label="下载原图">${icons.download}</button>
        </header>
        <div class="notice detail-notice" id="notice" role="status" hidden></div>
        <div class="detail-stage"><p id="detail-loading" class="quiet-image-placeholder" role="status">${icons.image}<span class="sr-only">正在加载图片</span></p></div>
      </section>
    `;
    this.root.querySelector<HTMLElement>('#detail-name')!.textContent = manifest.originalName || '原图';
    this.root.querySelector('#detail-back')?.addEventListener('click', () => this.transitionPage('backward', () => this.renderGallery()));
    try {
      const cached = await this.loadImage(manifest);
      if (!this.isRuntimeActive(epoch, session)) return;
      const image = document.createElement('img');
      image.src = cached.url;
      image.alt = manifest.originalName || '原图';
      this.root.querySelector('.detail-stage')?.replaceChildren(image);
      this.root.querySelector('#download-image')?.addEventListener('click', () => {
        this.beginFileExport();
        void this.withSystemSurface(() => downloadBlob(cached.blob, manifest.originalName || 'image')).catch((cause) => {
          this.finishFileExport();
          this.operationalError(cause, '原图保存失败');
        });
      });
    } catch (cause) {
      if (!this.isRuntimeActive(epoch, session)) return;
      const loading = this.root.querySelector<HTMLElement>('#detail-loading');
      if (loading) loading.textContent = cause instanceof Error ? cause.message : '原图载入失败';
    }
  }

  private updateConnectionStatus(): void {
    this.updateCallControls();
    const label = this.root.querySelector<HTMLElement>('#connection-label');
    const dot = this.root.querySelector<HTMLElement>('.status-dot');
    if (label) label.textContent = this.connectionState === 'connected' ? '已连接，等待对方加入' : this.connectionState === 'connecting' ? '正在连接…' : '连接已断开，正在重试';
    if (dot) dot.dataset.state = this.connectionState;
    this.updatePeerStatus();
  }

  private updatePeerStatus(): void {
    const selfRow = this.root.querySelector<HTMLElement>('#self-presence');
    const peerRow = this.root.querySelector<HTMLElement>('#peer-presence');
    const summary = this.root.querySelector<HTMLElement>('.peer-summary');
    if (!selfRow || !peerRow || !summary || !this.session) return;
    const activeMembers = this.session.vault.members.filter((member) => member.status === undefined || member.status === 'active');
    const paired = new Set(activeMembers.map((member) => member.role)).size === 2;
    const mlsPending = this.session.vault.protocol === 'mls-rfc9420' && this.session.vault.mls?.phase !== 'active';
    const selfRole = this.session.vault.role;
    const peerRole = selfRole === 'creator' ? 'joiner' : 'creator';
    const snapshotAvailable = this.connectionState === 'connected' && this.rolePresence !== null;
    const lastSeenText = (timestamp: number | null) => {
      if (!timestamp) return '最近上线时间未知';
      const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
      if (minutes < 1) return '刚刚在线';
      if (minutes < 60) return `${minutes} 分钟前在线`;
      if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前在线`;
      return `${Math.floor(minutes / 1440)} 天前在线`;
    };
    const update = (row: HTMLElement, value: boolean | null) => {
      const state = value === null ? 'syncing' : value ? 'online' : 'offline';
      row.dataset.state = state;
      const label = row === peerRow ? summary.querySelector<HTMLElement>('.peer-status') : row.querySelector<HTMLElement>('strong');
      if (label) label.textContent = value === null ? '同步中' : value ? '在线' : row === peerRow ? lastSeenText(this.roleLastSeen[peerRole]) : '离线';
    };
    const selfOnline = snapshotAvailable ? this.rolePresence![selfRole] : null;
    const peerOnline = snapshotAvailable ? this.rolePresence![peerRole] : null;
    update(selfRow, selfOnline);
    update(peerRow, peerOnline);
    const circuit = summary.querySelector<SVGElement>('.presence-circuit');
    if (circuit && this.activeSurface === 'chat' && !this.privacyCovered) {
      if (!this.presenceCircuit) this.presenceCircuit = new PresenceCircuit(circuit);
      this.presenceCircuit.update(selfOnline, peerOnline);
    }
    const transport = this.connectionState === 'connected'
      ? '实时连接正常'
      : this.connectionState === 'connecting'
        ? '实时连接正在恢复'
        : '实时连接已断开，消息会在本机排队';
    const crypto = mlsPending ? 'MLS 会话仍在建立' : this.session.vault.protocol === 'mls-rfc9420' ? 'MLS 前向保密已启用' : '旧版端到端加密';
    const detail = `${paired ? '' : '等待另一位参与者加入；'}我：${selfOnline === null ? '同步中' : selfOnline ? '在线' : '离线'}；对方：${peerOnline === null ? '同步中' : peerOnline ? '在线' : '离线'}。${transport}；${crypto}`;
    summary.setAttribute('aria-label', detail);
    summary.title = detail;
    summary.dataset.connectionState = snapshotAvailable ? 'ready' : 'syncing';
  }

  private showNotice(message: string, tone: 'error' | 'info' = 'info'): void {
    const notice = this.root.querySelector<HTMLElement>('.image-viewer:not(.is-closing) [data-viewer-notice]')
      ?? this.root.querySelector<HTMLElement>('#notice');
    if (!notice) return;
    if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer);
    if (this.noticeRemovalTimer !== null) window.clearTimeout(this.noticeRemovalTimer);
    notice.hidden = false;
    notice.dataset.tone = tone;
    notice.textContent = message;
    notice.classList.remove('is-visible', 'is-leaving');
    requestAnimationFrame(() => notice.classList.add('is-visible'));
    this.noticeTimer = window.setTimeout(() => {
      if (notice.textContent !== message) return;
      notice.classList.remove('is-visible');
      notice.classList.add('is-leaving');
      this.noticeRemovalTimer = window.setTimeout(() => {
        if (notice.textContent === message && !notice.classList.contains('is-visible')) notice.hidden = true;
        notice.classList.remove('is-leaving');
        this.noticeRemovalTimer = null;
      }, 280);
      this.noticeTimer = null;
    }, 5000);
  }

  private showFormError(cause: unknown): void {
    const error = this.root.querySelector<HTMLElement>('.form-error');
    if (error) error.textContent = cause instanceof Error ? cause.message : '操作失败';
  }

  private operationalError(cause: unknown, fallback = '本机存储或网络操作失败，数据仍会保留并在恢复后重试'): void {
    const detail = cause instanceof Error && cause.message ? `：${cause.message}` : '';
    this.showNotice(`${fallback}${detail}`, 'error');
  }

  private fatalSecurityError(cause: unknown): void {
    this.cleanupRuntime(false);
    this.privacyCovered = false;
    document.body.className = 'app-mode';
    this.root.innerHTML = `
      <section class="fatal-screen">
        <p class="eyebrow">连接已停止</p>
        <h1>安全验证未通过</h1>
        <p id="fatal-message"></p>
        <button class="primary-button" id="fatal-lock" type="button">锁定并返回白屏</button>
      </section>
    `;
    this.root.querySelector<HTMLElement>('#fatal-message')!.textContent = cause instanceof Error ? cause.message : '设备身份或消息完整性异常';
    this.root.querySelector('#fatal-lock')?.addEventListener('click', () => this.lockNow());
  }

  private clearMemeCache(): void {
    this.memeCache.media.clear();
    this.memeCache.mediaBytes = 0;
    this.memeCache.searches.clear();
    this.memeCache.packs.clear();
  }

  private fileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  }

  private lockNow({ preserveFilePicker = false }: { preserveFilePicker?: boolean } = {}): void {
    this.clearMemePanelHandoff();
    this.clearMemeCache();
    this.clearKeyboardHandoff();
    this.clearNativeHandoff();
    // A cover can still own a key: explicit lock must discard it even when no UI is open.
    this.coverEntryEpoch += 1;
    this.retainedSession = null;
    this.idleDeadline = 0;
    this.idleMonotonicDeadline = 0;
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.cancelCoverTimer();
    if (this.privacyCovered) {
      if (!preserveFilePicker) {
        this.deferredImageUpload = null;
        this.filePickerActive = false;
        this.finishImagePicker();
      }
      return;
    }
    this.renderCover(preserveFilePicker);
  }

  private cleanupRuntime(preserveFilePicker = false): void {
    this.closeMemePicker();
    this.clearMemePanelHandoff();
    this.clearMemeCache();
    this.gatewayFocusAbort?.abort();
    this.gatewayFocusAbort = null;
    this.gatewayUnlockAbort?.abort();
    this.gatewayUnlockAbort = null;
    this.clearKeyboardHandoff();
    this.clearNativeHandoff();
    this.chatImageConcealGesture?.destroy();
    this.chatImageConcealGesture = null;
    this.viewerGestureCleanup?.();
    this.viewerGestureCleanup = null;
    if (this.backupTimer !== null) window.clearInterval(this.backupTimer);
    this.backupTimer = null;
    this.backupRun = null;
    this.backupError = '';
    this.retainedSession = null;
    this.idleDeadline = 0;
    this.idleMonotonicDeadline = 0;
    this.callController?.destroy();
    this.callController = null;
    delete (window as Window & { quietRoomCallDiagnostics?: () => unknown }).quietRoomCallDiagnostics;
    this.callVault = null;
    this.callView?.destroy();
    this.callView = null;
    this.callPermissionActive = false;
    this.callReturnFocus = null;
    this.root.inert = this.root.classList.contains('portrait-blocked');
    document.body.classList.remove('call-active');
    this.closeVoiceRecorder();
    this.voiceGesture?.destroy();
    this.voiceGesture = null;
    this.voicePlayback.stop();
    this.captureChatAnchor(false);
    const composer = this.root.querySelector<HTMLTextAreaElement>('#message-input');
    if (composer && this.uiPreferencesHydrated) {
      this.uiPreferences.composerDraft = composer.value;
      composer.value = '';
    }
    this.sendingTextDrafts.clear();
    if (this.composerHeightMotion?.frame != null) cancelAnimationFrame(this.composerHeightMotion.frame);
    this.composerHeightMotion = null;
    this.composerViewportSettleUntil = 0;
    this.imageBatchUploading = false;
    if (this.blurLockTimer !== null) window.clearTimeout(this.blurLockTimer);
    this.blurLockTimer = null;
    if (this.preferenceSaveTimer !== null) window.clearTimeout(this.preferenceSaveTimer);
    this.preferenceSaveTimer = null;
    if (this.uiPreferencesHydrated) this.flushUiPreferencesSave();
    this.runtimeEpoch += 1;
    this.runtimeAbort?.abort();
    this.runtimeAbort = null;
    this.imageLoadStatus.clear();
    this.gesturePad?.destroy();
    this.gesturePad = null;
    this.galleryObserver?.disconnect();
    this.galleryObserver = null;
    this.chatImageObserver?.disconnect();
    this.chatImageObserver = null;
    this.cancelCoverTimer();
    this.socket?.close();
    this.socket = null;
    this.session = null;
    this.messages.clear();
    this.messageEventHistory.clear();
    this.mediaReadQueued.clear();
    this.messageReadQueued.clear();
    this.readMessageIds.clear();
    this.chatExplicitlyConcealedAssets.clear();
    this.clearMessageTextSelection();
    this.pending.clear();
    for (const draft of this.videoUploads.values()) draft.view.destroy();
    this.videoUploads.clear();
    this.outbox.clear();
    this.pendingReceipts.clear();
    this.serverQueue.clear();
    this.receiptQueue.clear();
    this.uploadPlans = [];
    for (const timer of this.retryTimers.values()) window.clearTimeout(timer);
    this.retryTimers.clear();
    this.retryCounts.clear();
    this.deferredCapabilityItems.clear();
    this.sending.clear();
    this.outboxReencryptions.clear();
    this.renderedMessages.clear();
    this.renderedMessageOrder = [];
    this.renderedMessageDates.clear();
    this.renderedMessageSeq.clear();
    this.replyTarget = null;
    this.cancelMessageHold();
    if (this.messageHighlightTimer !== null) window.clearTimeout(this.messageHighlightTimer);
    this.messageHighlightTimer = null;
    this.historyHasMore = false;
    this.historyHasNewer = false;
    this.historyForwardCursor = 0;
    this.historyLoading = false;
    if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer);
    if (this.noticeRemovalTimer !== null) window.clearTimeout(this.noticeRemovalTimer);
    if (this.pageTransitionTimer !== null) window.clearTimeout(this.pageTransitionTimer);
    this.noticeTimer = null;
    this.noticeRemovalTimer = null;
    this.pageTransitionTimer = null;
    if (this.viewerKeyHandler) document.removeEventListener('keydown', this.viewerKeyHandler);
    this.viewerKeyHandler = null;
    this.viewerReturnFocus = null;
    this.viewerProjectionSources = [];
    this.stopViewerMedia();
    this.root.querySelector('.image-viewer')?.remove();
    delete this.root.dataset.pageTransition;
    this.restoreComposerFocusAfterPicker = false;
    this.keepComposerKeyboard = false;
    this.bottomControlRetainsKeyboard = false;
    this.composerSelection = null;
    this.finishFileExport();
    this.draining = false;
    this.receiptDraining = false;
    this.unlocking = false;
    this.deviceVerificationActive = false;
    this.deviceVerificationFocusSettle?.(false);
    this.deviceVerificationFocusSettle = null;
    this.deviceVerificationToken = null;
    this.deviceVerificationDeadline = 0;
    this.deviceVerificationWallDeadline = 0;
    this.systemSurfaceTokens.clear();
    for (const cached of this.imageCache.values()) {
      URL.revokeObjectURL(cached.url);
      if (cached.posterUrl) URL.revokeObjectURL(cached.posterUrl);
      if (cached.concealedUrl) URL.revokeObjectURL(cached.concealedUrl);
    }
    this.imageCache.clear();
    this.imageLoadPromises.clear();
    this.imageManifestSignatures.clear();
    this.imageCacheBytes = 0;
    this.connectionState = 'disconnected';
    this.rolePresence = null;
    this.roleLastSeen = { creator: null, joiner: null };
    this.chatLayoutObserver?.disconnect();
    this.chatLayoutObserver = null;
    this.chatBottomControl?.destroy();
    this.chatBottomControl = null;
    this.chatKeyboardGesture?.destroy();
    this.chatKeyboardGesture = null;
    this.chatViewportMotion = null;
    this.nativeChatFollow = null;
    this.chatLayoutElements = null;
    this.syncChatLayout = () => {};
    this.cancelViewportWork();
    if (this.chatScrollFrame !== null) cancelAnimationFrame(this.chatScrollFrame);
    this.chatScrollFrame = null;
    if (this.presenceRefreshTimer !== null) window.clearInterval(this.presenceRefreshTimer);
    this.presenceRefreshTimer = null;
    this.presenceCircuit?.destroy();
    this.presenceCircuit = null;
    if (this.recoveryPollTimer !== null) window.clearTimeout(this.recoveryPollTimer);
    this.recoveryPollTimer = null;
    this.activeSurface = 'away';
    this.uiPreferences = {};
    this.uiPreferencesHydrated = false;
    this.chatRestoreAnchor = null;
    this.restoreChatAnchorOnNextRender = true;
    this.galleryScrollTop = { images: 0, files: 0 };
    this.galleryRevealedAssets.clear();
    this.chatRevealedAssets.clear();
    this.chatConcealedExpressions.clear();
    this.galleryKnownCounts = {};
    this.galleryRefreshPending = null;
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.idleDeadline = 0;
    this.idleMonotonicDeadline = 0;
    this.sendChain = Promise.resolve();
    if (!preserveFilePicker) {
      this.deferredImageUpload = null;
      this.filePickerActive = false;
      this.finishImagePicker();
    }
  }

  private resetIdleLock(): void {
    if (!this.session || this.privacyCovered || document.hidden || this.expireIdleSession()) return;
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (!this.desktopBrowser && this.callController?.active) {
      this.idleDeadline = 0;
      this.idleMonotonicDeadline = 0;
      return;
    }
    const duration = (this.desktopBrowser ? 30 : 10) * 60_000;
    this.idleDeadline = Date.now() + duration;
    this.idleMonotonicDeadline = performance.now() + duration;
    this.scheduleIdleLock(duration);
  }

  private expireIdleSession(): boolean {
    if ((!this.session && !this.retainedSession) || !this.idleDeadline) return false;
    if (Date.now() < this.idleDeadline && performance.now() < this.idleMonotonicDeadline) return false;
    this.lockNow();
    return true;
  }

  private scheduleIdleLock(delay?: number): void {
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    const remaining = Math.min(this.idleDeadline - Date.now(), this.idleMonotonicDeadline - performance.now());
    this.idleTimer = window.setTimeout(() => {
      this.idleTimer = null;
      if (!this.expireIdleSession() && (this.session || this.retainedSession)) this.scheduleIdleLock();
    }, Math.max(0, delay ?? remaining));
  }

  private ensureCallController(): CallController | null {
    const session = this.session;
    if (!session || this.privacyCovered) return null;
    if (this.callController) return this.callController;
    const epoch = this.runtimeEpoch;
    const controller = new CallController({
      getVault: () => this.isRuntimeActive(epoch, session) ? this.callVault : null,
      send: envelope => {
        if (!this.isRuntimeActive(epoch, session) || !this.socket) throw new Error('会话已锁定');
        return this.socket.sendCall(envelope);
      },
      cancelSignals: callId => this.socket?.cancelCallSignals(callId),
      getIceConfig: async callSignal => {
        const vault = this.callVault;
        if (!vault || !this.isRuntimeActive(epoch, session)) throw new Error('安全通话尚未就绪');
        const config = await getCallConfiguration(session.vault.roomId, session.vault.accessToken, callSignal && this.runtimeAbort ? AbortSignal.any([callSignal, this.runtimeAbort.signal]) : this.runtimeAbort?.signal);
        const verifiedPeerIds = await verifyCallIdentityAttestations(vault, config.callIdentities ?? []);
        if (!this.isRuntimeActive(epoch, session) || this.callVault !== vault) throw new Error('设备状态已更新，请重试通话');
        return { ...config, verifiedPeerIds };
      },
      onChange: state => {
        if (this.isRuntimeActive(epoch, session)) this.updateCallView(state);
      },
      onPermissionChange: active => {
        if (this.callController === controller && this.isRuntimeActive(epoch, session)) return this.setMediaPermission('camera', active);
        return false;
      },
    });
    this.callController = controller;
    // Local, read-only troubleshooting. Each call has a salted hash and at most 64 redacted events.
    (window as Window & { quietRoomCallDiagnostics?: () => unknown }).quietRoomCallDiagnostics = () =>
      this.isRuntimeActive(epoch, session) && !this.privacyCovered ? controller.diagnosticsSnapshot : null;
    controller.setConnection(this.connectionState === 'connected');
    return controller;
  }

  private async startCall(kind: CallKind): Promise<void> {
    if (this.privacyCovered || this.activeSurface !== 'chat') return;
    if (this.imageBatchUploading || this.sending.size > 0) {
      this.showNotice('请等待正在发送的文件完成后再通话');
      return;
    }
    const controller = this.ensureCallController();
    if (!controller || controller.active) return;
    this.callReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const menu = this.root.querySelector<HTMLDetailsElement>('.more-menu');
    if (menu) this.closeMoreMenu(menu);
    this.closeVoiceRecorder();
    this.voicePlayback.stop();
    await controller.start(kind);
  }

  private updateCallControls(): void {
    const vault = this.callVault;
    const ready = !this.privacyCovered && this.connectionState === 'connected' && vault?.protocol === 'mls-rfc9420' && vault.mls?.phase === 'active' &&
      vault.members.some(member => member.status === 'active' && member.role !== vault.role && member.capabilities?.includes(CALL_CAPABILITY));
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('#start-video-call, #start-audio-call')) {
      button.disabled = !ready || Boolean(this.callController?.active);
      button.title = ready ? (button.id === 'start-video-call' ? '视频通话' : '语音通话') : '双方打开最新版并连接安全会话后可通话';
    }
  }

  private updateCallView(state: CallState): void {
    if (state.phase === 'idle') {
      this.callView?.destroy();
      this.callView = null;
      this.root.inert = this.root.classList.contains('portrait-blocked');
      document.body.classList.remove('call-active');
      if (this.callReturnFocus?.isConnected) this.callReturnFocus.focus({ preventScroll: true });
      this.callReturnFocus = null;
      if (!this.desktopBrowser) this.resetIdleLock();
      this.updateCallControls();
      this.markVisibleMessagesRead();
      return;
    }
    if (!this.callView) {
      this.closeImageViewer(true);
      this.callReturnFocus ??= document.activeElement instanceof HTMLElement ? document.activeElement : null;
      this.closeVoiceRecorder();
      this.voicePlayback.stop();
      const perform = (action: () => void | Promise<void> | undefined) => { void Promise.resolve().then(action).catch(cause => this.operationalError(cause)); };
      this.callView = new CallView({
        accept: () => perform(() => this.callController?.accept()),
        decline: () => perform(() => this.callController?.decline()),
        hangup: () => perform(() => this.callController?.hangup()),
        toggleMicrophone: () => perform(() => this.callController?.toggleMicrophone()),
        toggleCamera: () => perform(() => this.callController?.toggleCamera()),
        switchCamera: () => perform(() => this.callController?.switchCamera()),
        dismiss: () => this.callController?.dismiss(),
      });
      document.body.append(this.callView.element);
    }
    this.root.inert = true;
    document.body.classList.add('call-active');
    this.callView.update(state);
    if (!this.desktopBrowser) this.resetIdleLock();
    this.updateCallControls();
  }
}
