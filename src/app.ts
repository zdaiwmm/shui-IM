import QRCode from 'qrcode';
import { closeDialog, mountDialog } from './lib/dialog';
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
import { fromBase64Url, randomBase64Url, toBase64Url } from './lib/base64';
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
import { bindVoiceRecordGesture } from './lib/voice-gesture';
import { bindImageViewerGestures } from './lib/image-viewer-gestures';
import { VoicePlayback, VoicePlayer } from './lib/voice-player';
import { CallController } from './lib/call-controller';
import { CallView } from './lib/call-view';
import { createAuthenticatedCallVault, assertAuthenticatedRoomRoster, signCallIdentityAttestation, verifyCallIdentityAttestations } from './lib/call-membership';
import { CALL_CAPABILITY, type CallKind, type CallState } from './lib/call-types';
import { voiceIcons, voiceTime } from './lib/voice-audio';
import { UnreadCounter } from './lib/unread-counter';
import { REACTION_EMOJIS, reduceMessageReactions } from './lib/reactions';
import { batchAttachmentFiles } from './lib/image-batches';
import { isVideoFile, videoMimeType } from './lib/video-media';
import { createVideoPoster } from './lib/video-poster';
import { downloadBlob } from './lib/download';
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
  type PlatformCredentialResult,
} from './lib/platform-vault';
import type {
  DecryptedMessage,
  DeliveryReceipt,
  FileManifest,
  ImageManifest,
  ImageUploadPlan,
  MessagePayload,
  ReactionEmoji,
  OutboxItem,
  ReplyReference,
  RoomMember,
  RoomState,
  ServerMessage,
  ServerReceipt,
  Vault,
} from './lib/types';
import {
  createVault,
  commitMlsReceive,
  commitMlsSend,
  deleteOutboxItem,
  deleteCurrentVault,
  downloadVaultDiagnostic,
  deletePendingReceipt,
  deleteUploadPlan,
  hasStoredVault,
  bindRecoveredVaultToPlatform,
  loadHistoryPage,
  loadHistoryPageAfter,
  loadHistoryMessage,
  loadReactionHistory,
  loadMediaHistoryPage,
  loadOutbox,
  loadPendingReceipts,
  loadUploadPlans,
  loadUiPreferences,
  migrateVaultToPlatform,
  readStoredVault,
  resumeVaultSession,
  saveOutboxItem,
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

type Invite = {
  v: 1;
  roomId: string;
  accessToken: string;
  pairingSecret: string;
  creatorFingerprint: string;
};

type DeviceInvite = {
  v: 1;
  kind: 'device-link';
  roomId: string;
  linkId: string;
  secret: string;
  role: 'creator' | 'joiner';
  authorizerId: string;
  authorizerFingerprint: string;
  creatorFingerprint: string;
  expiresAt: string;
};

const CLIENT_CAPABILITIES = ['mls-multidevice-v1', 'reply-v2', 'passkey-only-v3', 'image-album-v1', 'recovery-replace-v1', 'voice-message-v1', 'message-reactions-v1', 'file-message-v1', CALL_CAPABILITY];

type CachedImage = { blob: Blob; url: string; bytes: number; lastUsedAt: number; width?: number; height?: number; posterUrl?: string; posterPromise?: Promise<void>; posterUnavailable?: boolean };
const MAX_IMAGE_CACHE_BYTES = 96 * 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
  more: '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>',
  send: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>',
  lock: '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
  download: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M5 21h14"/></svg>',
  bell: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg>',
  reply: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m9 17-5-5 5-5"/><path d="M4 12h9a7 7 0 0 1 7 7"/></svg>',
  close: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>',
};

type GalleryAsset = { manifest: ImageManifest; clientMsgId: string; sentAt: string; assetIndex: number };
type GalleryTab = 'images' | 'files';

function formPassword(form: HTMLFormElement): string {
  return String(new FormData(form).get('password') ?? '');
}

function inviteFromHash(hash = location.hash): Invite | null {
  try {
    const encoded = new URLSearchParams(hash.replace(/^#/, '')).get('invite');
    if (!encoded) return null;
    const invite = JSON.parse(decoder.decode(fromBase64Url(encoded))) as Invite;
    if (
      invite.v !== 1 ||
      !/^[0-9a-f-]{36}$/i.test(invite.roomId) ||
      invite.accessToken.length < 32 ||
      invite.pairingSecret.length < 32 ||
      invite.creatorFingerprint.length < 32
    ) return null;
    return invite;
  } catch {
    return null;
  }
}

function inviteFromText(value: string): Invite | null {
  try {
    return inviteFromHash(new URL(value, location.href).hash);
  } catch {
    return null;
  }
}

function makeInviteUrl(invite: Invite): string {
  const encoded = toBase64Url(encoder.encode(JSON.stringify(invite)));
  return `${location.origin}${location.pathname}#invite=${encoded}`;
}

function deviceInviteFromHash(hash = location.hash): DeviceInvite | null {
  try {
    const encoded = new URLSearchParams(hash.replace(/^#/, '')).get('device');
    if (!encoded) return null;
    const invite = JSON.parse(decoder.decode(fromBase64Url(encoded))) as DeviceInvite;
    if (
      invite.v !== 1 ||
      invite.kind !== 'device-link' ||
      !/^[0-9a-f-]{36}$/i.test(invite.roomId) ||
      !/^[0-9a-f-]{36}$/i.test(invite.linkId) ||
      !/^[0-9a-f-]{36}$/i.test(invite.authorizerId) ||
      invite.secret.length < 32 ||
      !['creator', 'joiner'].includes(invite.role) ||
      invite.authorizerFingerprint.length < 32 ||
      invite.creatorFingerprint.length < 32 ||
      !Number.isFinite(Date.parse(invite.expiresAt))
    ) return null;
    return invite;
  } catch {
    return null;
  }
}

function makeDeviceInviteUrl(invite: DeviceInvite): string {
  return `${location.origin}${location.pathname}#device=${toBase64Url(encoder.encode(JSON.stringify(invite)))}`;
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
  // Memory only. Cover teardown still clears media, rendered history and sockets.
  private retainedSession: VaultSession | null = null;
  private coverEntryEpoch = 0;
  private idleDeadline = 0;
  private idleMonotonicDeadline = 0;
  private socket: RoomSocket | null = null;
  private messages = new Map<number, DecryptedMessage>();
  private reactionHistory = new Map<number, DecryptedMessage>();
  private selectedMessageId: string | null = null;
  private privacyCurtain: HTMLElement;
  private unreadCounter: UnreadCounter;
  private pending = new Map<string, DecryptedMessage>();
  private outbox = new Map<string, OutboxItem>();
  private pendingReceipts = new Map<string, DeliveryReceipt>();
  private serverQueue = new Map<number, ServerMessage>();
  private receiptQueue = new Map<number, ServerReceipt>();
  private uploadPlans: ImageUploadPlan[] = [];
  private imageCache = new Map<string, CachedImage>();
  private imageLoadPromises = new Map<string, Promise<CachedImage>>();
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
  private idleTimer: number | null = null;
  private blurLockTimer: number | null = null;
  private sendingTextDrafts = new Set<string>();
  private chatPinnedToBottom = true;
  private chatViewportTop = 0;
  private chatViewportHeight = 0;
  private chatBottomFollowPending = false;
  private chatViewportFollowUntil = 0;
  private chatLastScrollY = 0;
  private chatResumeBottomOnFocus = false;
  private chatScrollFrame: number | null = null;
  private chatMessageAnimations = new Set<Animation>();
  private syncViewport: () => void = () => {};
  private trackChatViewport: (follow?: boolean) => void = () => {};
  private syncChatLayout: () => void = () => {};
  private cancelViewportWork: () => void = () => {};
  private chatLayoutGeneration = 0;
  private chatLayoutElements: {
    shell: HTMLElement;
    list: HTMLElement;
    header: HTMLElement;
    composer: HTMLElement;
    notices: HTMLElement;
    notice: HTMLElement;
  } | null = null;
  private chatScrollIntent: 'up' | 'down' | null = null;
  private chatRestoreAnchor: ChatScrollAnchor | null = null;
  private sendChain: Promise<void> = Promise.resolve();
  private membershipChain: Promise<void> = Promise.resolve();
  private sending = new Set<string>();
  private retryTimers = new Map<string, number>();
  private retryCounts = new Map<string, number>();
  private renderedMessages = new Map<string, { payload: MessagePayload; status: DecryptedMessage['status']; acceptedAt: string; element: HTMLElement }>();
  private renderedMessageOrder: HTMLElement[] = [];
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
  private deferredImageUpload: { roomId: string; deviceId: string; files: File[]; destination: 'chat' | 'gallery' } | null = null;
  private unlocking = false;
  private deviceVerificationActive = false;
  private systemSurfaceTokens = new Set<symbol>();
  private deviceVerificationToken: symbol | null = null;
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
  private composerSelection: { start: number; end: number } | null = null;
  private noticeTimer: number | null = null;
  private noticeRemovalTimer: number | null = null;
  private pageTransitionTimer: number | null = null;
  private preferenceSaveTimer: number | null = null;
  private preferenceSaveChain: Promise<void> = Promise.resolve();
  private uiPreferences: UiPreferences = {};
  private restoreChatAnchorOnNextRender = true;
  private galleryScrollTop: Record<GalleryTab, number> = { images: 0, files: 0 };
  private galleryRevealedAssets = new Set<string>();
  private chatRevealedAssets = new Set<string>();
  private galleryKnownCounts: Partial<Record<GalleryTab, { keys: Set<string>; complete: boolean }>> = {};
  private chatLayoutObserver: ResizeObserver | null = null;
  private presenceRefreshTimer: number | null = null;
  private recoveryPollTimer: number | null = null;
  private backupTimer: number | null = null;
  private backupRun: Promise<void> | null = null;
  private backupError = '';
  private roleLastSeen: { creator: number | null; joiner: number | null } = { creator: null, joiner: null };
  private viewerMediaCleanup: (() => void) | null = null;
  private viewerGestureCleanup: (() => void) | null = null;
  private viewerKeyHandler: ((event: KeyboardEvent) => void) | null = null;
  private viewerReturnFocus: HTMLElement | null = null;
  private viewerPreviousSurface: 'away' | 'chat' = 'away';
  private replyTarget: DecryptedMessage | null = null;
  private messageHoldTimer: number | null = null;
  private messageHoldStart: { x: number; y: number } | null = null;
  private suppressMediaClickUntil = 0;
  private messageHighlightTimer: number | null = null;
  private replyJumpVersion = 0;
  private voiceRecorder: VoiceRecorder | null = null;
  private voiceGesture: ReturnType<typeof bindVoiceRecordGesture> | null = null;
  private microphonePromptActive = false;
  private voicePlayback = new VoicePlayback();
  private callController: CallController | null = null;
  private callVault: Vault | null = null;
  private callView: CallView | null = null;
  private callPermissionActive = false;
  private callReturnFocus: HTMLElement | null = null;

  constructor(private readonly root: HTMLElement) {
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
    window.setInterval(refreshUnread, 15_000);
    window.addEventListener('online', refreshUnread);
    const isNativeVideo = (event: Event) => event.target instanceof HTMLVideoElement
      || document.fullscreenElement instanceof HTMLVideoElement;
    const preventZoom = (event: Event) => { if (!isNativeVideo(event)) event.preventDefault(); };
    let viewportFrame: number | null = null;
    let trackingFrame: number | null = null;
    let trackingUntil = 0;
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
      this.chatViewportTop = viewportTop;
      this.chatViewportHeight = viewportHeight;
      const chat = this.activeSurface === 'chat' && this.chatLayoutElements?.shell.isConnected ? this.chatLayoutElements : null;
      const chatGeneration = chat ? this.chatLayoutGeneration : 0;
      const resized = previousViewportHeight !== viewportHeight || previousLayoutHeight !== layoutHeight;
      const followBottom = this.chatPinnedToBottom && this.chatScrollIntent !== 'up';
      const widthChanged = previousViewportWidth !== viewportWidth;
      if (!resized && !widthChanged && previousViewportTop === viewportTop && previousChatGeneration === chatGeneration) return;
      const setStyle = (style: CSSStyleDeclaration, property: string, value: string) => {
        if (style.getPropertyValue(property) !== value) style.setProperty(property, value);
      };
      const keyboardOpen = String(keyboardSpace > 120);
      const keyboardChanged = document.documentElement.dataset.keyboardOpen !== keyboardOpen;
      if (keyboardChanged) document.documentElement.dataset.keyboardOpen = keyboardOpen;
      // Keep frame-by-frame position updates local to the four floating
      // controls. Inherited root variables invalidate every historical row.
      if (chat) {
        setStyle(chat.header.style, 'translate', `0 ${viewportTop}px`);
        setStyle(chat.composer.style, 'translate', `0 calc(${viewportTop + viewportHeight}px - 100%)`);
        setStyle(chat.notices.style, 'translate', `0 ${viewportTop}px`);
        setStyle(chat.notice.style, 'translate', `0 calc(${viewportTop + viewportHeight}px - var(--chat-bottom-space) - 100%)`);
        setStyle(chat.list.style, 'padding-bottom', `calc(var(--chat-bottom-space) + ${keyboardSpace}px)`);
        // Short conversations need the same scrollable keyboard space as long
        // ones. flex-end keeps their latest row attached to the composer too.
        setStyle(chat.list.style, 'min-height', `${Math.max(layoutHeight, viewportHeight) + keyboardSpace}px`);
        const openMenu = chat.header.querySelector<HTMLDetailsElement>('.more-menu[open]');
        if (openMenu) setStyle(openMenu.style, '--app-height', `${viewportHeight}px`);
      } else {
        setStyle(document.documentElement.style, '--app-height', `${viewportHeight}px`);
        setStyle(document.documentElement.style, '--app-top', `${viewportTop}px`);
      }
      previousViewportHeight = viewportHeight;
      previousLayoutHeight = layoutHeight;
      previousViewportTop = viewportTop;
      previousViewportWidth = viewportWidth;
      previousChatGeneration = chatGeneration;
      if (chat) {
        // Apply safe-area/composer-height changes before aligning messages,
        // in the same event as the controls instead of a later animation frame.
        // ResizeObserver owns actual control-size changes. Geometry-only
        // toolbar frames should not force three control layout measurements.
        if (widthChanged || keyboardChanged) this.syncChatLayout();
        if (resized && followBottom) this.scrollChatToBottom();
        if (resized) this.trackChatViewport(followBottom && !this.desktopBrowser);
      }
      viewportWidthChanged ||= widthChanged;
      if (viewportFrame === null) viewportFrame = requestAnimationFrame(finishViewportSync);
    };
    this.syncViewport = syncVisualViewport;
    const sampleViewport = () => {
      trackingFrame = null;
      if (this.privacyCovered || this.activeSurface !== 'chat' || !this.chatLayoutElements?.shell.isConnected) return;
      syncVisualViewport();
      if (this.chatBottomFollowPending && this.chatScrollIntent !== 'up') this.alignChatBottom();
      if (performance.now() >= trackingUntil) {
        this.chatBottomFollowPending = false;
        this.chatViewportFollowUntil = 0;
      }
      // Safari can withhold viewport events during native toolbar movement.
      // Keep this cheap geometry sample alive while chat is visible; unchanged
      // samples return before reading messages or writing any styles.
      if (trackingFrame === null) trackingFrame = requestAnimationFrame(sampleViewport);
    };
    this.trackChatViewport = (follow = false) => {
      if (this.privacyCovered || this.activeSurface !== 'chat' || !this.chatLayoutElements?.shell.isConnected) return;
      // Following browser focus scrolls is bounded. Position sampling itself
      // continues until chat is left or privacy teardown cancels this frame.
      trackingUntil = performance.now() + 900;
      if (follow) this.chatViewportFollowUntil = trackingUntil;
      if (trackingFrame === null) trackingFrame = requestAnimationFrame(sampleViewport);
    };
    this.cancelViewportWork = () => {
      this.cancelChatMessageMotion();
      if (viewportFrame !== null) cancelAnimationFrame(viewportFrame);
      if (trackingFrame !== null) cancelAnimationFrame(trackingFrame);
      viewportFrame = null;
      trackingFrame = null;
      trackingUntil = 0;
      viewportWidthChanged = false;
      this.chatBottomFollowPending = false;
      this.chatViewportFollowUntil = 0;
      this.chatResumeBottomOnFocus = false;
    };
    syncVisualViewport();
    window.visualViewport?.addEventListener('resize', syncVisualViewport, { passive: true });
    window.visualViewport?.addEventListener('scroll', syncVisualViewport, { passive: true });
    window.visualViewport?.addEventListener('scrollend', syncVisualViewport, { passive: true });
    window.addEventListener('resize', syncVisualViewport, { passive: true });
    window.addEventListener('scroll', () => {
      // WebKit may defer visualViewport.scroll until a gesture ends, while
      // window.scroll already exposes the new viewport position.
      syncVisualViewport();
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
      // A pointer can arrive after native focus has already left the field.
      // Suspend on the history gesture itself, before the keyboard resize.
      if (event.target instanceof Element && this.root.contains(event.target) && event.target.closest('#message-list') && document.documentElement.dataset.keyboardOpen === 'true') {
        this.chatResumeBottomOnFocus = this.chatPinnedToBottom && this.chatBottomGap() <= 2;
        this.chatRestoreAnchor = null;
        this.chatScrollIntent = 'up';
        this.chatPinnedToBottom = false;
        this.chatBottomFollowPending = false;
        this.chatViewportFollowUntil = 0;
      }
      if (
        textarea && document.activeElement === textarea && composer &&
        event.target instanceof Node && !composer.contains(event.target)
      ) {
        this.keepComposerKeyboard = false;
        textarea.blur();
      }
      const selecting = this.selectedMessageId && this.root.querySelector<HTMLElement>(`.message[data-client-msg-id="${CSS.escape(this.selectedMessageId)}"]`);
      if (selecting && event.target instanceof Node && !selecting.contains(event.target)) this.clearMessageTextSelection();
      const messageActions = this.root.querySelector<HTMLElement>('.message-actions');
      if (messageActions && event.target instanceof Node && !messageActions.contains(event.target)) this.closeMessageActions();
    }, { capture: true, passive: true });
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
      if (document.hidden) this.coverEntryEpoch += 1;
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
      this.coverEntryEpoch += 1;
      this.cancelCoverTimer();
      this.obscurePrivacySurface();
      if (this.deviceVerificationActive) return;
      // Native sheets are an actual departure from the private surface. Keep
      // their pending file selection, but never the unlocked conversation.
      if (this.imagePickerActive || this.filePickerActive || this.fileExportActive || this.microphonePromptActive || this.callPermissionActive || this.systemSurfaceTokens.size > 0) {
        this.lockNow({ preserveFilePicker: this.filePickerActive || this.imagePickerActive });
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
      if (this.blurLockTimer !== null) window.clearTimeout(this.blurLockTimer);
      this.blurLockTimer = null;
      this.finishFileExport();
      this.expireIdleSession();
      this.revealPrivacySurface();
      refreshUnread();
    }, { capture: true });
    document.addEventListener('freeze', () => this.lockNow(), { capture: true });
    window.addEventListener('pageshow', event => {
      if (event.persisted) this.lockNow();
      refreshUnread();
    }, { capture: true });
    window.addEventListener('pagehide', () => {
      this.finishImagePicker();
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
    this.obscurePrivacySurface();
    const retained = retainSession ? this.session : null;
    const deadline = this.idleDeadline;
    const monotonicDeadline = this.idleMonotonicDeadline;
    const picker = preserveFilePicker ? this.imagePickerInput : null;
    // Keep the same input connected while the native chooser owns it.
    if (picker) document.body.append(picker);
    this.setActiveSurface('away');
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
    const begin = () => this.beginCoverHold(1000);
    const cancel = () => this.cancelCoverTimer();
    trigger.addEventListener('pointerdown', begin);
    trigger.addEventListener('pointerup', cancel);
    trigger.addEventListener('pointercancel', cancel);
    trigger.addEventListener('pointerleave', cancel);
    trigger.addEventListener('keydown', (event) => {
      if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) begin();
    });
    trigger.addEventListener('keyup', cancel);
  }

  private beginCoverHold(duration: number): void {
    if (!this.privacyCovered || document.hidden || !document.hasFocus()) return;
    this.cancelCoverTimer();
    this.root.querySelector('.cover-trigger')?.classList.add('is-holding');
    this.coverTimer = window.setTimeout(() => {
      this.cancelCoverTimer();
      if (!this.privacyCovered || document.hidden || !document.hasFocus()) return;
      navigator.vibrate?.(20);
      void this.renderGateway();
    }, duration);
  }

  private cancelCoverTimer(): void {
    if (this.coverTimer !== null) window.clearTimeout(this.coverTimer);
    this.coverTimer = null;
    this.root.querySelector('.cover-trigger')?.classList.remove('is-holding');
  }

  private async renderGateway(): Promise<void> {
    this.cancelCoverTimer();
    this.expireIdleSession();
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
          document.hidden || !document.hasFocus()) return;
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
    const hasVault = await hasStoredVault();
    if (this.privacyCovered) return;
    if (hasVault) {
      const stored = await readStoredVault();
      if (!stored) this.renderCorruptVault();
      else void this.renderUnlock();
    }
    else {
      const deviceInvite = deviceInviteFromHash();
      if (deviceInvite) this.renderJoinDevice(deviceInvite);
      else this.renderFirstRun(inviteFromHash());
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

  private async renderUnlock(): Promise<void> {
    const stored = await readStoredVault();
    if (this.privacyCovered) return;
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
          if (this.privacyCovered) return;
          this.session = unlocked;
          this.renderPlatformMigration();
        } catch (cause) {
          secret = '';
          if (!this.privacyCovered) {
            error.textContent = cause instanceof Error ? cause.message : '无法解锁';
            setBusy(button, false);
          }
        } finally {
          this.unlocking = false;
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
            const unlocked = await this.withDeviceVerification(() => unlockVault(secret));
            secret = '';
            if (this.privacyCovered) return;
            this.session = unlocked;
            if (unlocked.stored.v === 1) this.renderPlatformMigration();
            else await this.openSession();
          } catch (cause) {
            secret = '';
            if (!this.privacyCovered) {
              error.textContent = cause instanceof Error ? cause.message : '无法解锁';
              instruction.textContent = '请重新绘制手势。';
            }
          } finally {
            this.unlocking = false;
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
      button.addEventListener('click', () => {
        if (this.unlocking) return;
        this.unlocking = true;
        error.textContent = '';
        setBusy(button, true, '正在验证…');
        void (async () => {
          try {
            const unlocked = await this.withDeviceVerification(() => unlockVault());
            if (this.privacyCovered) return;
            this.session = unlocked;
            await this.openSession();
          } catch (cause) {
            if (!this.privacyCovered) error.textContent = cause instanceof Error ? cause.message : '无法解锁';
          } finally {
            this.unlocking = false;
            if (button.isConnected) setBusy(button, false);
          }
        })();
      });
      button.click();
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
        if (this.privacyCovered) return;
        this.session = unlocked;
        this.renderRecoveredVaultBinding();
      } catch (cause) {
        recoveryCode = '';
        if (!this.privacyCovered) {
          error.textContent = cause instanceof Error ? cause.message : '恢复码验证失败';
          setBusy(button, false);
        }
      } finally {
        this.unlocking = false;
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
          preparedPlatformCredential ??= await this.withDeviceVerification(() => createPlatformCredential());
          if (!active()) return;
          setBusy(verifyButton, true, busyLabel);
          await onConfirmed(preparedPlatformCredential);
        } catch (cause) {
          if (!active()) return;
          error.textContent = cause instanceof Error ? cause.message : '通行密钥设置失败';
          if (preparedPlatformCredential) verifyButton.dataset.label = '重试';
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

  private async withDeviceVerification<T>(operation: () => Promise<T>): Promise<T> {
    // Recovery/migration have decrypted key material but have not opened a
    // conversation or socket. Their native prompt needs the same bounded
    // protection as first-time enrollment. Never exempt an open conversation.
    if (this.session && (!this.root.querySelector('.gateway') || this.socket)) return operation();
    const epoch = this.runtimeEpoch;
    const token = Symbol('device-verification');
    this.deviceVerificationToken = token;
    this.deviceVerificationActive = true;
    const timer = window.setTimeout(() => {
      if (this.deviceVerificationToken !== token) return;
      this.deviceVerificationToken = null;
      this.deviceVerificationActive = false;
      this.lockNow({ preserveFilePicker: false });
    }, 65_000);
    try {
      const result = await operation();
      if (this.deviceVerificationToken !== token || this.runtimeEpoch !== epoch || this.privacyCovered) {
        throw new DOMException('设备验证流程已经结束', 'AbortError');
      }
      return result;
    } finally {
      window.clearTimeout(timer);
      if (this.deviceVerificationToken === token) {
        this.deviceVerificationToken = null;
        this.deviceVerificationActive = false;
        if (document.hidden) this.lockNow({ preserveFilePicker: false });
        else if (document.hasFocus()) this.revealPrivacySurface();
      }
    }
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
      const invite = inviteFromText(String(new FormData(form).get('invite') ?? ''));
      if (!invite) {
        const input = form.querySelector<HTMLTextAreaElement>('#invite-input')!;
        input.setAttribute('aria-invalid', 'true');
        form.querySelector<HTMLElement>('#invite-error')!.textContent = '邀请链接无法识别';
        input.focus();
        return;
      }
      form.querySelector<HTMLTextAreaElement>('#invite-input')?.removeAttribute('aria-invalid');
      this.transitionPage('forward', () => this.renderJoin(invite));
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
      if (initialState.members.length !== 1) throw new Error('该邀请已被另一位参与者使用');
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
      throw new Error('这个设备链接已经失效或已被使用');
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
    const preferences = await loadUiPreferences(session).catch(() => ({}));
    if (!this.isRuntimeActive(epoch, session)) return;
    this.uiPreferences = preferences;
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
    while (historyHasMore && !page.some(message => message.payload.kind !== 'gallery-image' && message.payload.kind !== 'gallery-file' && message.payload.kind !== 'reaction')) {
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
    const [outbox, pendingReceipts, uploadPlans] = await Promise.all([
      loadOutbox(session),
      loadPendingReceipts(session),
      loadUploadPlans(session),
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
    // Replies and reactions may refer to a message outside the initial 200-row
    // window. Rebuild only the encrypted reaction history without delaying chat.
    void loadReactionHistory(session, { signal: this.runtimeAbort.signal }).then(reactions => {
      if (!this.isRuntimeActive(epoch, session)) return;
      this.reactionHistory = new Map(reactions.map(message => [message.seq, message]));
      this.renderMessages();
    }).catch(cause => {
      if (this.isRuntimeActive(epoch, session)) this.operationalError(cause, '部分历史表情回应暂时无法读取');
    });
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
    this.setActiveSurface('away');
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
        callState: (event) => {
          if (this.isRuntimeActive(epoch, session) && this.socket === roomSocket) this.callController?.serverEvent(event);
        },
        message: (message) => {
          if (!this.isRuntimeActive(epoch, session) || this.socket !== roomSocket) return;
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
        ack: (clientMsgId) => {
          if (!this.isRuntimeActive(epoch, session) || this.socket !== roomSocket) return;
          this.clearRetry(clientMsgId);
          const item = this.pending.get(clientMsgId);
          if (item) item.status = 'stored';
          this.renderMessages();
          roomSocket.requestSync(session.vault.lastSeq);
          if (this.outbox.has(clientMsgId)) this.scheduleRetry(clientMsgId);
        },
        receiptAck: (clientMsgId) => {
          if (this.isRuntimeActive(epoch, session) && this.socket === roomSocket) void this.acknowledgeReceipt(clientMsgId);
        },
        error: async (message, code, clientMsgId) => {
          if (!this.isRuntimeActive(epoch, session) || this.socket !== roomSocket) return;
          if (code === 'MLS_EPOCH_STALE' && clientMsgId) {
            try {
              await this.reencryptOutboxItem(clientMsgId);
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
    roomSocket.setChatPresence(this.activeSurface === 'chat');
    roomSocket.connect();
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
      this.renderMessages();
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
        const message = this.messages.get(receipt.seq);
        const sender = message ? this.memberForMessage(message) : undefined;
        const receiver = session.vault.members.find((member) => member.deviceId === receipt.receiverId);
        if (!message) {
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
    this.setActiveSurface('away');
    document.body.className = 'app-mode';
    const invite: Invite = {
      v: 1,
      roomId: this.session.vault.roomId,
      accessToken: this.session.vault.inviteToken ?? this.session.vault.accessToken,
      pairingSecret: this.session.vault.pairingSecret,
      creatorFingerprint: this.session.vault.creatorFingerprint,
    };
    const inviteUrl = makeInviteUrl(invite);
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

  private renderChat(): void {
    if (!this.session) return;
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
    this.renderedMessageSeq.clear();
    document.body.className = 'app-mode';
    this.root.innerHTML = `
      <section class="chat-shell">
        <header class="chat-header">
          <nav class="call-actions" aria-label="发起通话">
            <button class="icon-button" id="start-video-call" type="button" aria-label="发起视频通话" title="视频通话" disabled>${icons.video}</button>
            <button class="icon-button" id="start-audio-call" type="button" aria-label="发起语音通话" title="语音通话" disabled>${icons.phone}</button>
          </nav>
          <div class="peer-summary" role="status" aria-live="polite">
            <div class="presence-heading">
              <span class="presence-row" id="self-presence"><span>我</span><i class="presence-dot" aria-hidden="true"></i><strong class="sr-only">同步中</strong></span>
              <span class="presence-row" id="peer-presence"><span>对方</span><i class="presence-dot" aria-hidden="true"></i></span>
            </div>
            <strong class="peer-status">同步中</strong>
          </div>
          <nav class="header-actions" aria-label="会话操作">
            ${this.session.vault.role === 'creator' ? `
              <button class="icon-button gallery-button" id="open-gallery" type="button" aria-label="查看保险箱" title="保险箱">${icons.safe}</button>
            ` : ''}
            <details class="more-menu">
              <summary class="icon-button" aria-label="更多操作">${icons.more}</summary>
              <div class="menu-panel">
                <p class="menu-title">本机安全</p>
                <p class="protocol-label">${this.session.vault.protocol === 'mls-rfc9420' ? '端到端加密' : '旧版会话，建议重新建立'}</p>
                <p class="safety-label">设备安全码</p>
                <code class="safety-code" id="safety-code">正在计算…</code>
                <button id="manage-devices" type="button">${icons.lock}<span>设备管理</span></button>
                <button id="backup-settings" type="button">${icons.download}<span>备份与恢复</span></button>
                <p class="menu-footnote">新设备只能查看加入后的消息。</p>
              </div>
            </details>
          </nav>
        </header>
        <div class="system-notices" aria-label="本机安全提醒">
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
            </aside>
          ` : ''}
        </div>
        <div class="notice" id="notice" role="status" hidden></div>
        <section class="message-list" id="message-list" aria-label="聊天消息"></section>
        <form class="composer" id="composer" autocomplete="off">
          <div class="reply-draft" id="reply-draft" hidden>
            <div><strong>回复对方</strong><span></span></div>
            <button type="button" aria-label="取消回复">${icons.close}</button>
          </div>
          <button class="image-picker icon-button${cryptoReady ? '' : ' is-disabled'}" id="open-image-picker" type="button" aria-label="发送照片、视频或文件" title="发送照片、视频或文件" ${cryptoReady ? '' : 'disabled'}>${icons.image}</button>
          <input id="image-input" type="file" multiple ${cryptoReady ? '' : 'disabled'} hidden />
          <div class="composer-field">
            <label class="sr-only" for="message-input">输入消息</label>
            <textarea id="message-input" rows="1" maxlength="4000" placeholder="${cryptoReady ? '输入消息' : '正在建立安全会话…'}" autocomplete="off" enterkeyhint="send" ${cryptoReady ? '' : 'disabled'}></textarea>
          </div>
          <button class="icon-button voice-record-button" id="record-voice" type="button" aria-label="录制语音消息" aria-description="长按录音，松手发送；向左滑动可取消。点按可免手持录音。" title="长按录音，松手发送" ${cryptoReady ? '' : 'disabled'}>${voiceIcons.mic}</button>
          <button class="send-button" type="submit" aria-label="发送消息" ${cryptoReady ? '' : 'disabled'} hidden>${icons.send}</button>
          <section class="voice-recorder" aria-label="录制语音消息" hidden></section>
          <div class="upload-progress" id="upload-progress" hidden><span></span><output></output></div>
        </form>
      </section>
    `;
    this.mountChatLayout();
    this.root.querySelector('#composer')?.addEventListener('submit', (event) => void this.handleSendText(event));
    const list = this.root.querySelector<HTMLElement>('#message-list')!;
    this.mountChatImageConcealGesture(list);
    const scrollIntent = (direction: 'up' | 'down') => {
      this.cancelChatMessageMotion();
      this.chatResumeBottomOnFocus = false;
      this.chatRestoreAnchor = null;
      this.chatScrollIntent = direction;
      if (direction === 'up') {
        this.chatPinnedToBottom = false;
        this.chatBottomFollowPending = false;
        this.chatViewportFollowUntil = 0;
      }
      else if (this.chatBottomGap() <= 2) this.chatPinnedToBottom = true;
    };
    let touchY: number | null = null;
    list.addEventListener('touchstart', event => {
      touchY = event.touches[0]?.clientY ?? null;
      this.trackChatViewport();
    }, { passive: true });
    list.addEventListener('touchmove', event => {
      const y = event.touches[0]?.clientY;
      if (touchY !== null && y !== undefined && Math.abs(y - touchY) > 2) {
        scrollIntent(y > touchY ? 'up' : 'down');
        touchY = y;
      }
      this.trackChatViewport();
    }, { passive: true });
    list.addEventListener('touchend', () => this.trackChatViewport(), { passive: true });
    list.addEventListener('wheel', event => {
      if (event.deltaY) scrollIntent(event.deltaY < 0 ? 'up' : 'down');
      this.trackChatViewport();
    }, { passive: true });
    list.addEventListener('pointerdown', () => { this.chatRestoreAnchor = null; }, { passive: true });
    list.addEventListener('keydown', event => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) scrollIntent('up');
      else if (['ArrowDown', 'PageDown', 'End', ' '].includes(event.key)) scrollIntent('down');
    }, { passive: true });
    const textarea = this.root.querySelector<HTMLTextAreaElement>('#message-input')!;
    const trackKeyboard = () => this.trackChatViewport(!this.desktopBrowser && this.chatPinnedToBottom && this.chatScrollIntent !== 'up');
    const beginKeyboard = () => {
      // A tap in history cancels follow before blur to protect a possible drag.
      // On the next focus, resume a bottom reader who only dismissed the
      // keyboard. An actual touch/wheel/key scroll clears this saved intent.
      if (!this.chatRestoreAnchor && (this.chatResumeBottomOnFocus || this.chatBottomGap() <= 2)) {
        this.scrollChatToBottom();
      }
      this.chatResumeBottomOnFocus = false;
      trackKeyboard();
    };
    textarea.addEventListener('pointerdown', beginKeyboard, { passive: true });
    textarea.addEventListener('focus', beginKeyboard);
    textarea.addEventListener('paste', event => this.handleComposerPaste(event));
    textarea.addEventListener('input', () => {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 128)}px`;
      this.uiPreferences.composerDraft = textarea.value;
      this.scheduleUiPreferencesSave();
      this.syncComposerMode();
    });
    textarea.value = this.uiPreferences.composerDraft ?? '';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 128)}px`;
    this.syncComposerMode();
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.root.querySelector<HTMLFormElement>('#composer')?.requestSubmit();
      }
    });
    textarea.addEventListener('blur', () => {
      if (!this.imagePickerActive) this.keepComposerKeyboard = false;
      trackKeyboard();
    });
    const imageInput = this.root.querySelector<HTMLInputElement>('#image-input');
    this.voiceGesture?.destroy();
    this.voiceGesture = bindVoiceRecordGesture(this.root.querySelector<HTMLButtonElement>('#record-voice')!, mode => this.beginVoiceRecording(mode));
    this.root.querySelector('#start-video-call')?.addEventListener('click', () => void this.startCall('video'));
    this.root.querySelector('#start-audio-call')?.addEventListener('click', () => void this.startCall('audio'));
    const sendButton = this.root.querySelector<HTMLButtonElement>('.send-button');
    sendButton?.addEventListener('pointerdown', (event) => this.retainComposerKeyboard(event, textarea));
    this.mountImagePicker(imageInput, 'chat', this.root.querySelector<HTMLButtonElement>('#open-image-picker'));
    this.root.querySelector('#open-gallery')?.addEventListener('click', () => this.transitionPage('forward', () => this.renderGallery()));
    this.root.querySelector('#backup-settings')?.addEventListener('click', () => this.transitionPage('forward', () => this.renderBackupSettings()));
    this.root.querySelector('#reminder-export')?.addEventListener('click', () => this.transitionPage('forward', () => this.renderBackupSettings()));
    this.root.querySelector('#dismiss-recovery')?.addEventListener('click', () => {
      this.uiPreferences.recoveryReminderDismissed = true;
      this.flushUiPreferencesSave();
      this.root.querySelector('.recovery-reminder')?.remove();
    });
    this.root.querySelector('#manage-devices')?.addEventListener('click', () => this.transitionPage('forward', () => void this.renderDeviceManager()));
    this.root.querySelector('#reply-draft button')?.addEventListener('click', () => {
      this.replyTarget = null;
      this.renderReplyDraft();
      this.restoreComposerFocus();
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
    void this.updateSafetyCode();
    void this.updateBackgroundNotificationControl();
  }

  private mountChatLayout(): void {
    this.cancelViewportWork();
    this.chatLayoutObserver?.disconnect();
    const shell = this.root.querySelector<HTMLElement>('.chat-shell')!;
    const list = shell.querySelector<HTMLElement>('#message-list')!;
    const header = shell.querySelector<HTMLElement>('.chat-header')!;
    const notices = shell.querySelector<HTMLElement>('.system-notices')!;
    const composer = shell.querySelector<HTMLElement>('.composer')!;
    const notice = shell.querySelector<HTMLElement>('#notice')!;
    this.chatLayoutElements = { shell, list, header, composer, notices, notice };
    this.chatLayoutGeneration += 1;
    let previousMeasurements = '';
    const sync = () => {
      if (!shell.isConnected) return;
      const measurements = `${header.offsetHeight}:${notices.offsetHeight}:${composer.offsetHeight}`;
      if (measurements === previousMeasurements) return;
      previousMeasurements = measurements;
      const pinned = this.chatPinnedToBottom;
      const anchor = this.captureChatAnchor();
      shell.style.setProperty('--chat-header-height', `${header.offsetHeight}px`);
      shell.style.setProperty('--chat-top-space', `${header.offsetHeight + notices.offsetHeight + 14}px`);
      shell.style.setProperty('--chat-bottom-space', `${composer.offsetHeight + 16}px`);
      document.documentElement.style.setProperty('--chat-top-space', `${header.offsetHeight + notices.offsetHeight + 14}px`);
      document.documentElement.style.setProperty('--chat-bottom-space', `${composer.offsetHeight + 16}px`);
      if (pinned) this.scrollChatToBottom();
      else if (anchor) this.restoreChatAnchor(list, anchor);
    };
    this.syncChatLayout = sync;
    this.syncViewport();
    sync();
    this.trackChatViewport();
    this.chatLayoutObserver = new ResizeObserver(sync);
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
    }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 160);
  }

  private async renderDeviceManager(): Promise<void> {
    const session = this.session;
    if (!session || this.privacyCovered) return;
    this.setActiveSurface('away');
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
        await this.withSystemSurface(() => navigator.clipboard.writeText(url));
        if (!this.isRuntimeActive(epoch, session) || !sheet.isConnected) return;
        button.textContent = '已复制';
      } catch {
        if (!this.isRuntimeActive(epoch, session) || !sheet.isConnected) return;
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
    if (this.privacyCovered || this.root.dataset.pageTransition === 'leaving') return;
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
    const epoch = this.runtimeEpoch;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const enter = () => {
      this.pageTransitionTimer = null;
      if (this.privacyCovered || this.runtimeEpoch !== epoch) return;
      delete this.root.dataset.pageTransition;
      render();
      this.root.dataset.pageTransition = direction;
      this.pageTransitionTimer = window.setTimeout(() => {
        delete this.root.dataset.pageTransition;
        this.pageTransitionTimer = null;
      }, reduced ? 0 : 180);
    };
    if (reduced) enter();
    else {
      this.root.dataset.pageTransition = 'leaving';
      this.pageTransitionTimer = window.setTimeout(enter, 120);
    }
  }

  private markVisibleMessagesRead(): void {
    const session = this.session;
    const list = this.root.querySelector<HTMLElement>('#message-list');
    if (!session || this.privacyCovered || document.hidden || document.documentElement.classList.contains('privacy-obscured')
      || this.activeSurface !== 'chat' || this.callView || !list || this.chatRestoreAnchor) return;
    const top = this.root.querySelector('.chat-header')?.getBoundingClientRect().bottom ?? list.getBoundingClientRect().top;
    const bottom = this.root.querySelector('#composer')?.getBoundingClientRect().top ?? list.getBoundingClientRect().bottom;
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
        if (candidate < Number.MAX_SAFE_INTEGER) seq = Math.max(seq, candidate);
      }
    }
    if (seq > 0) void this.unreadCounter.markRead(session.vault, seq, this.runtimeAbort?.signal);
  }

  private setActiveSurface(surface: 'away' | 'chat'): void {
    this.stopViewerMedia();
    if (surface === 'away') {
      this.cancelViewportWork();
      this.closeVoiceRecorder();
      this.voicePlayback.stop();
    }
    if (surface === 'chat' && this.activeSurface !== 'chat') this.rolePresence = null;
    this.activeSurface = surface;
    this.socket?.setChatPresence(surface === 'chat');
    this.syncViewport();
    // Viewer dismissal reuses the same chat DOM and viewport geometry. Resume
    // sampling explicitly even when syncViewport has no resize work to do.
    if (surface === 'chat') this.trackChatViewport();
  }

  private scheduleChatScroll(): void {
    if (this.chatScrollFrame !== null || this.privacyCovered || this.activeSurface !== 'chat') return;
    this.chatScrollFrame = requestAnimationFrame(() => {
      this.chatScrollFrame = null;
      const list = this.chatLayoutElements?.list;
      if (!list?.isConnected || this.privacyCovered || this.activeSurface !== 'chat') return;
      const documentMoved = Math.abs(window.scrollY - this.chatLastScrollY) > 1;
      this.chatLastScrollY = window.scrollY;
      const gap = this.chatBottomGap();
      // Native focus scrolling can land after the final viewport event. Retry
      // that displacement too, without turning offset-only viewport pans into
      // document scrolls or overriding a user's history gesture.
      if (documentMoved && this.chatPinnedToBottom && this.chatScrollIntent !== 'up'
        && performance.now() < this.chatViewportFollowUntil
        && Math.abs(this.chatBottomScrollTop() - window.scrollY) > 2) {
        this.chatBottomFollowPending = true;
        this.trackChatViewport();
      }
      this.chatPinnedToBottom = !this.chatRestoreAnchor && this.chatScrollIntent !== 'up'
        && (gap <= 2 || this.chatBottomFollowPending || (this.chatPinnedToBottom && performance.now() < this.chatViewportFollowUntil));
      const actions = this.root.querySelector<HTMLElement>('.message-actions:not(.is-closing)');
      // Native scrolling can notify after the menu was opened at its final
      // position. Only movement since that opening makes the menu stale.
      if (actions && Math.abs(window.scrollY - Number(actions.dataset.openScrollY)) > 1) this.closeMessageActions(false, false);
      if (window.scrollY < 80) void this.loadOlderHistory(list);
      if (gap < 80) void this.loadNewerHistory(list);
      this.captureChatAnchor(true, false, gap);
      this.markVisibleMessagesRead();
    });
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
    const delta = target.getBoundingClientRect().top - this.chatViewportTop - anchor.offset;
    if (Math.abs(delta) > 1) window.scrollBy(0, delta);
  }

  private chatBottomGap(): number {
    return Math.max(0, this.chatBottomScrollTop() - window.scrollY);
  }

  private chatBottomScrollTop(): number {
    const chat = this.chatLayoutElements;
    const latest = this.renderedMessageOrder.at(-1);
    if (!chat?.shell.isConnected || !latest?.isConnected) return 0;
    // Use the message and composer edges, not document extent: the latter can
    // include a short-history minimum height or a stale Safari layout viewport.
    return Math.max(0, window.scrollY + latest.getBoundingClientRect().bottom - chat.composer.getBoundingClientRect().top + 16);
  }

  private scrollChatToBottom(): void {
    this.chatScrollIntent = null;
    this.chatPinnedToBottom = true;
    this.alignChatBottom();
    if (this.chatBottomFollowPending) this.trackChatViewport();
  }

  private alignChatBottom(): void {
    const bottom = this.chatBottomScrollTop();
    if (Math.abs(window.scrollY - bottom) > 1) window.scrollTo(0, bottom);
    this.chatLastScrollY = window.scrollY;
    // A keyboard/focus scroll may temporarily ignore scrollTo. Preserve the
    // requested destination until a later sampled frame can apply it.
    this.chatBottomFollowPending = Math.abs(window.scrollY - bottom) > 2;
  }

  private finishChatAnchorRestore(list: HTMLElement): void {
    const anchor = this.chatRestoreAnchor;
    if (!anchor) return;
    const target = list.querySelector<HTMLElement>(`.message[data-client-msg-id="${CSS.escape(anchor.clientMsgId)}"]`);
    if (target) this.restoreChatAnchor(list, anchor);
    if (!target || !target.querySelector('.image-preview:not([data-image-state="loaded"]):not([data-image-state="error"])')) {
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
    const session = this.session;
    if (!session) return;
    const snapshot = structuredClone(this.uiPreferences);
    this.preferenceSaveChain = this.preferenceSaveChain
      .catch(() => undefined)
      .then(() => saveUiPreferences(session, snapshot))
      .catch(() => undefined);
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
    if (this.connectionState !== 'connected') this.showNotice('消息已加密保存在本机，连接恢复后会自动发送');
  }

  private enqueuePayload(payload: MessagePayload, existingClientMsgId?: string): Promise<void> {
    const session = this.session;
    const epoch = this.runtimeEpoch;
    const operation = this.sendChain.catch(() => undefined).then(() => {
      if (!session || !this.isRuntimeActive(epoch, session)) return;
      return this.sendPayload(payload, existingClientMsgId);
    });
    this.sendChain = operation.catch(() => undefined);
    return operation;
  }

  private async sendPayload(payload: MessagePayload, existingClientMsgId?: string): Promise<void> {
    const session = this.session;
    const epoch = this.runtimeEpoch;
    if (!session || this.privacyCovered) return;
    await withVaultMutation(session, async (mutation) => {
      if (this.isRuntimeActive(epoch, session)) await this.sendPayloadLocked(payload, existingClientMsgId, mutation);
    });
  }

  private async sendPayloadLocked(payload: MessagePayload, existingClientMsgId: string | undefined, mutation: VaultMutation): Promise<void> {
    const session = this.session;
    if (!session || this.privacyCovered) return;
    if (payload.kind === 'reaction' && !this.activeDevicesSupport('message-reactions-v1')) {
      throw new Error('请先让所有已授权设备打开最新版，再使用表情回应');
    }
    if ((payload.kind === 'audio' || ('replyTo' in payload && payload.replyTo?.kind === 'audio')) && !this.activeDevicesSupport('voice-message-v1')) {
      throw new Error('请先让所有已授权设备打开一次最新版，再发送语音或回复语音');
    }
    if (!this.supportsFilePayload(payload)) {
      throw new Error('请先让所有已授权设备打开一次最新版，再发送文件或回复文件');
    }
    if (session.vault.protocol === 'mls-rfc9420' && session.vault.mls?.phase !== 'active') {
      throw new Error('安全会话尚未建立完成，内容不会上传或发送');
    }
    const epoch = this.runtimeEpoch;
    const clientMsgId = existingClientMsgId ?? crypto.randomUUID();
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
    this.renderMessages({ scroll: payload.kind === 'reaction' ? 'preserve' : 'send' });
    if (payload.kind !== 'reaction') this.trackChatViewport(!this.desktopBrowser);
    await this.attemptSend(clientMsgId);
  }

  private async attemptSend(clientMsgId: string): Promise<void> {
    const session = this.session;
    if (!session || this.privacyCovered || this.sending.has(clientMsgId)) return;
    const epoch = this.runtimeEpoch;
    const item = this.outbox.get(clientMsgId);
    if (!item) return;
    if (this.connectionState !== 'connected') return;
    if (this.deferUnsupportedFile(item)) return;
    this.sending.add(clientMsgId);
    const pendingMessage = this.pending.get(clientMsgId);
    if (pendingMessage?.status === 'failed') pendingMessage.status = 'pending';
    try {
      const envelope = item.envelope ?? await encryptMessage(session.vault, item.payload, clientMsgId);
      if (!this.isRuntimeActive(epoch, session)) return;
      if (this.deferUnsupportedFile(item)) return;
      this.socket?.sendEnvelope(envelope, item.payload.kind !== 'gallery-image' && item.payload.kind !== 'gallery-file' && item.payload.kind !== 'reaction');
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

  private async reencryptOutboxItem(clientMsgId: string): Promise<void> {
    const session = this.session;
    const epoch = this.runtimeEpoch;
    if (!session || this.privacyCovered) return;
    await withVaultMutation(session, async (mutation) => {
      if (this.isRuntimeActive(epoch, session)) await this.reencryptOutboxItemLocked(clientMsgId, mutation);
    });
  }

  private async reencryptOutboxItemLocked(clientMsgId: string, mutation: VaultMutation): Promise<void> {
    const session = this.session;
    const epoch = this.runtimeEpoch;
    const item = this.outbox.get(clientMsgId);
    if (!session || !item || session.vault.protocol !== 'mls-rfc9420') return;
    if (this.deferUnsupportedFile(item)) return;
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
    if (resetCount) this.retryCounts.delete(clientMsgId);
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
    const hasText = Boolean(this.root.querySelector<HTMLTextAreaElement>('#message-input')?.value.trim());
    const mic = this.root.querySelector<HTMLButtonElement>('#record-voice');
    const send = this.root.querySelector<HTMLButtonElement>('#composer > .send-button');
    if (mic) mic.hidden = hasText;
    if (send) send.hidden = !hasText;
  }

  private closeVoiceRecorder(restoreFocus = false): void {
    this.voiceGesture?.cancel();
    const recorder = this.voiceRecorder;
    this.voiceRecorder = null;
    this.microphonePromptActive = false;
    recorder?.destroy();
    const host = this.root.querySelector<HTMLElement>('.voice-recorder');
    if (host) host.hidden = true;
    this.root.querySelector('#composer')?.classList.remove('has-voice-draft');
    if (restoreFocus) this.root.querySelector<HTMLButtonElement>('#record-voice')?.focus({ preventScroll: true });
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
    this.closeMessageActions();
    this.root.querySelector<HTMLTextAreaElement>('#message-input')?.blur();
    this.root.querySelector('#composer')?.classList.add('has-voice-draft');
    host.hidden = false;
    let replyTarget: DecryptedMessage | null | undefined;
    let payload: MessagePayload | undefined;
    let plan: ImageUploadPlan | undefined;
    let uploaded: ImageManifest | undefined;
    const recorder = new VoiceRecorder(host, {
      permission: active => {
        if (this.voiceRecorder === recorder) this.microphonePromptActive = active;
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
          reserve: (blobId, count, size) => reserveBlob(roomId, accessToken, blobId, count, size, signal),
          status: blobId => getBlobStatus(roomId, accessToken, blobId, signal),
          upload: (blobId, index, bytes) => this.retryOperation(() => uploadBlobChunk(roomId, accessToken, blobId, index, bytes, signal), 3, signal),
          complete: blobId => completeBlob(roomId, accessToken, blobId, signal),
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
    }, mode);
    this.voiceRecorder = recorder;
    void recorder.start();
    return recorder;
  }

  private beginImagePicker(restoreComposerFocus = false): void {
    this.imagePickerActive = true;
    this.restoreComposerFocusAfterPicker = restoreComposerFocus;
    if (this.imagePickerResetTimer !== null) window.clearTimeout(this.imagePickerResetTimer);
    this.imagePickerResetTimer = window.setTimeout(() => this.finishImagePicker(), 5 * 60_000);
  }

  private finishImagePicker(restoreFocus = true): void {
    this.imagePickerActive = false;
    if (this.imagePickerInput && !this.root.contains(this.imagePickerInput)) this.imagePickerInput.remove();
    this.imagePickerInput = null;
    if (this.imagePickerResetTimer !== null) window.clearTimeout(this.imagePickerResetTimer);
    this.imagePickerResetTimer = null;
    if (restoreFocus && this.restoreComposerFocusAfterPicker) {
      this.restoreComposerFocusAfterPicker = false;
      this.restoreComposerFocus();
    }
  }

  private mountImagePicker(
    input: HTMLInputElement | null,
    destination: 'chat' | 'gallery',
    trigger?: HTMLButtonElement | null,
  ): void {
    if (input && this.session) {
      input.dataset.roomId = this.session.vault.roomId;
      input.dataset.deviceId = this.session.vault.identity.publicBundle.deviceId;
    }
    if (trigger) {
      trigger.addEventListener('pointerdown', (event) => {
        const textarea = this.root.querySelector<HTMLTextAreaElement>('#message-input');
        if (destination === 'chat' && textarea) this.retainComposerKeyboard(event, textarea);
      });
      trigger.addEventListener('click', () => {
        if (!input || input.disabled) return;
        if (this.imagePickerInput && this.imagePickerInput !== input) this.finishImagePicker(false);
        this.beginImagePicker(destination === 'chat' && this.keepComposerKeyboard);
        input.click();
      });
    }
    input?.addEventListener('click', () => {
      if (!this.root.contains(input)) return;
      if (this.imagePickerInput && this.imagePickerInput !== input) this.finishImagePicker(false);
      this.imagePickerInput = input;
      if (!this.imagePickerActive) this.beginImagePicker();
    });
    input?.addEventListener('cancel', () => {
      if (input !== this.imagePickerInput) return;
      this.finishImagePicker();
      this.deferredImageUpload = null;
    });
    input?.addEventListener('change', (event) => void this.handleSendImage(event, destination));
  }

  private async handleSendImage(event: Event, destination: 'chat' | 'gallery'): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    if (!this.root.contains(input) && input !== this.imagePickerInput) return;
    const selected = [...(input.files ?? [])];
    input.value = '';
    if (destination === 'chat' && this.restoreComposerFocusAfterPicker) {
      this.restoreComposerFocusAfterPicker = false;
      this.restoreComposerFocus();
    }
    this.finishImagePicker(false);
    if (selected.length === 0) {
      this.deferredImageUpload = null;
      return;
    }
    const files = selected;
    if (!this.session || this.privacyCovered) {
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
    if (!this.deferredImageUpload || !this.session || this.privacyCovered) return;
    const { files, destination, roomId, deviceId } = this.deferredImageUpload;
    this.deferredImageUpload = null;
    if (this.session.vault.roomId !== roomId || this.session.vault.identity.publicBundle.deviceId !== deviceId) return;
    if (destination === 'gallery') {
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

  private async processImageBatch(files: File[], destination: 'chat' | 'gallery'): Promise<boolean> {
    const session = this.session;
    if (!session || this.privacyCovered || files.length === 0) return false;
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
    const signal = this.runtimeAbort?.signal;
    if (files.some((file) => file.size > MAX_IMAGE_BYTES)) {
      this.showNotice('单个文件不能超过 256 MiB', 'error');
      return false;
    }
    if (files.some((file) => file.size === 0)) {
      this.showNotice('不能发送空文件', 'error');
      return false;
    }
    const uploadScope = this.root.querySelector<HTMLElement>(destination === 'gallery' ? '.gallery-shell' : '#composer');
    const progress = this.root.querySelector<HTMLElement>('#upload-progress');
    const bar = progress?.querySelector<HTMLElement>('span');
    const output = progress?.querySelector<HTMLOutputElement>('output');
    const uploadControlSelector = destination === 'gallery'
      ? 'button, textarea, input'
      : '#open-image-picker, #image-input';
    uploadScope?.classList.add('is-uploading');
    uploadScope?.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement | HTMLInputElement>(uploadControlSelector).forEach((control) => {
      control.disabled = true;
    });
    if (progress) progress.hidden = false;
    const replyTarget = destination === 'chat' ? this.replyTarget : null;
    const clientMsgId = crypto.randomUUID();
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
      const sentAt = new Date().toISOString();
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
      await this.enqueuePayload(payload, clientMsgId);
      if (!this.isRuntimeActive(epoch, session)) return false;
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
      if (signal?.aborted || !this.isRuntimeActive(epoch, session)) return false;
      const suffix = this.uploadPlans.length > 0 ? '。重新选择同一文件可从已完成分块继续' : '';
      this.showNotice(`${cause instanceof Error ? cause.message : '文件上传失败'}${suffix}`, 'error');
      return false;
    } finally {
      if (!this.isRuntimeActive(epoch, session)) return false;
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

  private orderedMessages(): DecryptedMessage[] {
    const confirmed = [...this.messages.values()]
      .filter((message) => message.payload.kind !== 'gallery-image' && message.payload.kind !== 'gallery-file' && message.payload.kind !== 'reaction')
      .sort((left, right) => left.seq - right.seq);
    const pending = [...this.pending.values()]
      .filter((message) => message.payload.kind !== 'gallery-image' && message.payload.kind !== 'gallery-file' && message.payload.kind !== 'reaction')
      .sort((left, right) => left.acceptedAt.localeCompare(right.acceptedAt));
    return [...confirmed, ...pending];
  }

  private activeDevicesSupport(capability: string): boolean {
    const members = this.session?.vault.members.filter((member) => member.status === undefined || member.status === 'active') ?? [];
    return members.length > 0 && members.every((member) => member.capabilities?.includes(capability));
  }

  private supportsFilePayload(payload: MessagePayload): boolean {
    const needsFiles = payload.kind === 'file' || payload.kind === 'gallery-file' || ('replyTo' in payload && payload.replyTo?.kind === 'file');
    return !needsFiles || this.activeDevicesSupport('file-message-v1');
  }

  private deferUnsupportedFile(item: OutboxItem): boolean {
    if (this.supportsFilePayload(item.payload)) return false;
    const pending = this.pending.get(item.clientMsgId);
    if (pending && pending.status !== 'failed') {
      pending.status = 'failed';
      this.showNotice('文件已保留待发；请让所有已授权设备打开一次最新版后继续发送', 'error');
      this.renderMessages();
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
    if (message.payload.kind === 'reaction') return '表情回应';
    return '图片';
  }

  private localReplyPreview(reference: ReplyReference): string {
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
    draft.querySelector('span')!.textContent = this.replyPreviewForMessage(this.replyTarget);
    draft.hidden = false;
  }

  private beginReply(message: DecryptedMessage): void {
    if (this.isOwnMessage(message) || !Number.isSafeInteger(message.seq) || message.seq < 1) return;
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
    const open = () => this.openMessageActions(article,
      this.messages.get(this.renderedMessageSeq.get(message.clientMsgId) ?? 0) ?? this.pending.get(message.clientMsgId) ?? message);
    article.addEventListener('pointerdown', (event) => {
      if (article.classList.contains('is-selecting-text')) return;
      const excludedButton = event.target instanceof Element
        ? event.target.closest('input, button:not(.image-preview):not(.album-cell):not(.file-attachment)')
        : null;
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
      if (article.classList.contains('is-selecting-text')) return;
      event.preventDefault();
      this.cancelMessageHold();
      open();
    });
    article.addEventListener('keydown', (event) => {
      if (article.classList.contains('is-selecting-text')) return;
      if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
        event.preventDefault();
        open();
      }
    });
  }

  private openMessageActions(article: HTMLElement, message: DecryptedMessage): void {
    if (!this.session || this.privacyCovered || !article.isConnected) return;
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
    actions.dataset.openScrollY = String(window.scrollY);
    const actionButtons: HTMLButtonElement[] = [];
    const confirmed = message.seq > 0 && message.seq < Number.MAX_SAFE_INTEGER;
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
    const addAction = (action: string, label: string, icon: string, handler: () => void) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.messageAction = action;
      button.setAttribute('role', 'menuitem');
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
    if (!this.isOwnMessage(message)) addAction('reply', '回复', icons.reply, () => this.beginReply(message));
    if (list.childElementCount) actions.append(list);
    if (!actionButtons.length) { article.classList.remove('is-action-source'); return; }
    this.root.append(backdrop, actions);
    this.positionMessageActions(actions, article);
    actions.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Tab'].includes(event.key)) return;
      event.preventDefault();
      const index = actionButtons.indexOf(document.activeElement as HTMLButtonElement);
      const step = ['ArrowUp', 'ArrowLeft'].includes(event.key) || (event.key === 'Tab' && event.shiftKey) ? -1 : 1;
      const target = event.key === 'Home' ? 0 : event.key === 'End' ? actionButtons.length - 1
        : index < 0 ? (step < 0 ? actionButtons.length - 1 : 0) : (index + step + actionButtons.length) % actionButtons.length;
      actionButtons[target]?.focus({ preventScroll: true });
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
    if (picker) {
      const pickerX = Math.max(left + 8, Math.min(rect.left, left + width - picker.offsetWidth - 8));
      actions.style.setProperty('--message-reaction-x', `${Math.round(pickerX)}px`);
      actions.style.setProperty('--message-reaction-y', `${Math.round(pickerY)}px`);
    }
  }

  private messageReactions() {
    const members = new Map(this.session?.vault.members.map(member => [member.deviceId, member.role]) ?? []);
    return reduceMessageReactions([...this.reactionHistory.values(), ...this.messages.values(), ...this.pending.values()], members);
  }

  private async sendReaction(message: DecryptedMessage, emoji: ReactionEmoji | null): Promise<void> {
    const session = this.session;
    const epoch = this.runtimeEpoch;
    if (!session || this.privacyCovered || message.seq <= 0 || message.seq >= Number.MAX_SAFE_INTEGER) return;
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

  private renderMessageReactions(): void {
    const reactions = this.messageReactions();
    for (const article of this.renderedMessageOrder) {
      const badges = reactions.get(article.dataset.clientMsgId ?? '');
      let group = article.querySelector<HTMLElement>('.message-reactions');
      if (!badges?.length) { group?.remove(); continue; }
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
      if (!group.isConnected) article.querySelector('.message-bubble')?.append(group);
    }
  }

  private async copyMessageText(text: string, message: DecryptedMessage): Promise<void> {
    const session = this.session;
    const epoch = this.runtimeEpoch;
    if (!session || !this.isRuntimeActive(epoch, session)) return;
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
      backdrops.forEach(element => element.remove());
      actions?.remove();
      for (const source of sources) {
        const current = this.root.querySelector<HTMLElement>('.message-actions:not(.is-closing)');
        if (current?.dataset.sourceId !== (source as HTMLElement).dataset.clientMsgId) source.classList.remove('is-action-source');
      }
    };
    if (!actions) { finish(); return; }
    if (closeDialog(actions, { animate, restoreFocus })) { finish(); return; }
    const sourceId = actions.dataset.sourceId;
    actions.classList.remove('is-visible');
    actions.classList.add('is-closing');
    actions.inert = true;
    backdrops.forEach(element => { element.classList.remove('is-visible'); element.classList.add('is-closing'); });
    if (animate && !this.privacyCovered && !matchMedia('(prefers-reduced-motion: reduce)').matches) window.setTimeout(finish, 160);
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
    let target = list.querySelector<HTMLElement>(`.message[data-client-msg-id="${CSS.escape(clientMsgId)}"]`);
    if (!target && seq !== undefined) {
      try {
        const signal = this.runtimeAbort?.signal;
        const saved = await loadHistoryMessage(session, seq, signal);
        if (!this.isRuntimeActive(epoch, session) || !list.isConnected || this.replyJumpVersion !== jumpVersion) return;
        if (saved?.clientMsgId === clientMsgId && saved.payload.kind !== 'gallery-image' && saved.payload.kind !== 'gallery-file') {
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
    target.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
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
    const followSend = scroll === 'send';
    const previousLatest = followSend ? this.renderedMessageOrder.at(-1) : null;
    const previousLatestTop = previousLatest?.isConnected ? previousLatest.querySelector('.message-bubble')?.getBoundingClientRect().top ?? null : null;
    if (followSend) this.cancelChatMessageMotion();
    const anchor = scroll === 'restore'
      ? this.uiPreferences.chatAnchor
      : this.captureChatAnchor(false, scroll === 'position');
    if (scroll === 'bottom' || followSend || scroll === 'position') this.chatRestoreAnchor = null;
    else if (scroll === 'restore') this.chatRestoreAnchor = anchor && !anchor.pinnedToBottom ? anchor : null;
    const messages = this.orderedMessages();
    if (messages.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-conversation';
      const title = document.createElement('p');
      title.textContent = '会话已经准备好';
      const detail = document.createElement('span');
      detail.textContent = '文字、语音和原图都会在这台设备上加密后再发送。';
      empty.append(title, detail);
      this.renderedMessages.clear();
      this.renderedMessageOrder = [];
      this.renderedMessageSeq.clear();
      list.replaceChildren(empty);
    } else {
      const currentKeys = new Set<string>();
      const elements: HTMLElement[] = [];
      const sequences = new Map<string, number>();
      for (const message of messages) {
        const key = message.clientMsgId;
        currentKeys.add(key);
        const cached = this.renderedMessages.get(key);
        // Payloads are immutable after decryption/enqueue. Compare their
        // identity and mutable delivery metadata without serializing history.
        // Keep the native selection mounted while independently refreshing its
        // delivery decoration. Legacy confirmation can decrypt a fresh payload.
        const selecting = this.selectedMessageId === key && cached?.payload.kind === 'text'
          && message.payload.kind === 'text' && cached.payload.text === message.payload.text;
        const unchanged = cached?.payload === message.payload && cached.status === message.status && cached.acceptedAt === message.acceptedAt;
        // Legacy confirmation decrypts a fresh but equivalent payload. Compare
        // that changed object only; unchanged history retains the fast path.
        const samePayload = cached?.payload === message.payload || Boolean(cached && canonicalStringify(cached.payload) === canonicalStringify(message.payload));
        const keepContent = Boolean(cached && (selecting || samePayload));
        const element = keepContent ? cached!.element : this.createMessageElement(message);
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
        if (cached && !keepContent && cached.element.parentElement === list) {
          const hadFocus = cached.element.contains(document.activeElement);
          cached.element.replaceWith(element);
          if (hadFocus) element.focus({ preventScroll: true });
        }
        this.renderedMessages.set(key, { payload: message.payload, status: message.status, acceptedAt: message.acceptedAt, element });
        sequences.set(key, message.seq);
        elements.push(element);
      }
      for (const key of this.renderedMessages.keys()) {
        if (!currentKeys.has(key)) this.renderedMessages.delete(key);
      }
      // Keep unchanged nodes in place so focus, image decode state, selection
      // and compositing survive incoming messages and delivery receipts.
      let next = list.firstElementChild;
      for (const element of elements) {
        if (element === next) next = next.nextElementSibling;
        else list.insertBefore(element, next);
      }
      while (next) {
        const stale = next;
        next = next.nextElementSibling;
        stale.remove();
      }
      this.renderedMessageOrder = elements;
      this.renderedMessageSeq = sequences;
    }
    this.renderMessageReactions();
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
  }

  private cancelChatMessageMotion(): void {
    for (const animation of this.chatMessageAnimations) animation.cancel();
    this.chatMessageAnimations.clear();
  }

  private animateChatMessageShift(distance: number): void {
    this.cancelChatMessageMotion();
    if (distance < 1 || matchMedia('(prefers-reduced-motion: reduce)').matches || this.chatBottomFollowPending) return;
    const offset = Math.min(distance, 280, this.chatViewportHeight * 0.45);
    // Scroll and anchors are committed once. Animate only visible content
    // inside each row, so fixed bars and all geometry used by unread/scroll
    // bookkeeping stay in their final positions throughout the transition.
    for (let index = this.renderedMessageOrder.length - 1; index >= 0; index--) {
      const row = this.renderedMessageOrder[index]!;
      const rect = row.getBoundingClientRect();
      if (rect.bottom < this.chatViewportTop - offset) break;
      if (rect.top > this.chatViewportTop + this.chatViewportHeight) continue;
      for (const content of row.children) {
        if (!(content instanceof HTMLElement)) continue;
        const animation = content.animate(
          [{ translate: `0 ${offset}px` }, { translate: '0 0' }],
          { duration: 300, easing: 'cubic-bezier(0.22, 0.68, 0.22, 1)' },
        );
        this.chatMessageAnimations.add(animation);
        animation.finished.then(() => this.chatMessageAnimations.delete(animation), () => this.chatMessageAnimations.delete(animation));
      }
    }
  }

  private async loadOlderHistory(list: HTMLElement): Promise<void> {
    const session = this.session;
    const epoch = this.runtimeEpoch;
    if (!session || this.privacyCovered || !list.isConnected || !this.historyHasMore || this.historyLoading) return;
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
      if (!this.isRuntimeActive(epoch, session) || !list.isConnected) return;
      if (older.length < 200) this.historyHasMore = false;
      for (const message of older) this.messages.set(message.seq, message);
      this.renderMessages({ scroll: 'preserve' });
    } catch (cause) {
      if (this.isRuntimeActive(epoch, session) && list.isConnected) this.operationalError(cause, '较早的消息暂时无法读取，请重试');
    } finally {
      if (this.isRuntimeActive(epoch, session)) this.historyLoading = false;
      delete list.dataset.historyLoading;
    }
  }

  private async loadNewerHistory(list: HTMLElement): Promise<void> {
    const session = this.session;
    const epoch = this.runtimeEpoch;
    if (!session || this.privacyCovered || !list.isConnected || !this.historyHasNewer || this.historyLoading) return;
    this.historyLoading = true;
    list.dataset.historyLoading = 'true';
    try {
      const newer = await loadHistoryPageAfter(session, {
        limit: 200,
        afterSeq: this.historyForwardCursor,
        signal: this.runtimeAbort?.signal,
      });
      if (!this.isRuntimeActive(epoch, session) || !list.isConnected) return;
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
      if (this.isRuntimeActive(epoch, session) && list.isConnected) this.operationalError(cause, '后续消息暂时无法读取，请重试');
    } finally {
      if (this.isRuntimeActive(epoch, session)) this.historyLoading = false;
      delete list.dataset.historyLoading;
    }
  }

  private createMessageElement(message: DecryptedMessage): HTMLElement {
    const own = this.isOwnMessage(message);
    const article = document.createElement('article');
    article.className = `message ${own ? 'outgoing' : 'incoming'} is-${message.status}`;
    article.dataset.clientMsgId = message.clientMsgId;
    article.tabIndex = 0;
    article.setAttribute('aria-label', own ? '我的消息，可长按回应或复制文字' : '对方消息，可长按回应、回复或复制文字');
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    if ('replyTo' in message.payload && message.payload.replyTo) {
      const quote = document.createElement('button');
      quote.type = 'button';
      quote.className = 'message-reply-quote';
      quote.setAttribute('aria-label', `查看被回复的消息：${message.payload.replyTo.preview}`);
      const label = document.createElement('strong');
      label.textContent = this.isOwnMessage({ senderId: message.payload.replyTo.senderId }) ? '你' : '对方';
      const preview = document.createElement('span');
      preview.textContent = this.localReplyPreview(message.payload.replyTo);
      quote.append(label, preview);
      const targetId = message.payload.replyTo.clientMsgId;
      const targetSeq = message.payload.replyTo.serverSeq;
      quote.addEventListener('click', () => void this.jumpToReplyTarget(targetId, targetSeq));
      bubble.append(quote);
    }
    if (message.payload.kind === 'text') {
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
          (blobId, index) => fetchBlobChunk(session.vault.roomId, session.vault.accessToken, blobId, index, signal), undefined, signal);
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
        bubble.append(this.createFileAttachment(message.payload.file));
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
      bubble.append(this.createImagePreview(message.payload.image, [message.payload.image], 0, message.clientMsgId));
    }
    article.append(bubble, this.createMessageMeta(message));
    this.mountMessageActions(article, message);
    return article;
  }

  private createMessageMeta(message: DecryptedMessage): HTMLElement {
    const own = this.isOwnMessage(message);
    const meta = document.createElement('p');
    meta.className = 'message-meta';
    const status = own
      ? message.status === 'pending'
        ? ' · 等待发送'
        : message.status === 'stored' || message.status === 'sent'
          ? '已发送'
          : message.status === 'delivered'
            ? '已送达'
            : ' · 发送失败'
      : '';
    meta.append(document.createTextNode(timeLabel(message.payload.sentAt)));
    if (own && (message.status === 'stored' || message.status === 'sent' || message.status === 'delivered')) {
      const delivery = document.createElement('span');
      delivery.className = 'message-delivery';
      delivery.dataset.state = message.status === 'delivered' ? 'delivered' : 'sent';
      // One complete check; delivery adds only the second rising arm, matching
      // the compact Telegram receipt rather than placing two glyphs side by side.
      delivery.innerHTML = `<svg aria-hidden="true" viewBox="0 0 22 16"><path d="m2 8 4 4L16 2"/>${message.status === 'delivered' ? '<path d="m10 12 10-10"/>' : ''}</svg>`;
      const label = document.createElement('span');
      label.className = 'sr-only';
      label.textContent = status;
      delivery.append(label);
      meta.append(delivery);
    } else if (status) meta.append(document.createTextNode(status));
    if (own) {
      meta.title = message.status === 'delivered' ? '对方至少一台设备已验证并保存这条消息'
        : message.status === 'stored' || message.status === 'sent' ? '服务器已保存加密消息，等待对方接收'
          : message.status === 'pending' ? '已保存在本机，等待发送到服务器' : '发送失败，可以重试';
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

  private createFileAttachment(manifest: FileManifest): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'file-attachment';
    button.dataset.blobId = manifest.blobId;
    button.dataset.fileState = 'idle';
    const filename = manifest.originalName || '未命名文件';
    const size = this.fileSize(manifest.originalSize);
    button.setAttribute('aria-label', `下载文件 ${filename}，${size}`);
    button.innerHTML = `${icons.file}<span class="file-attachment-copy"><strong class="file-attachment-name"></strong><span class="file-attachment-meta" aria-live="polite"></span></span><span class="file-attachment-action" aria-hidden="true">${icons.download}</span>`;
    button.querySelector<HTMLElement>('.file-attachment-name')!.textContent = filename;
    const meta = button.querySelector<HTMLElement>('.file-attachment-meta')!;
    meta.textContent = `${size} · 下载文件`;
    button.addEventListener('click', () => {
      if (Date.now() < this.suppressMediaClickUntil) return;
      const session = this.session;
      const epoch = this.runtimeEpoch;
      const signal = this.runtimeAbort?.signal;
      if (!session || this.privacyCovered || !button.isConnected || button.disabled) return;
      button.disabled = true;
      button.dataset.fileState = 'loading';
      button.setAttribute('aria-busy', 'true');
      meta.textContent = `${size} · 正在下载`;
      void (async () => {
        try {
          this.assertImageManifestIdentity(manifest);
          const blob = await decryptFileAttachment(manifest,
            (blobId, index) => fetchBlobChunk(session.vault.roomId, session.vault.accessToken, blobId, index, signal),
            ratio => {
              if (this.isRuntimeActive(epoch, session) && button.isConnected) meta.textContent = `${size} · 正在下载 ${Math.round(ratio * 100)}%`;
            }, signal);
          if (!this.isRuntimeActive(epoch, session) || !button.isConnected) return;
          this.beginFileExport();
          // Download arbitrary bytes as an inert file, including when a browser
          // falls back from its download attribute to a new tab.
          await this.withSystemSurface(() => downloadBlob(blob.slice(0, blob.size, 'application/octet-stream'), filename));
          if (!this.isRuntimeActive(epoch, session) || !button.isConnected) return;
          button.dataset.fileState = 'idle';
          meta.textContent = `${size} · 再次下载`;
        } catch (cause) {
          if (!this.isRuntimeActive(epoch, session) || !button.isConnected) return;
          this.finishFileExport();
          if (cause instanceof DOMException && cause.name === 'AbortError') {
            button.dataset.fileState = 'idle';
            meta.textContent = `${size} · 下载文件`;
          } else {
            button.dataset.fileState = 'error';
            meta.textContent = `${size} · 下载失败，点按重试`;
            this.operationalError(cause, '文件下载失败，请重试');
          }
        } finally {
          if (this.isRuntimeActive(epoch, session) && button.isConnected) {
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
    void this.runAutomaticBackup();
  }

  private runAutomaticBackup(): Promise<void> {
    if (this.backupRun) return this.backupRun;
    const session = this.session;
    const signal = this.runtimeAbort?.signal;
    if (!session || !signal || this.privacyCovered || document.hidden) return Promise.resolve();
    const epoch = this.runtimeEpoch;
    const run = syncCloudBackup(session, signal).then(() => {
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
    status.textContent = this.backupError || (this.backupRun ? '正在加密并备份…' : backup?.syncedAt
      ? `上次备份：${new Date(backup.syncedAt).toLocaleString()}。已保存 ${backup.archives.reduce((total, archive) => total + archive.parts.reduce((sum, part) => sum + part.count, 0), 0)} 条历史记录。`
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
    this.setActiveSurface('away');
    const epoch = this.runtimeEpoch;
    this.root.innerHTML = `<main class="backup-page">
      <button class="text-button" id="backup-back" type="button">返回会话</button>
      <header class="backup-heading">
        <h1>备份与恢复</h1>
        <p>备份先在本机加密。恢复码请单独保存，管理员无法找回。</p>
      </header>
      <section><h2>自动备份</h2><p id="backup-status" role="status"></p>
        <button class="secondary-button" id="backup-retry" type="button">立即备份</button>
        <p class="field-hint">解锁并联网时自动备份，锁定后暂停。</p>
      </section>
      <section><h2>本设备恢复码</h2><p>再次验证通行密钥后，即可在本机查看。</p>
        <button class="secondary-button" id="view-local-recovery" data-backup-ready type="button" disabled>查看本设备恢复码</button>
      </section>
      <section><h2>恢复历史内容</h2><p>旧内容需主动恢复。选择范围后，输入本设备当前恢复码。</p>
        <div class="backup-actions"><button class="secondary-button" data-restore="chat" data-backup-ready type="button" disabled>恢复历史消息</button>
        ${session.vault.role === 'creator' ? '<button class="secondary-button" data-restore="gallery" data-backup-ready type="button" disabled>恢复保险箱</button>' : ''}</div>
        <div id="history-restore-form"></div>
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
    this.root.querySelector('#backup-retry')?.addEventListener('click', () => void this.runAutomaticBackup());
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
          const count = await restoreCloudHistory(session, code, scope, operation.signal, count => {
            if (count > 0) historyChanged = true;
            if (form.isConnected && this.isRuntimeActive(epoch, session)) status.textContent = `已恢复 ${count} 条记录…`;
          });
          code = '';
          if (!form.isConnected || !this.isRuntimeActive(epoch, session)) return;
          status.textContent = `恢复完成，新增 ${count} 条记录。返回会话后即可查看。`;
          historyChanged = historyChanged || count > 0;
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
        if (button.isConnected && !this.privacyCovered) error.textContent = cause instanceof Error ? cause.message : '验证未完成';
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
    this.viewerMediaCleanup?.();
    this.viewerMediaCleanup = null;
  }

  private renderViewerVideo(stage: HTMLElement, cached: CachedImage, manifest: ImageManifest, requestNative: boolean): void {
    const video = document.createElement('video');
    const nativeVideo = video as HTMLVideoElement & {
      webkitEnterFullscreen?: () => void;
      webkitExitFullscreen?: () => void;
      webkitDisplayingFullscreen?: boolean;
    };
    const viewer = stage.closest<HTMLElement>('.image-viewer')!;
    video.controls = true;
    video.autoplay = true;
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
    const events = new AbortController();
    let active = true;
    let nativeEntered = false;
    let nativePendingTimer: number | null = null;
    const live = () => active && !this.privacyCovered && video.isConnected;
    const revealFallback = () => {
      if (!live() || nativeEntered) return;
      delete viewer.dataset.nativeVideo;
      video.playsInline = true;
    };
    const nativeBegan = () => {
      if (!live()) return;
      nativeEntered = true;
      viewer.dataset.nativeVideo = 'active';
      if (nativePendingTimer !== null) window.clearTimeout(nativePendingTimer);
    };
    const nativeEnded = () => {
      if (!live() || !nativeEntered) return;
      // Returning from Done / Escape goes directly to the originating surface.
      this.closeImageViewer(true);
    };
    const showError = () => {
      if (!live()) return;
      revealFallback();
      feedback.textContent = '此浏览器无法播放该视频，可下载原文件';
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
    feedback.addEventListener('click', () => { requestNativePlayer(); play(); }, { signal: events.signal });
    this.viewerMediaCleanup = () => {
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
    stage.replaceChildren(video, feedback);
    video.src = cached.url;
    if (requestNative) {
      requestNativePlayer();
    }
    play();
  }

  private updateChatImageVisibility(button: HTMLButtonElement): void {
    const revealed = this.chatRevealedAssets.has(button.dataset.revealKey!);
    button.dataset.revealed = String(revealed);
    button.setAttribute('aria-label', (revealed ? button.dataset.openLabel : button.dataset.revealLabel)!);
  }

  private concealChatImages(): void {
    this.chatRevealedAssets.clear();
    this.root.querySelectorAll<HTMLButtonElement>('#message-list .image-preview').forEach(button => {
      this.updateChatImageVisibility(button);
    });
  }

  private mountChatImageConcealGesture(list: HTMLElement): void {
    let start: { id: number; x: number; y: number } | null = null;
    let touchStart: { id: number; x: number; y: number } | null = null;
    let concealed = false;
    const move = (origin: { x: number; y: number }, x: number, y: number) => {
      if (concealed || y - origin.y < 24 || y - origin.y <= Math.abs(x - origin.x)) return;
      concealed = true;
      this.cancelMessageHold();
      this.suppressMediaClickUntil = Date.now() + 650;
      this.concealChatImages();
    };
    list.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !event.isPrimary && event.pointerType !== '') return;
      start = { id: event.pointerId, x: event.clientX, y: event.clientY };
      concealed = false;
    }, { passive: true });
    list.addEventListener('pointermove', event => {
      if (start?.id === event.pointerId) move(start, event.clientX, event.clientY);
    }, { passive: true });
    list.addEventListener('pointerup', event => {
      if (start?.id !== event.pointerId) return;
      move(start, event.clientX, event.clientY);
      if (concealed) this.suppressMediaClickUntil = Date.now() + 650;
      start = null;
    }, { passive: true });
    list.addEventListener('pointercancel', () => { start = null; }, { passive: true });
    // Native vertical scrolling cancels pointer events on touch browsers.
    // Follow the original touch as well, without preventing document scrolling.
    list.addEventListener('touchstart', event => {
      const touch = event.touches.length === 1 ? event.touches[0] : null;
      touchStart = touch ? { id: touch.identifier, x: touch.clientX, y: touch.clientY } : null;
      concealed = false;
    }, { passive: true });
    list.addEventListener('touchmove', event => {
      if (!touchStart || event.touches.length !== 1) return;
      const touch = event.touches[0]!;
      if (touch.identifier === touchStart.id) move(touchStart, touch.clientX, touch.clientY);
    }, { passive: true });
    for (const type of ['touchend', 'touchcancel'] as const) {
      list.addEventListener(type, () => {
        if (concealed) this.suppressMediaClickUntil = Date.now() + 650;
        touchStart = null;
      }, { passive: true });
    }
  }

  private createImagePreview(manifest: ImageManifest, album: ImageManifest[], index: number, clientMsgId: string, description = manifest.originalName || '聊天图片'): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    const video = isVideoFile(manifest);
    button.className = `image-preview${video ? ' video-preview' : ''}`;
    button.dataset.blobId = manifest.blobId;
    button.dataset.revealKey = `${clientMsgId}:${manifest.blobId}`;
    button.dataset.imageState = 'pending';
    button.dataset.openLabel = `${video ? '播放视频' : '放大查看'} ${description}`;
    button.dataset.revealLabel = `${video ? '显示视频预览' : '显示图片'} ${description}`;
    this.updateChatImageVisibility(button);
    button.setAttribute('aria-busy', 'true');
    button.innerHTML = `${video ? icons.video : icons.image}<span class="sr-only">正在加载${video ? '视频' : '图片'}</span>`;
    const cached = this.imageCache.get(manifest.blobId);
    if (cached) {
      this.assertImageManifestIdentity(manifest);
      cached.lastUsedAt = Date.now();
      if (cached.width && cached.height && (!video || cached.posterUrl)) {
        const image = document.createElement('img');
        image.src = cached.posterUrl ?? cached.url;
        image.alt = manifest.originalName || '聊天图片';
        image.draggable = false;
        image.width = cached.width;
        image.height = cached.height;
        button.replaceChildren(image);
        if (video) button.append(this.videoPlayBadge());
        button.dataset.imageState = 'loaded';
        button.setAttribute('aria-busy', 'false');
      } else queueMicrotask(() => { if (button.isConnected) void this.hydrateImagePreview(button, manifest); });
    }
    button.addEventListener('click', () => {
      if (Date.now() < this.suppressMediaClickUntil || !button.isConnected || !this.session || this.privacyCovered ||
          document.documentElement.classList.contains('privacy-obscured') || this.root.querySelector('.message-actions')) return;
      if (button.dataset.imageState === 'error') {
        void this.hydrateImagePreview(button, manifest);
        return;
      }
      if (button.dataset.revealed !== 'true') {
        this.chatRevealedAssets.add(button.dataset.revealKey!);
        this.updateChatImageVisibility(button);
        return;
      }
      this.openImageViewer(album, index, button);
    });
    return button;
  }

  private async renderImageIntoButton(button: HTMLButtonElement, manifest: ImageManifest, cached: CachedImage): Promise<void> {
    const video = isVideoFile(manifest);
    if (video) {
      await this.ensureVideoPoster(manifest, cached);
      if (!button.isConnected || this.privacyCovered) return;
      if (!cached.posterUrl) {
        button.replaceChildren(this.videoPlayBadge());
        button.dataset.imageState = 'loaded';
        button.dataset.posterUnavailable = 'true';
        button.setAttribute('aria-busy', 'false');
        const list = this.root.querySelector<HTMLElement>('#message-list');
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
    cached.width = image.width = image.naturalWidth;
    cached.height = image.height = image.naturalHeight;
    const anchor = this.captureChatAnchor();
    button.replaceChildren(image);
    if (video) button.append(this.videoPlayBadge());
    button.dataset.imageState = 'loaded';
    button.setAttribute('aria-busy', 'false');
    const list = this.root.querySelector<HTMLElement>('#message-list');
    if (list && anchor) this.restoreChatAnchor(list, anchor);
    if (list) this.finishChatAnchorRestore(list);
  }

  private async hydrateImagePreview(button: HTMLButtonElement, manifest: ImageManifest): Promise<void> {
    if (button.dataset.imageState === 'loading' || button.dataset.imageState === 'loaded') return;
    button.dataset.imageState = 'loading';
    const label = button.querySelector<HTMLElement>('span');
    button.setAttribute('aria-busy', 'true');
    if (label) { label.className = 'sr-only'; label.textContent = isVideoFile(manifest) ? '正在加载视频' : '正在加载图片'; }
    try {
      const cached = await this.loadImage(manifest);
      if (!button.isConnected || this.privacyCovered) return;
      await this.renderImageIntoButton(button, manifest, cached);
    } catch (cause) {
      if (!button.isConnected || cause instanceof DOMException && cause.name === 'AbortError') return;
      button.dataset.imageState = 'error';
      button.setAttribute('aria-busy', 'false');
      const error = document.createElement('span');
      error.textContent = cause instanceof Error ? `${cause.message}，点按重试` : '载入失败，点按重试';
      button.replaceChildren(error);
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
      const blob = await decrypt(
        manifest,
        (blobId, chunkIndex) => fetchBlobChunk(roomId, accessToken, blobId, chunkIndex, signal),
        undefined,
        signal,
      );
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

  private openImageViewer(manifests: ImageManifest[], startIndex = 0, returnFocus?: HTMLElement, sentAt: readonly string[] = []): void {
    if (manifests.length === 0 || !this.session || this.privacyCovered) return;
    this.closeImageViewer(true);
    this.voicePlayback.stop();
    this.closeMessageActions();
    this.viewerPreviousSurface = this.activeSurface;
    this.setActiveSurface('away');
    this.viewerReturnFocus = returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const viewer = document.createElement('section');
    viewer.className = 'image-viewer';
    viewer.setAttribute('role', 'dialog');
    viewer.setAttribute('aria-modal', 'true');
    viewer.setAttribute('aria-label', '图片查看器');
    viewer.innerHTML = `
      <header class="viewer-header">
        <button class="viewer-control" type="button" data-viewer-close aria-label="关闭查看器">${icons.close}</button>
        <div><strong data-viewer-name></strong><div class="viewer-metadata"><span data-viewer-counter></span><time data-viewer-time title="发送或上传时间" hidden></time></div></div>
        <button class="viewer-control" type="button" data-viewer-download aria-label="下载当前原图">${icons.download}</button>
      </header>
      <div class="viewer-stage" aria-live="polite"></div>
      <button class="viewer-nav viewer-previous" type="button" aria-label="上一张">${icons.back}</button>
      <button class="viewer-nav viewer-next" type="button" aria-label="下一张">${icons.back}</button>
    `;
    this.root.append(viewer);
    let current = Math.max(0, Math.min(startIndex, manifests.length - 1));
    let renderToken = 0;
    const stage = viewer.querySelector<HTMLElement>('.viewer-stage')!;
    const previous = viewer.querySelector<HTMLButtonElement>('.viewer-previous')!;
    const next = viewer.querySelector<HTMLButtonElement>('.viewer-next')!;
    const gestures = bindImageViewerGestures({
      stage, viewer, itemCount: manifests.length,
      dismiss: downward => {
        if (downward && this.viewerPreviousSurface === 'chat') this.concealChatImages();
        this.closeImageViewer();
      },
      page: direction => { void render(current + direction); },
    });
    this.viewerGestureCleanup = gestures.destroy;
    const reveal = (image: HTMLImageElement) => {
      if (!reducedMotion) image.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
    };
    const render = async (index: number) => {
      current = (index + manifests.length) % manifests.length;
      const token = ++renderToken;
      const manifest = manifests[current]!;
      const video = isVideoFile(manifest);
      this.stopViewerMedia();
      gestures.reset();
      delete viewer.dataset.nativeVideo;
      viewer.classList.toggle('video-viewer', video);
      viewer.setAttribute('aria-label', video ? '视频播放器' : '图片查看器');
      viewer.querySelector('[data-viewer-download]')!.setAttribute('aria-label', video ? '下载当前视频' : '下载当前原图');
      stage.replaceChildren();
      stage.dataset.blobId = manifest.blobId;
      viewer.classList.remove('is-dragging');
      viewer.style.removeProperty('--viewer-backdrop-opacity');
      viewer.querySelector<HTMLElement>('[data-viewer-name]')!.textContent = manifest.originalName || '原图';
      viewer.querySelector<HTMLElement>('[data-viewer-counter]')!.textContent = manifests.length > 1 ? `${current + 1} / ${manifests.length}` : this.fileSize(manifest.originalSize);
      const time = viewer.querySelector<HTMLTimeElement>('[data-viewer-time]')!;
      const timestamp = sentAt[current];
      const date = timestamp ? new Date(timestamp) : null;
      const validDate = date && Number.isFinite(date.getTime());
      time.hidden = !validDate;
      time.dateTime = validDate ? timestamp! : '';
      time.textContent = validDate ? new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(date) : '';
      time.setAttribute('aria-label', validDate ? `发送或上传时间 ${time.textContent}` : '');
      previous.hidden = manifests.length < 2;
      next.hidden = manifests.length < 2;
      this.assertImageManifestIdentity(manifest);
      const cached = this.imageCache.get(manifest.blobId);
      if (!cached) {
        const loading = document.createElement('p');
        loading.className = 'viewer-loading';
        loading.setAttribute('role', 'status');
        loading.innerHTML = `${video ? icons.video : icons.image}<span class="sr-only">正在加载${video ? '视频' : '图片'}</span>`;
        stage.replaceChildren(loading);
      }
      try {
        const loaded = cached ?? await this.loadImage(manifest);
        if (!viewer.isConnected || viewer.classList.contains('is-closing') || token !== renderToken) return;
        if (video) {
          this.renderViewerVideo(stage, loaded, manifest, Boolean(cached));
          return;
        }
        const image = document.createElement('img');
        image.src = loaded.url;
        image.alt = manifest.originalName || `第 ${current + 1} 张图片`;
        image.draggable = false;
        stage.replaceChildren(image);
        reveal(image);
        const adjacent = manifests[(current + 1) % manifests.length];
        if (adjacent && !isVideoFile(adjacent) && adjacent !== manifest && !(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) {
          void this.loadImage(adjacent).catch(() => undefined);
        }
      } catch (cause) {
        if (!viewer.isConnected || token !== renderToken) return;
        const error = document.createElement('button');
        error.type = 'button';
        error.className = 'viewer-error';
        error.textContent = cause instanceof Error ? `${cause.message}，点按重试` : '原图载入失败，点按重试';
        error.addEventListener('click', () => void render(current));
        stage.replaceChildren(error);
      }
    };
    previous.addEventListener('click', () => void render(current - 1));
    next.addEventListener('click', () => void render(current + 1));
    viewer.querySelector('[data-viewer-close]')?.addEventListener('click', () => this.closeImageViewer());
    viewer.querySelector('[data-viewer-download]')?.addEventListener('click', async () => {
      try {
        this.beginFileExport();
        const manifest = manifests[current]!;
        const cached = await this.loadImage(manifest);
        if (!viewer.isConnected || this.privacyCovered) return;
        this.beginFileExport();
        await this.withSystemSurface(() => downloadBlob(isVideoFile(manifest) ? cached.blob.slice(0, cached.blob.size, 'application/octet-stream') : cached.blob, manifest.originalName || 'image'));
      } catch (cause) {
        this.finishFileExport();
        this.operationalError(cause, '原图保存失败');
      }
    });
    stage.addEventListener('contextmenu', (event) => event.preventDefault());
    this.viewerKeyHandler = (event: KeyboardEvent) => {
      if (!viewer.isConnected || viewer.classList.contains('is-closing')) return;
      if (event.key === 'ArrowLeft' && !(event.target instanceof HTMLVideoElement) && manifests.length > 1) {
        event.preventDefault();
        void render(current - 1);
      }
      if (event.key === 'ArrowRight' && !(event.target instanceof HTMLVideoElement) && manifests.length > 1) {
        event.preventDefault();
        void render(current + 1);
      }
      if (event.key === 'Tab') {
        const buttons = [...viewer.querySelectorAll<HTMLElement>('button:not([hidden]), video[controls]')];
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
    void render(current);
  }

  private closeImageViewer(immediate = false): void {
    const viewer = this.root.querySelector<HTMLElement>('.image-viewer');
    if (this.viewerKeyHandler) document.removeEventListener('keydown', this.viewerKeyHandler);
    this.viewerKeyHandler = null;
    this.viewerGestureCleanup?.();
    this.viewerGestureCleanup = null;
    if (!viewer || (!immediate && viewer.classList.contains('is-closing'))) return;
    this.stopViewerMedia();
    const previousSurface = this.viewerPreviousSurface;
    const returnFocus = this.viewerReturnFocus;
    this.viewerReturnFocus = null;
    const finish = () => {
      if (!viewer.isConnected) return;
      viewer.remove();
      if (this.privacyCovered || this.root.querySelector('.image-viewer')) return;
      this.setActiveSurface(previousSurface);
      if (!immediate && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    };
    if (immediate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      finish();
      return;
    }
    viewer.classList.remove('is-visible', 'is-dragging');
    viewer.classList.add('is-closing');
    window.setTimeout(finish, 220);
  }

  private renderGallery(tab: GalleryTab = 'images'): void {
    const session = this.session;
    if (!session || this.privacyCovered) return;
    const epoch = this.runtimeEpoch;
    const signal = this.runtimeAbort?.signal;
    this.setActiveSurface('away');
    if (session.vault.role !== 'creator') {
      this.renderChat();
      this.showNotice('保险箱仅对会话创建者开放', 'error');
      return;
    }
    // Reveals belong to this visit, never to stored preferences or the verified
    // image cache. Tab changes and upload refreshes retain only explicit reveals.
    if (!this.root.querySelector('.gallery-shell')) this.galleryRevealedAssets.clear();
    const cryptoReady = session.vault.protocol !== 'mls-rfc9420' || session.vault.mls?.phase === 'active';
    const filesTab = tab === 'files';
    const category = filesTab ? '文件' : '照片和视频';
    const knownCount = this.galleryKnownCounts[tab] ??= { keys: new Set(), complete: false };
    knownCount.complete = false;
    const assets: GalleryAsset[] = [];
    const assetKeys = new Set<string>();
    let fileCount = 0;
    this.galleryObserver?.disconnect();
    this.galleryObserver = null;
    // Keep the segment control mounted across category changes so its capsule
    // can finish one continuous translation without a header layout reset.
    const retainedTabs = this.root.querySelector<HTMLElement>('.gallery-tabs');
    retainedTabs?.remove();
    this.root.innerHTML = `
      <section class="gallery-shell" aria-label="保险箱">
        <header class="subpage-header gallery-header" aria-label="保险箱操作">
          <button class="icon-button" id="gallery-back" type="button" aria-label="返回聊天">${icons.back}</button>
          <div class="gallery-tabs" role="tablist" aria-label="保险箱分类" data-active-tab="${tab}">
            <button class="gallery-tab" id="gallery-tab-images" type="button" role="tab" aria-controls="gallery-grid" aria-selected="${!filesTab}" tabindex="${filesTab ? -1 : 0}"><span>相册</span><span class="gallery-tab-count" aria-hidden="true" data-gallery-count="images" hidden></span></button>
            <button class="gallery-tab" id="gallery-tab-files" type="button" role="tab" aria-controls="gallery-grid" aria-selected="${filesTab}" tabindex="${filesTab ? 0 : -1}"><span>文件</span><span class="gallery-tab-count" aria-hidden="true" data-gallery-count="files" hidden></span></button>
          </div>
          <nav class="gallery-header-actions" aria-label="保险箱操作">
            ${filesTab ? '' : `<button class="icon-button gallery-visibility-button" id="gallery-toggle-visibility" type="button" aria-label="显示全部" title="显示全部" aria-controls="gallery-grid" disabled>${icons.eye}</button>`}
            <button class="icon-button gallery-upload-button${cryptoReady ? '' : ' is-disabled'}" id="open-gallery-image-picker" type="button" aria-label="上传照片、视频或文件到保险箱" title="上传照片、视频或文件到保险箱" ${cryptoReady ? '' : 'disabled'}>${icons.upload}</button>
          </nav>
          <input id="gallery-image-input" type="file" multiple ${cryptoReady ? '' : 'disabled'} hidden />
        </header>
        <div class="notice gallery-notice" id="notice" role="status" hidden></div>
        <div class="upload-progress gallery-upload-progress" id="upload-progress" hidden><span></span><output></output></div>
        <div class="gallery-grid${filesTab ? ' gallery-file-list' : ''}" id="gallery-grid" role="tabpanel" aria-labelledby="gallery-tab-${tab}" tabindex="0"></div>
      </section>
    `;
    if (retainedTabs) {
      this.root.querySelector('.gallery-tabs')!.replaceWith(retainedTabs);
      this.root.querySelector<HTMLElement>('.gallery-shell')!.style.animation = 'none';
    }
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
    if (retainedTabs && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      grid.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });
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
    const updateTileVisibility = (button: HTMLButtonElement, key: string, manifest: ImageManifest) => {
      const revealed = this.galleryRevealedAssets.has(key);
      const changed = button.dataset.revealed !== undefined && button.dataset.revealed !== String(revealed);
      button.dataset.revealed = String(revealed);
      button.setAttribute('aria-label', `${isVideoFile(manifest) ? revealed ? '播放视频' : '显示视频' : revealed ? '查看原图' : '显示图片'} ${manifest.originalName}`);
      const image = button.querySelector('img');
      // Conceal immediately, then fade the concealed result in. This never
      // leaves a clear outgoing frame during hide or privacy teardown.
      if (changed && image && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        image.getAnimations().forEach(animation => animation.cancel());
        image.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 220, easing: 'ease-in-out' });
      }
    };
    visibilityButton?.addEventListener('click', () => {
      if (!this.isRuntimeActive(epoch, session) || !grid.isConnected) return;
      const reveal = !allImagesRevealed();
      // Also forget revealed older pages that are not mounted after a tab switch.
      if (!reveal) this.galleryRevealedAssets.clear();
      for (const button of grid.querySelectorAll<HTMLButtonElement>('.gallery-tile')) {
        const asset = assets[Number(button.dataset.galleryIndex)];
        if (!asset) continue;
        const key = `${asset.clientMsgId}:${asset.assetIndex}`;
        if (reveal) this.galleryRevealedAssets.add(key);
        updateTileVisibility(button, key, asset.manifest);
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
    const addMessages = (messages: DecryptedMessage[]) => {
      for (const message of messages) {
        if (message.payload.kind === 'gallery-file' && !isVideoFile(message.payload.file)) {
          if (!filesTab) continue;
          const key = `${message.clientMsgId}:file`;
          if (assetKeys.has(key)) continue;
          assetKeys.add(key);
          knownCount.keys.add(key);
          fileCount += 1;
          const button = this.createFileAttachment(message.payload.file);
          button.classList.add('gallery-file');
          const time = document.createElement('time');
          time.className = 'gallery-file-time';
          time.textContent = timeLabel(message.payload.sentAt);
          button.querySelector('.file-attachment-copy')!.append(time);
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
          knownCount.keys.add(key);
          const index = assets.length;
          assets.push({ manifest, clientMsgId: message.clientMsgId, sentAt: message.payload.sentAt, assetIndex });
          const button = document.createElement('button');
          button.type = 'button';
          const video = isVideoFile(manifest);
          button.className = `gallery-tile${video ? ' video-preview' : ''}`;
          button.dataset.galleryIndex = String(index);
          button.dataset.blobId = manifest.blobId;
          updateTileVisibility(button, key, manifest);
          button.innerHTML = `<span class="gallery-skeleton" aria-hidden="true"></span><span class="tile-loading sr-only" role="status">正在加载${video ? '视频' : '图片'}</span>`;
          button.dataset.thumbnailState = 'pending';
          button.setAttribute('aria-busy', 'true');
          button.addEventListener('click', () => {
            if (!this.isRuntimeActive(epoch, session) || !button.isConnected) return;
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
            this.openImageViewer(assets.map((asset) => asset.manifest), index, button, assets.map((asset) => asset.sentAt));
          });
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
      status.textContent = `正在查找${category}…`;
      const startedWith = assets.length + fileCount;
      try {
        // Skip text-only batches without exposing plaintext media metadata in
        // IndexedDB or coupling the album to the chat's current history page.
        do {
          const page = await loadMediaHistoryPage(session, { beforeSeq, signal });
          if (!this.isRuntimeActive(epoch, session) || !grid.isConnected) return;
          beforeSeq = page.beforeSeq ?? undefined;
          hasMore = page.hasMore;
          addMessages(page.messages);
          if (hasMore && assets.length + fileCount - startedWith < 36) await this.abortableDelay(0, signal);
        } while (hasMore && assets.length + fileCount - startedWith < 36);
        knownCount.complete = !hasMore;
        updateCounts();
        status.textContent = hasMore ? '' : assets.length + fileCount ? `已加载本机保存的全部${category}`
          : filesTab ? '从保险箱上传的文档、压缩包等文件会显示在这里。' : '聊天中的照片、视频和从保险箱上传的照片、视频会显示在这里。';
        if (!hasMore && !assets.length && !fileCount) {
          const empty = document.createElement('p');
          empty.className = 'gallery-empty';
          empty.textContent = `还没有${category}`;
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
    this.setActiveSurface('away');
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

  private async updateSafetyCode(): Promise<void> {
    const target = this.root.querySelector<HTMLElement>('#safety-code');
    if (!target || !this.session) return;
    const activeMembers = this.session.vault.members.filter((member) => member.status === undefined || member.status === 'active');
    if (new Set(activeMembers.map((member) => member.role)).size !== 2) return;
    const fingerprints = await Promise.all(activeMembers.map((member) => bundleFingerprint(memberBundle(member))));
    fingerprints.sort();
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(fingerprints.join(':'))));
    const value = [...digest.slice(0, 12)].map((byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
    target.textContent = value.match(/.{1,4}/g)?.join(' ') ?? value;
  }

  private showNotice(message: string, tone: 'error' | 'info' = 'info'): void {
    const notice = this.root.querySelector<HTMLElement>('#notice');
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

  private fileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  }

  private lockNow({ preserveFilePicker = false }: { preserveFilePicker?: boolean } = {}): void {
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
    this.callVault = null;
    this.callView?.destroy();
    this.callView = null;
    this.callPermissionActive = false;
    this.callReturnFocus = null;
    this.root.inert = false;
    document.body.classList.remove('call-active');
    this.closeVoiceRecorder();
    this.voiceGesture?.destroy();
    this.voiceGesture = null;
    this.voicePlayback.stop();
    this.captureChatAnchor(false);
    const composer = this.root.querySelector<HTMLTextAreaElement>('#message-input');
    if (composer) {
      this.uiPreferences.composerDraft = composer.value;
      composer.value = '';
    }
    this.sendingTextDrafts.clear();
    this.imageBatchUploading = false;
    if (this.blurLockTimer !== null) window.clearTimeout(this.blurLockTimer);
    this.blurLockTimer = null;
    if (this.preferenceSaveTimer !== null) window.clearTimeout(this.preferenceSaveTimer);
    this.preferenceSaveTimer = null;
    this.flushUiPreferencesSave();
    this.runtimeEpoch += 1;
    this.runtimeAbort?.abort();
    this.runtimeAbort = null;
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
    this.reactionHistory.clear();
    this.clearMessageTextSelection();
    this.pending.clear();
    this.outbox.clear();
    this.pendingReceipts.clear();
    this.serverQueue.clear();
    this.receiptQueue.clear();
    this.uploadPlans = [];
    for (const timer of this.retryTimers.values()) window.clearTimeout(timer);
    this.retryTimers.clear();
    this.retryCounts.clear();
    this.sending.clear();
    this.renderedMessages.clear();
    this.renderedMessageOrder = [];
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
    this.stopViewerMedia();
    this.root.querySelector('.image-viewer')?.remove();
    delete this.root.dataset.pageTransition;
    this.restoreComposerFocusAfterPicker = false;
    this.keepComposerKeyboard = false;
    this.composerSelection = null;
    this.finishFileExport();
    this.draining = false;
    this.receiptDraining = false;
    this.unlocking = false;
    this.deviceVerificationActive = false;
    this.deviceVerificationToken = null;
    this.systemSurfaceTokens.clear();
    for (const cached of this.imageCache.values()) {
      URL.revokeObjectURL(cached.url);
      if (cached.posterUrl) URL.revokeObjectURL(cached.posterUrl);
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
    this.chatLayoutElements = null;
    this.syncChatLayout = () => {};
    this.cancelViewportWork();
    if (this.chatScrollFrame !== null) cancelAnimationFrame(this.chatScrollFrame);
    this.chatScrollFrame = null;
    if (this.presenceRefreshTimer !== null) window.clearInterval(this.presenceRefreshTimer);
    this.presenceRefreshTimer = null;
    if (this.recoveryPollTimer !== null) window.clearTimeout(this.recoveryPollTimer);
    this.recoveryPollTimer = null;
    this.activeSurface = 'away';
    this.uiPreferences = {};
    this.chatRestoreAnchor = null;
    this.restoreChatAnchorOnNextRender = true;
    this.galleryScrollTop = { images: 0, files: 0 };
    this.galleryRevealedAssets.clear();
    this.chatRevealedAssets.clear();
    this.galleryKnownCounts = {};
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
        this.socket.sendCall(envelope);
      },
      getIceConfig: async () => {
        const vault = this.callVault;
        if (!vault || !this.isRuntimeActive(epoch, session)) throw new Error('安全通话尚未就绪');
        const config = await getCallConfiguration(session.vault.roomId, session.vault.accessToken, this.runtimeAbort?.signal);
        const verifiedPeerIds = await verifyCallIdentityAttestations(vault, config.callIdentities ?? []);
        if (!this.isRuntimeActive(epoch, session) || this.callVault !== vault) throw new Error('设备状态已更新，请重试通话');
        return { ...config, verifiedPeerIds };
      },
      onChange: state => {
        if (this.isRuntimeActive(epoch, session)) this.updateCallView(state);
      },
      onPermissionChange: active => {
        if (this.callController === controller && this.isRuntimeActive(epoch, session)) this.callPermissionActive = active;
      },
    });
    this.callController = controller;
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
      this.root.inert = false;
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
