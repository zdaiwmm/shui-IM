import QRCode from 'qrcode';
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
  joinRoom,
  listDeviceLinks,
  publishMlsMembership,
  publishMlsWelcome,
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
import { decryptImageFile, encryptImageFile, MAX_IMAGE_BYTES } from './lib/file-crypto';
import { MAX_IMAGE_ALBUM_BYTES, MAX_IMAGE_ALBUM_ITEMS } from './lib/message-payload';
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
  ImageManifest,
  ImageUploadPlan,
  MessagePayload,
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
  downloadRecoveryPackage,
  hasStoredVault,
  importRecoveryPackage,
  bindRecoveredVaultToPlatform,
  loadHistoryPage,
  loadHistoryPageAfter,
  loadOutbox,
  loadPendingReceipts,
  loadUploadPlans,
  loadUiPreferences,
  migrateVaultToPlatform,
  readStoredVault,
  saveOutboxItem,
  savePendingReceipt,
  saveHistoryMessage,
  saveUploadPlan,
  saveUiPreferences,
  saveVault,
  unlockRecoveryVault,
  unlockVault,
  type VaultSession,
  type ChatScrollAnchor,
  type UiPreferences,
} from './lib/vault';

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

const CLIENT_CAPABILITIES = ['mls-multidevice-v1', 'reply-v2', 'passkey-only-v3', 'image-album-v1'];

type CachedImage = { blob: Blob; url: string; bytes: number; lastUsedAt: number };
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
  back: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>',
  image: '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m21 15-5-5L5 20"/></svg>',
  upload: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 16V4"/><path d="m8 8 4-4 4 4"/><path d="M5 20h14"/></svg>',
  more: '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>',
  send: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>',
  lock: '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
  download: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M5 21h14"/></svg>',
  bell: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg>',
  smile: '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8 14.5c1 1.3 2.3 2 4 2s3-.7 4-2"/><path d="M9 9.5h.01M15 9.5h.01"/></svg>',
  reply: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m9 17-5-5 5-5"/><path d="M4 12h9a7 7 0 0 1 7 7"/></svg>',
  close: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>',
};

const composerEmojiGroups = [
  {
    label: '常用',
    emojis: ['😀', '😃', '😄', '😁', '😆', '😂', '🤣', '🥹', '😊', '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😋', '😎', '🤩', '🤓', '🧐'],
  },
  {
    label: '心情',
    emojis: ['🤔', '🫡', '🤗', '🤭', '🫢', '🫣', '😶', '😐', '😑', '🙄', '😏', '😒', '😔', '🥺', '😭', '😤', '😡', '🤯', '😳', '🥶'],
  },
  {
    label: '手势',
    emojis: ['👍', '👎', '👌', '✌️', '🤞', '🫰', '🤟', '🤘', '🤙', '👈', '👉', '👆', '👇', '☝️', '👏', '🙌', '🫶', '🙏', '💪', '🤝'],
  },
  {
    label: '爱心',
    emojis: ['❤️', '🩷', '🧡', '💛', '💚', '🩵', '💙', '💜', '🤎', '🖤', '🩶', '🤍', '💔', '❤️‍🔥', '💕', '💞', '💓', '💗', '💖', '💘'],
  },
  {
    label: '生活',
    emojis: ['🎉', '✨', '🔥', '💯', '🌙', '☀️', '🌹', '🌈', '⭐', '🍀', '☕', '🍻', '🎂', '🎁', '🎵', '📷', '💡', '✅', '❗', '🚀'],
  },
] as const;

const composerEmojis: readonly string[] = composerEmojiGroups.flatMap((group) => [...group.emojis]);

const memeLibrary = [
  { id: 'laughing', code: '1F923', label: '笑到打滚' },
  { id: 'thinking', code: '1F914', label: '让我想想' },
  { id: 'cool', code: '1F60E', label: '稳了' },
  { id: 'crying', code: '1F62D', label: '真的会谢' },
  { id: 'screaming', code: '1F631', label: '震惊' },
  { id: 'eyeroll', code: '1F644', label: '无语' },
  { id: 'salute', code: '1FAE1', label: '收到' },
  { id: 'melting', code: '1FAE0', label: '我融化了' },
] as const;

type ExpressionTab = 'emoji' | 'meme' | 'favorites';
type GalleryAsset = { manifest: ImageManifest; clientMsgId: string; sentAt: string; assetIndex: number };

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

export class QuietRoomApp {
  private session: VaultSession | null = null;
  private socket: RoomSocket | null = null;
  private messages = new Map<number, DecryptedMessage>();
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
  private sendChain: Promise<void> = Promise.resolve();
  private membershipChain: Promise<void> = Promise.resolve();
  private sending = new Set<string>();
  private retryTimers = new Map<string, number>();
  private retryCounts = new Map<string, number>();
  private renderedMessages = new Map<string, { signature: string; element: HTMLElement }>();
  private gesturePad: GesturePad | null = null;
  private privacyCovered = true;
  private runtimeAbort: AbortController | null = null;
  private runtimeEpoch = 0;
  private filePickerActive = false;
  private imagePickerActive = false;
  private imagePickerResetTimer: number | null = null;
  private deferredImageUpload: { files: File[]; destination: 'chat' | 'gallery' } | null = null;
  private unlocking = false;
  private deviceVerificationActive = false;
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
  private uiPreferences: UiPreferences = { favoriteExpressions: [] };
  private restoreChatAnchorOnNextRender = true;
  private expressionTab: ExpressionTab = 'emoji';
  private galleryScrollTop = 0;
  private viewerKeyHandler: ((event: KeyboardEvent) => void) | null = null;
  private viewerReturnFocus: HTMLElement | null = null;
  private viewerPreviousSurface: 'away' | 'chat' = 'away';
  private replyTarget: DecryptedMessage | null = null;
  private messageHoldTimer: number | null = null;
  private messageHoldStart: { x: number; y: number } | null = null;
  private suppressMediaClickUntil = 0;
  private messageHighlightTimer: number | null = null;

  constructor(private readonly root: HTMLElement) {
    const preventZoom = (event: Event) => event.preventDefault();
    const syncVisualViewport = () => {
      const viewport = window.visualViewport;
      document.documentElement.style.setProperty('--app-height', `${Math.round(viewport?.height ?? window.innerHeight)}px`);
      document.documentElement.style.setProperty('--app-top', `${Math.round(viewport?.offsetTop ?? 0)}px`);
    };
    syncVisualViewport();
    window.visualViewport?.addEventListener('resize', syncVisualViewport, { passive: true });
    window.visualViewport?.addEventListener('scroll', syncVisualViewport, { passive: true });
    window.addEventListener('resize', syncVisualViewport, { passive: true });
    document.addEventListener('gesturestart', preventZoom, { passive: false });
    document.addEventListener('gesturechange', preventZoom, { passive: false });
    document.addEventListener('gestureend', preventZoom, { passive: false });
    document.addEventListener('dblclick', preventZoom, { capture: true, passive: false });
    document.addEventListener('wheel', (event) => {
      if (event.ctrlKey || event.metaKey) event.preventDefault();
    }, { passive: false });
    document.addEventListener('pointerdown', () => this.resetIdleLock(), { capture: true, passive: true });
    document.addEventListener('pointerdown', (event) => {
      const menu = this.root.querySelector<HTMLDetailsElement>('.more-menu[open]');
      if (menu && event.target instanceof Node && !menu.contains(event.target)) this.closeMoreMenu(menu);
      const picker = this.root.querySelector<HTMLElement>('.emoji-picker.is-visible');
      const composer = this.root.querySelector<HTMLElement>('#composer');
      if (picker && composer && event.target instanceof Node && !composer.contains(event.target)) this.setEmojiPickerOpen(false);
      const textarea = this.root.querySelector<HTMLTextAreaElement>('#message-input');
      if (
        textarea && document.activeElement === textarea && composer &&
        event.target instanceof Node && !composer.contains(event.target)
      ) {
        this.keepComposerKeyboard = false;
        textarea.blur();
      }
      const messageActions = this.root.querySelector<HTMLElement>('.message-actions');
      if (messageActions && event.target instanceof Node && !messageActions.contains(event.target)) this.closeMessageActions();
    }, { capture: true, passive: true });
    document.addEventListener('keydown', (event) => {
      this.resetIdleLock();
      if (event.key !== 'Escape') return;
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
      const emojiPicker = this.root.querySelector<HTMLElement>('.emoji-picker.is-visible');
      if (emojiPicker) {
        event.preventDefault();
        this.setEmojiPickerOpen(false);
        this.root.querySelector<HTMLButtonElement>('#emoji-button')?.focus();
        return;
      }
      const menu = this.root.querySelector<HTMLDetailsElement>('.more-menu[open]');
      if (!menu) return;
      this.closeMoreMenu(menu, true);
    }, { capture: true });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && !this.imagePickerActive && !this.deviceVerificationActive && !this.fileExportActive) {
        this.lockNow({ preserveFilePicker: this.filePickerActive });
      }
    });
    window.addEventListener('blur', () => {
      if (!this.imagePickerActive && !this.deviceVerificationActive && !this.fileExportActive) {
        this.lockNow({ preserveFilePicker: this.filePickerActive });
      }
    });
    window.addEventListener('focus', () => this.finishFileExport());
    window.addEventListener('pagehide', () => {
      this.finishImagePicker();
      this.lockNow({ preserveFilePicker: false });
    });
  }

  async start(): Promise<void> {
    this.renderCover();
  }

  private renderCover(preserveFilePicker = false): void {
    this.setActiveSurface('away');
    this.cleanupRuntime(preserveFilePicker);
    this.privacyCovered = true;
    document.body.className = 'cover-mode';
    this.root.innerHTML = `
      <section class="cover" aria-label="已隐藏的私密空间">
        <button class="cover-trigger" type="button" aria-label="长按一秒打开私密空间"></button>
      </section>
    `;
    const trigger = this.root.querySelector<HTMLButtonElement>('.cover-trigger')!;
    const begin = () => {
      this.cancelCoverTimer();
      trigger.classList.add('is-holding');
      this.coverTimer = window.setTimeout(() => {
        this.coverTimer = null;
        navigator.vibrate?.(20);
        void this.renderGateway();
      }, 1000);
    };
    const cancel = () => {
      trigger.classList.remove('is-holding');
      this.cancelCoverTimer();
    };
    trigger.addEventListener('pointerdown', begin);
    trigger.addEventListener('pointerup', cancel);
    trigger.addEventListener('pointercancel', cancel);
    trigger.addEventListener('pointerleave', cancel);
    trigger.addEventListener('keydown', (event) => {
      if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) begin();
    });
    trigger.addEventListener('keyup', cancel);
  }

  private cancelCoverTimer(): void {
    if (this.coverTimer !== null) window.clearTimeout(this.coverTimer);
    this.coverTimer = null;
  }

  private async renderGateway(): Promise<void> {
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
      this.gatewayTemplate('回到会话', '使用本机通行密钥或生物识别解锁。', `
        <button class="primary-button" id="passkey-unlock" type="button">使用通行密钥解锁</button>
        <p class="form-error" role="alert"></p>
        <div class="gateway-secondary">
          <button class="text-button" id="back-to-cover" type="button">返回白屏</button>
        </div>
      `);
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
    }
    this.root.querySelector('#back-to-cover')?.addEventListener('click', () => this.lockNow());
  }

  private renderCorruptVault(): void {
    this.gatewayTemplate('本机数据需要恢复', '检测到本地保险库存在，但格式已经损坏或无法识别。不要直接清除浏览器数据。', `
      <div class="corrupt-vault-panel">
        <p class="form-error" role="alert">请先尝试导入之前导出的恢复包；诊断文件不包含解密密钥或消息明文。</p>
        <label class="primary-button file-button">导入恢复包<input id="corrupt-recovery-file" type="file" accept="application/json,.json" /></label>
        <button class="secondary-button" id="download-vault-diagnostic" type="button">下载诊断信息</button>
        <button class="text-button" id="clear-corrupt-vault" type="button">确认清除损坏的本机数据</button>
      </div>
      <div class="gateway-secondary"><button class="text-button" id="corrupt-vault-lock" type="button">返回白屏</button></div>
    `);
    const input = this.root.querySelector<HTMLInputElement>('#corrupt-recovery-file');
    input?.addEventListener('change', async (event) => {
      const file = (event.currentTarget as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        await importRecoveryPackage(file);
        if (!this.privacyCovered) void this.renderUnlock();
      } catch (cause) {
        this.showFormError(cause);
      }
    });
    this.root.querySelector('#download-vault-diagnostic')?.addEventListener('click', () => {
      void downloadVaultDiagnostic().catch((cause) => this.showFormError(cause));
    });
    this.root.querySelector('#clear-corrupt-vault')?.addEventListener('click', async () => {
      if (!window.confirm('确认清除损坏的本机数据？只有在你已经尝试恢复或确定不再需要它时才继续。')) return;
      try {
        await deleteCurrentVault();
        if (!this.privacyCovered) this.renderFirstRun(null);
      } catch (cause) {
        this.showFormError(cause);
      }
    });
    this.root.querySelector('#corrupt-vault-lock')?.addEventListener('click', () => this.lockNow());
  }

  private renderRecoveryUnlock(): void {
    this.gatewayTemplate('恢复加密保险库', '输入导出时单独显示的恢复码。恢复文件和恢复码缺一不可。', `
      <form class="gateway-form" id="recovery-code-form">
        <label>恢复码<textarea name="recovery-code" rows="3" autocomplete="off" spellcheck="false" required autofocus placeholder="QR2-…"></textarea></label>
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
      busy = true;
      error.textContent = '';
      setBusy(verifyButton, true, preparedPlatformCredential ? '正在重试…' : '正在验证…');
      void (async () => {
        try {
          preparedPlatformCredential ??= await this.withDeviceVerification(() => createPlatformCredential());
          await onConfirmed(preparedPlatformCredential);
        } catch (cause) {
          if (!verifyButton.isConnected) return;
          error.textContent = cause instanceof Error ? cause.message : '通行密钥设置失败';
          if (preparedPlatformCredential) verifyButton.dataset.label = '重试';
        } finally {
          busy = false;
          if (verifyButton.isConnected) setBusy(verifyButton, false);
        }
      })();
    });
  }

  private async withDeviceVerification<T>(operation: () => Promise<T>): Promise<T> {
    // A passkey prompt is allowed to suppress its own blur only before a
    // decrypted session exists. Migration/recovery binding already holds one,
    // so those prompts must retain the normal fail-closed lock behavior.
    if (this.session) return operation();
    this.deviceVerificationActive = true;
    try {
      return await operation();
    } finally {
      this.deviceVerificationActive = false;
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
        <label class="choice-row file-choice">
          <span><strong>导入恢复包</strong><small>恢复之前导出的本机加密保险库</small></span>
          <span aria-hidden="true">↑</span>
          <input id="recovery-file" type="file" accept="application/json,.json" />
        </label>
      </div>
      <p class="form-error" role="alert"></p>
    `);
    this.root.querySelector('#create-room')?.addEventListener('click', () => this.renderCreate());
    this.root.querySelector('#join-room')?.addEventListener('click', () => this.renderPasteInvite());
    const recoveryInput = this.root.querySelector<HTMLInputElement>('#recovery-file');
    recoveryInput?.addEventListener('click', () => { this.filePickerActive = true; });
    recoveryInput?.addEventListener('cancel', () => { this.filePickerActive = false; });
    recoveryInput?.addEventListener('change', async (event) => {
      const file = (event.currentTarget as HTMLInputElement).files?.[0];
      this.filePickerActive = false;
      if (!file) return;
      try {
        await importRecoveryPackage(file);
        if (!this.privacyCovered) void this.renderUnlock();
      } catch (cause) {
        if (!this.privacyCovered) this.showFormError(cause);
      }
    });
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
    this.root.querySelector('.gateway-back')?.addEventListener('click', () => this.renderFirstRun(null));
  }

  private async handleCreate(platformResult: PlatformCredentialResult): Promise<void> {
    let room: { roomId: string; createdAt: string; protocol: 'legacy-v1' | 'mls-rfc9420' } | null = null;
    let vaultCreated = false;
    const accessToken = randomBase64Url(32);
    const inviteToken = randomBase64Url(32);
    try {
      const identity = await generateIdentity();
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
      const createdSession = await createVault(vault, '', 'platform', platformResult);
      vaultCreated = true;
      if (this.privacyCovered) {
        await deleteRoom(room.roomId, accessToken).catch(() => undefined);
        return;
      }
      this.session = createdSession;
      await this.openSession();
    } catch (cause) {
      // Once the vault is durable, preserve the room so a transient local/network
      // failure can be retried instead of deleting a valid session on the server.
      if (room && !vaultCreated) {
        const persisted = await readStoredVault().catch(() => null);
        if (!persisted) await deleteRoom(room.roomId, accessToken).catch(() => undefined);
      }
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
      this.renderJoin(invite);
    });
    this.root.querySelector('.gateway-back')?.addEventListener('click', () => this.renderFirstRun(null));
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
    this.root.querySelector('.gateway-back')?.addEventListener('click', () => this.renderFirstRun(null));
  }

  private async handleJoin(
    invite: Invite,
    platformResult: PlatformCredentialResult,
  ): Promise<void> {
    try {
      const initialState = await getRoomState(invite.roomId, invite.accessToken);
      if (this.privacyCovered) return;
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
      const createdSession = await createVault(vault, '', 'platform', platformResult);
      if (this.privacyCovered) return;
      this.session = createdSession;
      history.replaceState(null, '', `${location.pathname}${location.search}`);
      await this.completePendingJoin();
      if (this.privacyCovered) return;
      await this.openSession();
    } catch (cause) {
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
    const status = await getDeviceLinkStatus(invite.linkId, invite.secret);
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
    const createdSession = await createVault(vault, '', 'platform', platformResult);
    if (this.privacyCovered) return;
    this.session = createdSession;
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    try {
      await this.completePendingDeviceLink();
      if (createdSession.vault.pairingState === 'ready') await this.openSession();
      else await this.renderPendingDeviceLink();
    } catch (cause) {
      await this.renderPendingDeviceLink(cause);
    }
  }

  private async completePendingDeviceLink(): Promise<void> {
    const session = this.session;
    if (!session || session.vault.pairingState !== 'linking') return;
    const pending = session.vault.pendingDeviceLinks?.find((item) => item.linkId === session.vault.pendingDeviceLinkId);
    if (!pending) throw new SecurityViolation('本机设备链接凭据缺失');
    let result = await getDeviceLinkStatus(pending.linkId, pending.secret, session.vault.accessToken);
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
      own = result.state.members.find((member) => member.deviceId === session.vault.identity.publicBundle.deviceId);
    }
    if (!own || canonicalStringify(memberBundle(own)) !== canonicalStringify(session.vault.identity.publicBundle)) {
      throw new SecurityViolation('服务器返回的新设备身份与本机密钥不一致');
    }
    await this.applyRoomStateQueued(result.state);
    own = session.vault.members.find((member) => member.deviceId === session.vault.identity.publicBundle.deviceId);
    if (own?.status !== 'active' || session.vault.mls?.phase !== 'active') return;
    session.vault.historyUnavailableBeforeSeq = own.joinSeq ?? result.state.nextSeq;
    session.vault.lastSeq = Math.max(session.vault.lastSeq, session.vault.historyUnavailableBeforeSeq);
    session.vault.lastReceiptSeq = Math.max(session.vault.lastReceiptSeq ?? 0, own.joinReceiptSeq ?? 0);
    session.vault.pairingState = 'ready';
    session.vault.pendingDeviceLinks = undefined;
    session.vault.pendingDeviceLinkId = undefined;
    await saveVault(session);
  }

  private async renderPendingDeviceLink(cause?: unknown): Promise<void> {
    const session = this.session;
    if (!session) return;
    const pending = session.vault.pendingDeviceLinks?.find((item) => item.linkId === session.vault.pendingDeviceLinkId);
    const own = session.vault.members.find((member) => member.deviceId === session.vault.identity.publicBundle.deviceId);
    const authorizer = session.vault.members.find((member) => member.deviceId === own?.addedBy);
    const code = pending && own && authorizer ? await deviceLinkSafetyCode(pending.linkId, authorizer, own) : '无法计算';
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
        if (session.vault.pairingState === 'ready') await this.openSession();
        else await this.renderPendingDeviceLink();
      } catch (retryCause) {
        await this.renderPendingDeviceLink(retryCause);
      }
    });
    this.root.querySelector('#pending-device-lock')?.addEventListener('click', () => this.lockNow());
  }

  private async openSession(): Promise<void> {
    const session = this.session;
    if (!session || this.privacyCovered) return;
    const epoch = this.runtimeEpoch;
    this.runtimeAbort?.abort();
    this.runtimeAbort = new AbortController();
    this.resetIdleLock();
    await this.preferenceSaveChain.catch(() => undefined);
    this.uiPreferences = await loadUiPreferences(session).catch(() => ({ favoriteExpressions: [] }));
    const anchor = this.uiPreferences.chatAnchor;
    const beforeSeq = anchor && !anchor.pinnedToBottom
      ? Math.min(Number.MAX_SAFE_INTEGER, anchor.seq + 101)
      : undefined;
    const cached = await loadHistoryPage(session, { limit: 200, ...(beforeSeq ? { beforeSeq } : {}) });
    if (!this.isRuntimeActive(epoch, session)) return;
    this.messages = new Map(cached.map((message) => [message.seq, {
      ...message,
      status: message.status === 'sent'
        ? (message.senderId === session.vault.identity.publicBundle.deviceId ? 'stored' : 'delivered')
        : message.status,
    }]));
    this.historyHasMore = cached.length >= 200 && cached.length > 0 && Math.min(...cached.map((message) => message.seq)) > 1;
    this.historyForwardCursor = cached.length > 0
      ? Math.max(...cached.map((message) => message.seq))
      : session.vault.historyUnavailableBeforeSeq ?? 0;
    this.historyHasNewer = this.historyForwardCursor < session.vault.lastSeq;
    let contiguousSeq = session.vault.historyUnavailableBeforeSeq ?? 0;
    while (this.messages.has(contiguousSeq + 1)) contiguousSeq += 1;
    session.vault.lastSeq = Math.max(session.vault.lastSeq, contiguousSeq);
    session.vault.lastReceiptSeq ??= 0;
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
    await saveVault(session);
    if (!this.isRuntimeActive(epoch, session)) return;
    if (session.vault.pairingState === 'joining') {
      try {
        await this.completePendingJoin();
      } catch (cause) {
        this.renderPendingJoin(cause);
        return;
      }
    }
    if (session.vault.pairingState === 'linking') {
      try {
        await this.completePendingDeviceLink();
      } catch (cause) {
        await this.renderPendingDeviceLink(cause);
        return;
      }
      if (session.vault.pairingState === 'linking') {
        await this.renderPendingDeviceLink();
        return;
      }
    }
    if (!this.isRuntimeActive(epoch, session)) return;
    const activeRoles = new Set(session.vault.members.filter((member) => member.status !== 'pending' && member.status !== 'revoked').map((member) => member.role));
    if (activeRoles.size < 2) this.renderInviteWait();
    else this.renderChat();
    this.connectSocket();
    if (activeRoles.size === 2) void this.resumeDeferredImage();
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
    await this.applyRoomStateQueued(state);
    if (!this.isRuntimeActive(epoch, session)) return;
    session.vault.pairingState = 'ready';
    session.vault.inviteToken = undefined;
    await saveVault(session);
  }

  private renderPendingJoin(cause?: unknown): void {
    this.setActiveSurface('away');
    document.body.className = 'app-mode';
    this.gatewayTemplate('正在完成设备绑定', '本机密钥已经安全保存。网络恢复后可使用同一身份继续，不会占用新的名额。', `
      <div class="pending-join-panel">
        <p class="form-error" role="alert" id="pending-join-error"></p>
        <button class="primary-button" id="retry-join" type="button">继续完成绑定</button>
        <button class="text-button" id="pending-lock" type="button">锁定并返回白屏</button>
      </div>
    `);
    this.root.querySelector<HTMLElement>('#pending-join-error')!.textContent = cause instanceof Error
      ? cause.message
      : '绑定尚未完成';
    this.root.querySelector('#retry-join')?.addEventListener('click', async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      setBusy(button, true, '正在重试…');
      try {
        await this.completePendingJoin();
        await this.openSession();
      } catch (retryCause) {
        this.root.querySelector<HTMLElement>('#pending-join-error')!.textContent = retryCause instanceof Error
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
      await this.applyRoomState(state);
    });
    this.membershipChain = operation.catch(() => undefined);
    return operation;
  }

  private async applyRoomState(state: RoomState): Promise<void> {
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
      if (remote && canonicalStringify(memberBundle(remote)) !== canonicalStringify(memberBundle(known))) {
        throw new SecurityViolation('已知设备身份发生变化，已停止连接');
      }
    }
    const originalJoiner = state.members.find((member) => member.role === 'joiner' && Boolean(member.joinProof));
    if (originalJoiner && session.vault.pairingSecret) {
      if (!originalJoiner.joinProof || !(await verifyJoinProof(
        session.vault.pairingSecret,
        memberBundle(originalJoiner),
        originalJoiner.joinProof,
      ))) throw new SecurityViolation('加入设备未通过邀请密钥验证，已停止连接');
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
        if (serverEvent.event.action === 'add') trustedDeviceIds.add(serverEvent.event.targetId);
        else trustedDeviceIds.delete(serverEvent.event.targetId);
      }
      if ((state.nextMlsEventSeq ?? 0) !== (session.vault.mls.lastEventSeq ?? 0)) {
        throw new SecurityViolation('服务器未提供完整的 MLS 设备变更记录');
      }
    }
    session.vault.protocol = localProtocol;
    const activeRoles = new Set(state.members.filter((member) => member.status === 'active').map((member) => member.role));
    if (activeRoles.size === 2) {
      session.vault.inviteToken = undefined;
      session.vault.pairingSecret = '';
    }
    await saveVault(session);
  }

  private isRuntimeActive(epoch: number, session: VaultSession): boolean {
    return !this.privacyCovered && this.runtimeEpoch === epoch && this.session === session;
  }

  private connectSocket(): void {
    const session = this.session;
    if (!session || this.privacyCovered) return;
    const epoch = this.runtimeEpoch;
    this.socket?.close();
    const roomSocket = new RoomSocket(
      session.vault.roomId,
      session.vault.accessToken,
      () => session.vault.lastSeq,
      () => session.vault.lastReceiptSeq ?? 0,
      {
        connection: (state) => {
          if (!this.isRuntimeActive(epoch, session) || this.socket !== roomSocket) return;
          this.connectionState = state;
          if (state !== 'connected') this.rolePresence = null;
          this.updateConnectionStatus();
        },
        presence: (roles) => {
          if (!this.isRuntimeActive(epoch, session) || this.socket !== roomSocket) return;
          this.rolePresence = roles;
          this.updatePeerStatus();
        },
        ready: (state) => {
          if (this.isRuntimeActive(epoch, session) && this.socket === roomSocket) return this.handleMembership(state);
        },
        membership: (state) => {
          if (this.isRuntimeActive(epoch, session) && this.socket === roomSocket) return this.handleMembership(state);
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
    if (!session || session.vault.protocol !== 'mls-rfc9420' || !session.vault.mls) return;
    if (session.vault.role === 'creator') {
      if (state.mlsWelcome) {
        const pending = session.vault.mls.pendingWelcome;
        if (pending && canonicalStringify(pending) !== canonicalStringify(state.mlsWelcome)) {
          throw new SecurityViolation('服务器返回了与本机不一致的 MLS 欢迎消息');
        }
        if (pending) {
          session.vault.mls = { ...session.vault.mls, pendingWelcome: undefined };
          await saveVault(session);
        }
        return;
      }
      if (new Set(state.members.filter((member) => member.status === undefined || member.status === 'active').map((member) => member.role)).size < 2) return;
      session.vault.mls = await prepareCreatorWelcome(session.vault);
      await saveVault(session);
      const pending = session.vault.mls.pendingWelcome;
      if (!pending) throw new Error('MLS 欢迎消息没有持久化');
      const published = await publishMlsWelcome(session.vault.roomId, session.vault.accessToken, pending);
      if (!published.mlsWelcome || canonicalStringify(published.mlsWelcome) !== canonicalStringify(pending)) {
        throw new SecurityViolation('服务器没有确认相同的 MLS 欢迎消息');
      }
      session.vault.mls = { ...session.vault.mls, pendingWelcome: undefined };
      await saveVault(session);
      return;
    }
    if (session.vault.mls.phase === 'active') return;
    if (!state.mlsWelcome) return;
    session.vault.mls = await joinMlsGroup(session.vault, state.mlsWelcome);
    session.vault.identity.mlsPrivatePackage = undefined;
    await saveVault(session);
  }

  private async drainServerQueue(requestMore = false): Promise<void> {
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
          if (payload.kind === 'gallery-image') {
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
            if (!nextMlsGroupState) await savePendingReceipt(session, receipt);
          }
          const previousSeq = session.vault.lastSeq;
          session.vault.lastSeq = message.seq;
          if (nextMlsGroupState) {
            try {
              await commitMlsReceive(session, message, nextMlsGroupState, receipt ?? undefined);
            } catch (cause) {
              session.vault.lastSeq = previousSeq;
              throw cause;
            }
          } else {
            await saveHistoryMessage(session, message);
            try {
              await saveVault(session);
            } catch (cause) {
              session.vault.lastSeq = previousSeq;
              throw cause;
            }
          }
          if (ownDevice) {
            this.clearRetry(message.clientMsgId);
            await deleteOutboxItem(session, message.clientMsgId);
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
      await this.drainReceiptQueue();
    } finally {
      if (this.runtimeEpoch === epoch) this.draining = false;
    }
  }

  private async drainReceiptQueue(requestMore = false): Promise<void> {
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
            await saveVault(session);
          } catch (cause) {
            session.vault.lastReceiptSeq = previousReceiptSeq;
            this.operationalError(cause);
            return;
          }
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
            await saveHistoryMessage(session, message);
          }
          if (!this.isRuntimeActive(epoch, session)) return;
          const previousReceiptSeq = session.vault.lastReceiptSeq ?? 0;
          session.vault.lastReceiptSeq = expected;
          try {
            await saveVault(session);
          } catch (cause) {
            session.vault.lastReceiptSeq = previousReceiptSeq;
            throw cause;
          }
          this.receiptQueue.delete(expected);
          expected += 1;
        } catch (cause) {
          this.operationalError(cause);
          return;
        }
      }
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
      try {
        await navigator.clipboard.writeText(inviteUrl);
      } catch {
        input.select();
        document.execCommand('copy');
      }
      const button = event.currentTarget as HTMLButtonElement;
      button.textContent = '已复制';
      window.setTimeout(() => { button.textContent = '复制邀请链接'; }, 1600);
    });
    this.root.querySelector('#pairing-lock')?.addEventListener('click', () => this.lockNow());
    this.updateConnectionStatus();
  }

  private renderChat(): void {
    if (!this.session) return;
    this.setActiveSurface('chat');
    const cryptoReady = this.session.vault.protocol !== 'mls-rfc9420' || this.session.vault.mls?.phase === 'active';
    this.galleryObserver?.disconnect();
    this.galleryObserver = null;
    this.chatImageObserver?.disconnect();
    this.chatImageObserver = null;
    document.body.className = 'app-mode';
    this.root.innerHTML = `
      <section class="chat-shell">
        <header class="chat-header">
          <div class="peer-summary" role="status" aria-live="polite">
            <span class="presence-stack">
              <span class="presence-row" id="self-presence"><i class="presence-dot" aria-hidden="true"></i><span>我</span><strong>同步中</strong></span>
              <span class="presence-row" id="peer-presence"><i class="presence-dot" aria-hidden="true"></i><span>对方</span><strong>同步中</strong></span>
            </span>
          </div>
          <nav class="header-actions" aria-label="会话操作">
            ${this.session.vault.role === 'creator' ? `
              <button class="icon-button gallery-button" id="open-gallery" type="button" aria-label="查看相册">${icons.image}</button>
            ` : ''}
            <details class="more-menu">
              <summary class="icon-button" aria-label="更多操作">${icons.more}</summary>
              <div class="menu-panel">
                <p class="menu-title">本机安全</p>
                <p class="protocol-label">${this.session.vault.protocol === 'mls-rfc9420' ? 'RFC 9420 MLS · 前向保密' : '旧版静态会话密钥 · 建议重建会话'}</p>
                <p class="safety-label">设备安全码</p>
                <code class="safety-code" id="safety-code">正在计算…</code>
                <button id="manage-devices" type="button">${icons.lock}<span>设备管理</span></button>
                <button id="toggle-notifications" type="button">${icons.bell}<span>后台通知：正在检查…</span></button>
                <button id="export-recovery" type="button">${icons.download}<span>导出加密恢复包</span></button>
                <button id="lock-room" type="button">${icons.lock}<span>立即锁定</span></button>
                <p class="menu-footnote">每台设备使用独立密钥；新设备不会获得加入前的消息密钥。</p>
              </div>
            </details>
          </nav>
        </header>
        <div class="system-notices" aria-label="本机安全提醒">
          ${cryptoReady ? '' : `
            <aside class="crypto-reminder">
              <div><strong>正在建立前向保密会话</strong><span>MLS 欢迎消息完成验证前不会发送任何内容。</span></div>
            </aside>
          `}
          ${this.session.vault.recoveryExportedAt ? '' : `
            <aside class="recovery-reminder">
              <div><strong>先保存恢复包</strong><span>通行密钥不可用或清除浏览器数据后，服务器无法找回密钥。</span></div>
              <button type="button" id="reminder-export">立即导出</button>
            </aside>
          `}
          ${this.uploadPlans.length > 0 ? `
            <aside class="upload-reminder">
              <div><strong>有 ${this.uploadPlans.length} 个原图待续传</strong><span>重新选择同一文件即可从已完成的分块继续。</span></div>
            </aside>
          ` : ''}
        </div>
        <div class="notice" id="notice" role="status" hidden></div>
        <section class="message-list" id="message-list" aria-label="聊天消息"></section>
        <form class="composer" id="composer">
          <div class="reply-draft" id="reply-draft" hidden>
            <div><strong>回复对方</strong><span></span></div>
            <button type="button" aria-label="取消回复">${icons.close}</button>
          </div>
          <div class="emoji-picker" id="emoji-picker" role="dialog" aria-label="选择表情" hidden>
            <nav class="expression-tabs" aria-label="表情分类">
              <button type="button" data-expression-tab="emoji">表情</button>
              <button type="button" data-expression-tab="meme">梗图</button>
              <button type="button" data-expression-tab="favorites">收藏</button>
            </nav>
            <div class="expression-content" id="expression-content"></div>
          </div>
          <button class="image-picker icon-button${cryptoReady ? '' : ' is-disabled'}" id="open-image-picker" type="button" aria-label="发送原图" title="发送原图" ${cryptoReady ? '' : 'disabled'}>${icons.image}</button>
          <input id="image-input" type="file" accept="image/*" multiple ${cryptoReady ? '' : 'disabled'} hidden />
          <div class="composer-field">
            <label class="sr-only" for="message-input">输入消息</label>
            <textarea id="message-input" rows="1" maxlength="4000" placeholder="${cryptoReady ? '输入消息' : '正在建立安全会话…'}" enterkeyhint="send" ${cryptoReady ? '' : 'disabled'}></textarea>
            <button class="emoji-button" id="emoji-button" type="button" aria-label="选择表情" aria-controls="emoji-picker" aria-expanded="false" ${cryptoReady ? '' : 'disabled'}>${icons.smile}</button>
          </div>
          <button class="send-button" type="submit" aria-label="发送消息" ${cryptoReady ? '' : 'disabled'}>${icons.send}</button>
          <div class="upload-progress" id="upload-progress" hidden><span></span><output></output></div>
        </form>
      </section>
    `;
    this.root.querySelector('#composer')?.addEventListener('submit', (event) => void this.handleSendText(event));
    this.root.querySelector('#message-list')?.addEventListener('scroll', (event) => {
      const list = event.currentTarget as HTMLElement;
      if (list.scrollTop < 80) void this.loadOlderHistory(list);
      if (list.scrollHeight - list.scrollTop - list.clientHeight < 80) void this.loadNewerHistory(list);
      this.captureChatAnchor(true);
    }, { passive: true });
    const textarea = this.root.querySelector<HTMLTextAreaElement>('#message-input')!;
    textarea.addEventListener('input', () => {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 128)}px`;
    });
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.root.querySelector<HTMLFormElement>('#composer')?.requestSubmit();
      }
    });
    textarea.addEventListener('blur', () => {
      if (!this.imagePickerActive) this.keepComposerKeyboard = false;
    });
    const imageInput = this.root.querySelector<HTMLInputElement>('#image-input');
    const sendButton = this.root.querySelector<HTMLButtonElement>('.send-button');
    sendButton?.addEventListener('pointerdown', (event) => this.retainComposerKeyboard(event, textarea));
    this.mountEmojiPicker(textarea);
    this.mountImagePicker(imageInput, 'chat', this.root.querySelector<HTMLButtonElement>('#open-image-picker'));
    this.root.querySelector('#open-gallery')?.addEventListener('click', () => this.transitionPage('forward', () => this.renderGallery()));
    this.root.querySelector('#export-recovery')?.addEventListener('click', () => void this.exportRecovery());
    this.root.querySelector('#reminder-export')?.addEventListener('click', () => void this.exportRecovery());
    this.root.querySelector('#lock-room')?.addEventListener('click', () => this.lockNow());
    this.root.querySelector('#manage-devices')?.addEventListener('click', () => this.transitionPage('forward', () => void this.renderDeviceManager()));
    this.root.querySelector('#toggle-notifications')?.addEventListener('click', () => void this.toggleBackgroundNotifications());
    this.root.querySelector('#reply-draft button')?.addEventListener('click', () => {
      this.replyTarget = null;
      this.renderReplyDraft();
      this.restoreComposerFocus();
    });
    const moreMenu = this.root.querySelector<HTMLDetailsElement>('.more-menu');
    moreMenu?.querySelector('summary')?.addEventListener('click', (event) => {
      if (!moreMenu.open) return;
      event.preventDefault();
      this.closeMoreMenu(moreMenu);
    });
    this.renderMessages({ scroll: this.restoreChatAnchorOnNextRender ? 'restore' : 'preserve' });
    this.renderReplyDraft();
    this.updatePeerStatus();
    void this.updateSafetyCode();
    void this.updateBackgroundNotificationControl();
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

  private mountEmojiPicker(textarea: HTMLTextAreaElement): void {
    const button = this.root.querySelector<HTMLButtonElement>('#emoji-button');
    const picker = this.root.querySelector<HTMLElement>('#emoji-picker');
    if (!button || !picker) return;
    this.renderExpressionPickerContents();
    button.addEventListener('pointerdown', (event) => this.retainComposerKeyboard(event, textarea));
    button.addEventListener('click', () => {
      const opening = !picker.classList.contains('is-visible');
      if (opening) {
        this.composerSelection = {
          start: textarea.selectionStart ?? textarea.value.length,
          end: textarea.selectionEnd ?? textarea.value.length,
        };
        textarea.focus({ preventScroll: true });
      }
      this.setEmojiPickerOpen(opening);
    });
    picker.addEventListener('pointerdown', (event) => {
      if (document.activeElement === textarea || this.keepComposerKeyboard) event.preventDefault();
    });
    picker.addEventListener('click', (event) => {
      const element = event.target instanceof Element ? event.target : null;
      const tab = element?.closest<HTMLButtonElement>('[data-expression-tab]')?.dataset.expressionTab as ExpressionTab | undefined;
      if (tab && ['emoji', 'meme', 'favorites'].includes(tab)) {
        this.expressionTab = tab;
        this.renderExpressionPickerContents();
        this.restoreComposerFocus();
        return;
      }
      const favoriteKey = element?.closest<HTMLButtonElement>('[data-favorite-key]')?.dataset.favoriteKey;
      if (favoriteKey) {
        this.toggleFavoriteExpression(favoriteKey);
        this.renderExpressionPickerContents();
        this.restoreComposerFocus();
        return;
      }
      const memeId = element?.closest<HTMLButtonElement>('[data-meme-id]')?.dataset.memeId;
      if (memeId) {
        void this.sendMeme(memeId);
        return;
      }
      const target = element?.closest<HTMLButtonElement>('[data-emoji]');
      const emoji = target?.dataset.emoji;
      if (!emoji) return;
      const start = textarea.selectionStart ?? textarea.value.length;
      const end = textarea.selectionEnd ?? start;
      if (textarea.value.length - (end - start) + emoji.length > textarea.maxLength) return;
      textarea.setRangeText(emoji, start, end, 'end');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      this.composerSelection = {
        start: textarea.selectionStart ?? textarea.value.length,
        end: textarea.selectionEnd ?? textarea.value.length,
      };
      this.restoreComposerFocus();
    });
  }

  private renderExpressionPickerContents(): void {
    const content = this.root.querySelector<HTMLElement>('#expression-content');
    if (!content) return;
    this.root.querySelectorAll<HTMLButtonElement>('[data-expression-tab]').forEach((button) => {
      const active = button.dataset.expressionTab === this.expressionTab;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
    });
    content.replaceChildren();

    const appendFavoriteButton = (container: HTMLElement, key: string) => {
      const favorite = document.createElement('button');
      favorite.type = 'button';
      favorite.className = 'favorite-expression';
      favorite.dataset.favoriteKey = key;
      const selected = this.uiPreferences.favoriteExpressions.includes(key);
      favorite.setAttribute('aria-label', selected ? '取消收藏' : '收藏表情');
      favorite.setAttribute('aria-pressed', String(selected));
      favorite.textContent = selected ? '★' : '☆';
      container.append(favorite);
    };

    const appendEmoji = (emoji: string, parent: HTMLElement) => {
      const item = document.createElement('span');
      item.className = 'expression-item';
      const insert = document.createElement('button');
      insert.type = 'button';
      insert.className = 'emoji-option';
      insert.dataset.emoji = emoji;
      insert.setAttribute('aria-label', `插入 ${emoji}`);
      insert.textContent = emoji;
      item.append(insert);
      appendFavoriteButton(item, `emoji:${emoji}`);
      parent.append(item);
    };

    const appendMeme = (meme: (typeof memeLibrary)[number], parent: HTMLElement) => {
      const item = document.createElement('article');
      item.className = 'meme-option';
      const send = document.createElement('button');
      send.type = 'button';
      send.dataset.memeId = meme.id;
      send.setAttribute('aria-label', `发送梗图：${meme.label}`);
      const image = document.createElement('img');
      image.src = `/memes/openmoji-17.0.0/${meme.code}.svg`;
      image.alt = '';
      image.loading = 'lazy';
      const label = document.createElement('span');
      label.textContent = meme.label;
      send.append(image, label);
      item.append(send);
      appendFavoriteButton(item, `meme:${meme.id}`);
      parent.append(item);
    };

    if (this.expressionTab === 'emoji') {
      for (const group of composerEmojiGroups) {
        const section = document.createElement('section');
        section.className = 'emoji-section';
        const heading = document.createElement('h3');
        heading.textContent = group.label;
        const grid = document.createElement('div');
        grid.className = 'emoji-grid';
        for (const emoji of group.emojis) appendEmoji(emoji, grid);
        section.append(heading, grid);
        content.append(section);
      }
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'meme-grid';
    const favorites = new Set(this.uiPreferences.favoriteExpressions);
    if (this.expressionTab === 'meme') {
      for (const meme of memeLibrary) appendMeme(meme, grid);
    } else {
      for (const key of favorites) {
        if (key.startsWith('emoji:')) appendEmoji(key.slice(6), grid);
        if (key.startsWith('meme:')) {
          const meme = memeLibrary.find((item) => item.id === key.slice(5));
          if (meme) appendMeme(meme, grid);
        }
      }
      if (grid.childElementCount === 0) {
        const empty = document.createElement('p');
        empty.className = 'expression-empty';
        empty.textContent = '点按 ☆ 收藏常用表情和梗图。收藏只加密保存在本机。';
        content.append(empty);
        return;
      }
    }
    content.append(grid);
  }

  private toggleFavoriteExpression(key: string): void {
    if (!/^(emoji|meme):.{1,120}$/u.test(key)) return;
    const favorites = new Set(this.uiPreferences.favoriteExpressions);
    if (favorites.has(key)) favorites.delete(key);
    else if (favorites.size < 200) favorites.add(key);
    this.uiPreferences.favoriteExpressions = [...favorites];
    this.scheduleUiPreferencesSave();
  }

  private async sendMeme(id: string): Promise<void> {
    const meme = memeLibrary.find((item) => item.id === id);
    if (!meme || !this.session || this.privacyCovered) return;
    try {
      const response = await fetch(`/memes/openmoji-17.0.0/${meme.code}.svg`, { signal: this.runtimeAbort?.signal });
      if (!response.ok) throw new Error('梗图资源不可用');
      const blob = await response.blob();
      const file = new File([blob], `quiet-room-meme-${meme.id}.svg`, {
        type: 'image/svg+xml',
        lastModified: 1_776_902_400_000,
      });
      await this.processImageFiles([file], 'chat');
      this.restoreComposerFocus();
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      this.showNotice(cause instanceof Error ? cause.message : '梗图发送失败', 'error');
    }
  }

  private setEmojiPickerOpen(open: boolean): void {
    const picker = this.root.querySelector<HTMLElement>('#emoji-picker');
    const button = this.root.querySelector<HTMLButtonElement>('#emoji-button');
    if (!picker || !button) return;
    button.setAttribute('aria-expanded', String(open));
    button.classList.toggle('is-active', open);
    if (open) {
      picker.hidden = false;
      requestAnimationFrame(() => picker.classList.add('is-visible'));
      return;
    }
    picker.classList.remove('is-visible');
    window.setTimeout(() => {
      if (!picker.classList.contains('is-visible')) picker.hidden = true;
    }, 280);
  }

  private closeMoreMenu(menu: HTMLDetailsElement, restoreFocus = false): void {
    if (menu.classList.contains('is-closing')) return;
    menu.classList.add('is-closing');
    window.setTimeout(() => {
      menu.open = false;
      menu.classList.remove('is-closing');
      if (restoreFocus) menu.querySelector<HTMLElement>('summary')?.focus();
    }, 240);
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
          <aside class="device-security-note"><strong>端到端加密不会降级</strong><span>批准设备会生成 MLS Add 提交并轮换群组密钥；移除设备会生成 MLS Remove 提交。服务器只保存公钥、密文和加入边界。</span></aside>
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
            if (window.confirm(`移除“${member.deviceName ?? '这台设备'}”？它将无法解密之后的新消息。`)) {
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
    if (!session) return;
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
      );
      const pending = { linkId, secret, expiresAt, createdAt };
      session.vault.pendingDeviceLinks = [
        ...(session.vault.pendingDeviceLinks ?? []).filter((item) => Date.parse(item.expiresAt) > Date.now()),
        pending,
      ];
      await saveVault(session);
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
      await this.showDeviceInvite(invite);
    } catch (cause) {
      this.operationalError(cause, '设备链接生成失败');
    } finally {
      if (button.isConnected) setBusy(button, false);
    }
  }

  private async showDeviceInvite(invite: DeviceInvite): Promise<void> {
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
    await QRCode.toCanvas(sheet.querySelector('canvas'), url, {
      width: 232,
      margin: 1,
      color: { dark: '#2f4037', light: '#f5f3ee' },
      errorCorrectionLevel: 'M',
    });
    const close = () => sheet.remove();
    sheet.querySelector('[data-close]')?.addEventListener('click', close);
    sheet.querySelector('[data-copy]')?.addEventListener('click', async (event) => {
      try {
        await navigator.clipboard.writeText(url);
        (event.currentTarget as HTMLButtonElement).textContent = '已复制';
      } catch {
        input.select();
        document.execCommand('copy');
      }
    });
    sheet.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') close();
    });
    sheet.querySelector<HTMLButtonElement>('[data-close]')?.focus();
  }

  private async changeMlsMembership(
    action: 'add' | 'remove',
    target: RoomMember,
    button: HTMLButtonElement,
  ): Promise<void> {
    const session = this.session;
    if (!session?.vault.mls) return;
    setBusy(button, true, action === 'add' ? '正在安全加入…' : '正在移除…');
    try {
      let pending = session.vault.mls.pendingMembership;
      if (pending && (pending.event.action !== action || pending.event.targetId !== target.deviceId)) {
        throw new Error('另一个设备变更尚待服务器确认，请先刷新');
      }
      if (!pending) {
        pending = await prepareMlsMembership(session.vault, action, target);
        session.vault.mls.pendingMembership = pending;
        await saveVault(session);
      }
      const result = await publishMlsMembership(session.vault.roomId, session.vault.accessToken, pending.event);
      await this.applyRoomStateQueued(result.state);
      this.showNotice(action === 'add' ? '新设备已加入；群组密钥已轮换' : '设备已移除；之后的新消息密钥已轮换');
      await this.renderDeviceManager();
    } catch (cause) {
      if (cause instanceof ApiError && !cause.retryable && session.vault.mls.pendingMembership) {
        session.vault.mls.pendingMembership = undefined;
        await saveVault(session).catch(() => undefined);
      }
      this.operationalError(cause, action === 'add' ? '设备加入失败' : '设备移除失败');
      if (button.isConnected) setBusy(button, false);
    }
  }

  private transitionPage(direction: 'forward' | 'backward', render: () => void): void {
    if (this.root.querySelector('#message-list')) {
      this.captureChatAnchor(true);
      this.restoreChatAnchorOnNextRender = true;
    }
    if (this.pageTransitionTimer !== null) window.clearTimeout(this.pageTransitionTimer);
    this.root.dataset.pageTransition = direction;
    render();
    this.pageTransitionTimer = window.setTimeout(() => {
      delete this.root.dataset.pageTransition;
      this.pageTransitionTimer = null;
    }, 420);
  }

  private setActiveSurface(surface: 'away' | 'chat'): void {
    if (surface === 'chat' && this.activeSurface !== 'chat') this.rolePresence = null;
    this.activeSurface = surface;
    this.socket?.setChatPresence(surface === 'chat');
  }

  private captureChatAnchor(persist = false, preservePosition = false): ChatScrollAnchor | null {
    const list = this.root.querySelector<HTMLElement>('#message-list');
    if (!list) return this.uiPreferences.chatAnchor ?? null;
    const articles = [...list.querySelectorAll<HTMLElement>('.message[data-client-msg-id]')];
    if (articles.length === 0) return null;
    const pinnedToBottom = !preservePosition && list.scrollHeight - list.scrollTop - list.clientHeight <= 48;
    const listTop = list.getBoundingClientRect().top;
    const visible = pinnedToBottom
      ? articles.at(-1)!
      : articles.find((article) => article.getBoundingClientRect().bottom > listTop) ?? articles[0]!;
    const clientMsgId = visible.dataset.clientMsgId ?? '';
    const message = this.orderedMessages().find((item) => item.clientMsgId === clientMsgId);
    if (!message || !clientMsgId) return null;
    const seq = Number.isSafeInteger(message.seq) && message.seq < Number.MAX_SAFE_INTEGER
      ? message.seq
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
    requestAnimationFrame(() => {
      if (!list.isConnected) return;
      if (!anchor || anchor.pinnedToBottom) {
        list.scrollTop = list.scrollHeight;
        return;
      }
      const target = list.querySelector<HTMLElement>(`.message[data-client-msg-id="${CSS.escape(anchor.clientMsgId)}"]`);
      if (!target) {
        list.scrollTop = list.scrollHeight;
        return;
      }
      list.scrollTop += target.getBoundingClientRect().top - list.getBoundingClientRect().top - anchor.offset;
    });
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
    if (!this.session) return;
    const input = this.root.querySelector<HTMLTextAreaElement>('#message-input');
    const text = input?.value.trim() ?? '';
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
    if (input) {
      input.value = '';
      input.style.height = 'auto';
      if (retainKeyboard) this.restoreComposerFocus();
    }
    try {
      await this.enqueuePayload(payload);
      if (this.replyTarget?.clientMsgId === replyTarget?.clientMsgId) {
        this.replyTarget = null;
        this.renderReplyDraft();
      }
    } catch (cause) {
      if (input && !input.value) {
        input.value = text;
        input.dispatchEvent(new Event('input'));
      }
      this.showNotice(cause instanceof Error ? cause.message : '消息未能安全保存', 'error');
      return;
    }
    if (this.connectionState !== 'connected') this.showNotice('消息已加密保存在本机，连接恢复后会自动发送');
  }

  private enqueuePayload(payload: MessagePayload, existingClientMsgId?: string): Promise<void> {
    const operation = this.sendChain.catch(() => undefined).then(() => this.sendPayload(payload, existingClientMsgId));
    this.sendChain = operation.catch(() => undefined);
    return operation;
  }

  private async sendPayload(payload: MessagePayload, existingClientMsgId?: string): Promise<void> {
    const session = this.session;
    if (!session || this.privacyCovered) return;
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
        await commitMlsSend(session, outboxItem, encrypted.nextGroupState);
      } else {
        await saveOutboxItem(session, outboxItem);
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
    this.renderMessages({ scroll: 'bottom' });
    await this.attemptSend(clientMsgId);
  }

  private async attemptSend(clientMsgId: string): Promise<void> {
    const session = this.session;
    if (!session || this.privacyCovered || this.sending.has(clientMsgId)) return;
    const epoch = this.runtimeEpoch;
    const item = this.outbox.get(clientMsgId);
    if (!item) return;
    if (this.connectionState !== 'connected') return;
    this.sending.add(clientMsgId);
    const pendingMessage = this.pending.get(clientMsgId);
    if (pendingMessage?.status === 'failed') pendingMessage.status = 'pending';
    try {
      const envelope = item.envelope ?? await encryptMessage(session.vault, item.payload, clientMsgId);
      if (!this.isRuntimeActive(epoch, session)) return;
      this.socket?.sendEnvelope(envelope);
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
    const item = this.outbox.get(clientMsgId);
    if (!session || !item || session.vault.protocol !== 'mls-rfc9420') return;
    this.clearRetry(clientMsgId);
    const encrypted = await encryptMlsApplication(session.vault, item.payload, clientMsgId);
    item.envelope = encrypted.envelope;
    await commitMlsSend(session, item, encrypted.nextGroupState);
    this.outbox.set(clientMsgId, item);
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
    if (!this.session || !this.pendingReceipts.has(clientMsgId)) return;
    try {
      await deletePendingReceipt(this.session, clientMsgId);
      this.pendingReceipts.delete(clientMsgId);
    } catch (cause) {
      this.operationalError(cause, '送达回执已被服务器确认，但本机队列清理失败');
    }
  }

  private beginImagePicker(restoreComposerFocus = false): void {
    this.imagePickerActive = true;
    this.restoreComposerFocusAfterPicker = restoreComposerFocus;
    if (this.imagePickerResetTimer !== null) window.clearTimeout(this.imagePickerResetTimer);
    this.imagePickerResetTimer = window.setTimeout(() => this.finishImagePicker(), 5 * 60_000);
  }

  private finishImagePicker(restoreFocus = true): void {
    this.imagePickerActive = false;
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
    if (trigger) {
      trigger.addEventListener('pointerdown', (event) => {
        const textarea = this.root.querySelector<HTMLTextAreaElement>('#message-input');
        if (destination === 'chat' && textarea) this.retainComposerKeyboard(event, textarea);
      });
      trigger.addEventListener('click', () => {
        if (!input || input.disabled) return;
        this.beginImagePicker(destination === 'chat' && this.keepComposerKeyboard);
        input.click();
      });
    }
    input?.addEventListener('click', () => {
      if (!this.imagePickerActive) this.beginImagePicker();
    });
    input?.addEventListener('cancel', () => {
      this.finishImagePicker();
      this.deferredImageUpload = null;
    });
    input?.addEventListener('change', (event) => void this.handleSendImage(event, destination));
  }

  private async handleSendImage(event: Event, destination: 'chat' | 'gallery'): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
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
    if (destination === 'chat' && selected.length > MAX_IMAGE_ALBUM_ITEMS) {
      this.showNotice(`一次最多发送 ${MAX_IMAGE_ALBUM_ITEMS} 张图片`, 'error');
      return;
    }
    const files = destination === 'gallery' ? selected.slice(0, 1) : selected;
    if (!this.session || this.privacyCovered) {
      this.deferredImageUpload = { files, destination };
      return;
    }
    try {
      await this.processImageFiles(files, destination);
    } finally {
      if (destination === 'chat' && this.restoreComposerFocusAfterPicker) {
        this.restoreComposerFocusAfterPicker = false;
        this.restoreComposerFocus();
      }
    }
  }

  private async resumeDeferredImage(): Promise<void> {
    if (!this.deferredImageUpload || !this.session || this.privacyCovered) return;
    const { files, destination } = this.deferredImageUpload;
    this.deferredImageUpload = null;
    await this.processImageFiles(files, destination);
  }

  private async processImageFiles(files: File[], destination: 'chat' | 'gallery' = 'chat'): Promise<void> {
    const session = this.session;
    if (!session || this.privacyCovered || files.length === 0) return;
    if (destination === 'chat' && files.length > MAX_IMAGE_ALBUM_ITEMS) {
      this.showNotice(`一次最多发送 ${MAX_IMAGE_ALBUM_ITEMS} 张图片`, 'error');
      return;
    }
    if (destination === 'chat' && files.length > 1 && !this.activeDevicesSupport('image-album-v1')) {
      this.showNotice('有活跃设备尚未确认支持多图相册；请先将所有设备升级并至少打开一次最新版', 'error');
      return;
    }
    if (session.vault.protocol === 'mls-rfc9420' && session.vault.mls?.phase !== 'active') {
      this.showNotice('安全会话尚未建立完成，图片不会上传', 'error');
      return;
    }
    if (destination === 'gallery' && session.vault.role !== 'creator') {
      this.showNotice('只有会话创建者可以向相册上传图片', 'error');
      return;
    }
    const epoch = this.runtimeEpoch;
    const signal = this.runtimeAbort?.signal;
    if (files.some((file) => file.size > MAX_IMAGE_BYTES)) {
      this.showNotice('首版单张原图上限为 256 MiB', 'error');
      return;
    }
    if (
      destination === 'chat' &&
      files.length > 1 &&
      files.reduce((sum, file) => sum + file.size, 0) > MAX_IMAGE_ALBUM_BYTES
    ) {
      this.showNotice('一条相册消息的原图总量不能超过 256 MiB', 'error');
      return;
    }
    if (files.some((file) => file.size === 0 || !file.type.startsWith('image/'))) {
      this.showNotice('只能发送非空图片文件', 'error');
      return;
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
              : `正在加密上传原图 ${Math.round(overall * 100)}%`;
          },
          signal,
        };
        let manifest: ImageManifest | undefined;
        const resumablePlans = matchingPlans.filter((plan) => plan.v === 2 && !usedUploadPlanIds.has(plan.blobId));
        for (const existingPlan of resumablePlans) {
          try {
            manifest = await encryptImageFile(file, uploadCallbacks, existingPlan);
            break;
          } catch (cause) {
            if (!(cause instanceof Error) || cause.message !== '所选图片内容与待续传文件不一致') throw cause;
          }
        }
        manifest ??= await encryptImageFile(file, uploadCallbacks);
        if (!this.isRuntimeActive(epoch, session)) return;
        manifests.push(manifest);
        usedUploadPlanIds.add(manifest.blobId);
        this.cacheLocalImage(manifest, file);
        completedBytes += Math.max(file.size, 1);
      }
      const sentAt = new Date().toISOString();
      const payload: MessagePayload = destination === 'gallery'
        ? { v: 1, kind: 'gallery-image', image: manifests[0]!, sentAt }
        : manifests.length > 1
          ? replyTarget
            ? { v: 2, kind: 'image-album', images: manifests, sentAt, replyTo: this.replyReference(replyTarget) }
            : { v: 1, kind: 'image-album', images: manifests, sentAt }
          : replyTarget
            ? { v: 2, kind: 'image', image: manifests[0]!, sentAt, replyTo: this.replyReference(replyTarget) }
            : { v: 1, kind: 'image', image: manifests[0]!, sentAt };
      await this.enqueuePayload(payload, clientMsgId);
      if (this.replyTarget?.clientMsgId === replyTarget?.clientMsgId) {
        this.replyTarget = null;
        this.renderReplyDraft();
      }
      for (const manifest of manifests) {
        await deleteUploadPlan(session, manifest.blobId);
        this.uploadPlans = this.uploadPlans.filter((plan) => plan.blobId !== manifest.blobId);
      }
      if (destination === 'gallery' && this.root.querySelector('.gallery-shell')) this.renderGallery();
    } catch (cause) {
      if (signal?.aborted || !this.isRuntimeActive(epoch, session)) return;
      const suffix = this.uploadPlans.length > 0 ? '。重新选择同一原图可从已完成分块继续' : '';
      this.showNotice(`${cause instanceof Error ? cause.message : '原图上传失败'}${suffix}`, 'error');
    } finally {
      if (!this.isRuntimeActive(epoch, session)) return;
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
      this.imageCacheBytes -= oldest[1].bytes;
      this.imageCache.delete(oldest[0]);
    }
    const cached = { blob, url: URL.createObjectURL(blob), bytes: blob.size, lastUsedAt: Date.now() };
    this.imageCache.set(manifest.blobId, cached);
    this.imageCacheBytes += cached.bytes;
  }

  private assertImageManifestIdentity(manifest: ImageManifest): void {
    const signature = canonicalStringify(manifest);
    const known = this.imageManifestSignatures.get(manifest.blobId);
    if (known && known !== signature) {
      throw new SecurityViolation('同一图片编号绑定了不同的加密清单，已拒绝显示');
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
      const timer = window.setTimeout(resolve, milliseconds);
      signal?.addEventListener('abort', () => {
        window.clearTimeout(timer);
        reject(signal.reason);
      }, { once: true });
    });
  }

  private orderedMessages(): DecryptedMessage[] {
    const confirmed = [...this.messages.values()]
      .filter((message) => message.payload.kind !== 'gallery-image')
      .sort((left, right) => left.seq - right.seq);
    const pending = [...this.pending.values()]
      .filter((message) => message.payload.kind !== 'gallery-image')
      .sort((left, right) => left.acceptedAt.localeCompare(right.acceptedAt));
    return [...confirmed, ...pending];
  }

  private activeDevicesSupport(capability: string): boolean {
    const members = this.session?.vault.members.filter((member) => member.status === undefined || member.status === 'active') ?? [];
    return members.length > 0 && members.every((member) => member.capabilities?.includes(capability));
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
    if (message.payload.kind === 'image-album') return `${message.payload.images.length} 张图片`;
    return '图片';
  }

  private localReplyPreview(reference: ReplyReference): string {
    const target = this.orderedMessages().find((message) => message.clientMsgId === reference.clientMsgId);
    if (target) return this.replyPreviewForMessage(target);
    return reference.kind === 'text' ? '历史文字消息（本机无记录）' : '历史图片（本机无记录）';
  }

  private replyReference(message: DecryptedMessage): ReplyReference {
    return {
      clientMsgId: message.clientMsgId,
      serverSeq: message.seq,
      senderId: message.senderId,
      kind: message.payload.kind === 'text' ? 'text' : 'image',
      // Keep the v2 wire field generic. Devices that own the referenced
      // history render a local preview; newly linked devices never receive a
      // copied excerpt from a message before their MLS join boundary.
      preview: message.payload.kind === 'text' ? '文字消息' : '图片',
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
    this.setEmojiPickerOpen(false);
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
    const own = this.isOwnMessage(message);
    const favoriteKey = this.favoriteKeyForMessage(message);
    if (own && !favoriteKey) return;
    const open = () => this.openMessageActions(article, message);
    article.addEventListener('pointerdown', (event) => {
      const excludedButton = event.target instanceof Element
        ? event.target.closest('button:not(.image-preview):not(.album-cell)')
        : null;
      if (event.button !== 0 || event.pointerType === 'mouse' || excludedButton) return;
      this.cancelMessageHold();
      this.messageHoldStart = { x: event.clientX, y: event.clientY };
      this.messageHoldTimer = window.setTimeout(() => {
        this.messageHoldTimer = null;
        this.suppressMediaClickUntil = Date.now() + 650;
        navigator.vibrate?.(18);
        open();
      }, 480);
    });
    article.addEventListener('pointermove', (event) => {
      const start = this.messageHoldStart;
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) this.cancelMessageHold();
    });
    for (const eventName of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
      article.addEventListener(eventName, () => this.cancelMessageHold());
    }
    article.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      open();
    });
    article.addEventListener('keydown', (event) => {
      if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
        event.preventDefault();
        open();
      }
    });
    const quickReply = article.querySelector<HTMLButtonElement>('.message-quick-reply');
    quickReply?.addEventListener('click', open);
  }

  private openMessageActions(article: HTMLElement, message: DecryptedMessage): void {
    this.closeMessageActions();
    const actions = document.createElement('div');
    actions.className = 'message-actions';
    actions.setAttribute('role', 'menu');
    actions.setAttribute('aria-label', '消息操作');
    const actionButtons: HTMLButtonElement[] = [];
    if (!this.isOwnMessage(message)) {
      const reply = document.createElement('button');
      reply.type = 'button';
      reply.setAttribute('role', 'menuitem');
      reply.innerHTML = `${icons.reply}<span>回复</span>`;
      reply.addEventListener('click', () => this.beginReply(message));
      actions.append(reply);
      actionButtons.push(reply);
    }
    const favoriteKey = this.favoriteKeyForMessage(message);
    if (favoriteKey) {
      const favorite = document.createElement('button');
      favorite.type = 'button';
      favorite.setAttribute('role', 'menuitem');
      const selected = this.uiPreferences.favoriteExpressions.includes(favoriteKey);
      favorite.innerHTML = `<span aria-hidden="true">${selected ? '★' : '☆'}</span><span>${selected ? '取消收藏' : '收藏表情'}</span>`;
      favorite.addEventListener('click', () => {
        this.toggleFavoriteExpression(favoriteKey);
        this.renderExpressionPickerContents();
        this.closeMessageActions();
      });
      actions.append(favorite);
      actionButtons.push(favorite);
    }
    const rect = article.getBoundingClientRect();
    const x = Math.max(8, Math.min(rect.left, window.innerWidth - 144));
    const y = rect.bottom + 58 < window.innerHeight ? rect.bottom + 6 : Math.max(8, rect.top - 52);
    actions.style.setProperty('--message-action-x', `${Math.round(x)}px`);
    actions.style.setProperty('--message-action-y', `${Math.round(y)}px`);
    actions.dataset.sourceId = message.clientMsgId;
    this.root.append(actions);
    requestAnimationFrame(() => {
      actions.classList.add('is-visible');
      actionButtons[0]?.focus({ preventScroll: true });
    });
  }

  private favoriteKeyForMessage(message: DecryptedMessage): string | null {
    if (message.payload.kind === 'text') {
      const value = message.payload.text.trim();
      return composerEmojis.includes(value) ? `emoji:${value}` : null;
    }
    if (message.payload.kind !== 'image') return null;
    const match = /^quiet-room-meme-([a-z0-9-]+)\.svg$/i.exec(message.payload.image.originalName);
    if (!match || !memeLibrary.some((item) => item.id === match[1])) return null;
    return `meme:${match[1]}`;
  }

  private closeMessageActions(restoreFocus = false): void {
    this.cancelMessageHold();
    const actions = this.root.querySelector<HTMLElement>('.message-actions');
    if (!actions) return;
    const sourceId = actions.dataset.sourceId;
    actions.remove();
    if (restoreFocus && sourceId) {
      this.root.querySelector<HTMLElement>(`.message[data-client-msg-id="${CSS.escape(sourceId)}"]`)?.focus({ preventScroll: true });
    }
  }

  private jumpToReplyTarget(clientMsgId: string): void {
    const target = this.root.querySelector<HTMLElement>(`.message[data-client-msg-id="${CSS.escape(clientMsgId)}"]`);
    if (!target) {
      this.showNotice('原消息不在这台设备的本地记录中');
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

  private renderMessages({ scroll = 'preserve' }: { scroll?: 'preserve' | 'position' | 'bottom' | 'restore' } = {}): void {
    const list = this.root.querySelector<HTMLElement>('#message-list');
    if (!list || !this.session) return;
    const anchor = scroll === 'restore'
      ? this.uiPreferences.chatAnchor
      : this.captureChatAnchor(false, scroll === 'position');
    const messages = this.orderedMessages();
    if (messages.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-conversation';
      const title = document.createElement('p');
      title.textContent = '会话已经准备好';
      const detail = document.createElement('span');
      detail.textContent = '文字和原图都会在这台设备上加密后再发送。';
      empty.append(title, detail);
      this.renderedMessages.clear();
      list.replaceChildren(empty);
    } else {
      const currentKeys = new Set<string>();
      const fragment = document.createDocumentFragment();
      for (const message of messages) {
        const key = message.clientMsgId;
        currentKeys.add(key);
        const signature = `${message.status}:${JSON.stringify(message.payload)}:${message.acceptedAt}`;
        const cached = this.renderedMessages.get(key);
        const element = cached?.signature === signature ? cached.element : this.createMessageElement(message);
        this.renderedMessages.set(key, { signature, element });
        fragment.append(element);
      }
      for (const key of this.renderedMessages.keys()) {
        if (!currentKeys.has(key)) this.renderedMessages.delete(key);
      }
      list.replaceChildren(fragment);
    }
    this.mountChatImageObserver(list);
    if (scroll === 'bottom' || messages.length <= 1) {
      requestAnimationFrame(() => {
        if (!list.isConnected) return;
        list.scrollTo({
          top: list.scrollHeight,
          behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        });
        this.captureChatAnchor(true);
      });
    } else {
      this.restoreChatAnchor(list, anchor);
    }
    this.restoreChatAnchorOnNextRender = false;
  }

  private async loadOlderHistory(list: HTMLElement): Promise<void> {
    const session = this.session;
    if (!session || this.privacyCovered || !this.historyHasMore || this.historyLoading) return;
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
      const older = await loadHistoryPage(session, { limit: 200, beforeSeq: firstSeq });
      if (older.length < 200) this.historyHasMore = false;
      for (const message of older) this.messages.set(message.seq, message);
      this.renderMessages({ scroll: 'preserve' });
    } finally {
      this.historyLoading = false;
      delete list.dataset.historyLoading;
    }
  }

  private async loadNewerHistory(list: HTMLElement): Promise<void> {
    const session = this.session;
    if (!session || this.privacyCovered || !this.historyHasNewer || this.historyLoading) return;
    this.historyLoading = true;
    list.dataset.historyLoading = 'true';
    try {
      const newer = await loadHistoryPageAfter(session, {
        limit: 200,
        afterSeq: this.historyForwardCursor,
      });
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
    } finally {
      this.historyLoading = false;
      delete list.dataset.historyLoading;
    }
  }

  private createMessageElement(message: DecryptedMessage): HTMLElement {
    const own = this.isOwnMessage(message);
    const article = document.createElement('article');
    article.className = `message ${own ? 'outgoing' : 'incoming'} is-${message.status}`;
    article.dataset.clientMsgId = message.clientMsgId;
    if (!own || this.favoriteKeyForMessage(message)) {
      article.tabIndex = 0;
      article.setAttribute('aria-label', own ? '可长按收藏这条表情消息' : '对方消息，可长按或打开快捷菜单回复');
    }
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    if (message.payload.kind !== 'gallery-image' && message.payload.replyTo) {
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
      quote.addEventListener('click', () => this.jumpToReplyTarget(targetId));
      bubble.append(quote);
    }
    if (message.payload.kind === 'text') {
      const text = document.createElement('p');
      text.textContent = message.payload.text;
      bubble.append(text);
    } else if (message.payload.kind === 'image-album') {
      article.classList.add('has-media');
      bubble.classList.add('image-bubble');
      const album = document.createElement('div');
      const countClass = message.payload.images.length <= 4 ? String(message.payload.images.length) : 'many';
      album.className = `image-album album-count-${countClass}`;
      album.setAttribute('aria-label', `${message.payload.images.length} 张图片`);
      for (const [index, manifest] of message.payload.images.entries()) {
        const preview = this.createImagePreview(manifest, message.payload.images, index);
        preview.classList.add('album-cell');
        preview.setAttribute('aria-label', `查看第 ${index + 1} 张，共 ${message.payload.images.length} 张`);
        album.append(preview);
      }
      bubble.append(album);
    } else {
      article.classList.add('has-media');
      bubble.classList.add('image-bubble');
      bubble.append(this.createImagePreview(message.payload.image, [message.payload.image], 0));
    }
    const meta = document.createElement('p');
    meta.className = 'message-meta';
    const status = own
      ? message.status === 'pending'
        ? ' · 等待服务器'
        : message.status === 'stored' || message.status === 'sent'
          ? ' · 服务器已保存'
          : message.status === 'delivered'
            ? ' · 对端已安全接收'
            : ' · 发送失败'
      : '';
    meta.append(document.createTextNode(`${timeLabel(message.payload.sentAt)}${status}`));
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
    if (!own) {
      const quickReply = document.createElement('button');
      quickReply.type = 'button';
      quickReply.className = 'message-quick-reply';
      quickReply.setAttribute('aria-label', '回复这条消息');
      quickReply.innerHTML = icons.reply;
      article.append(quickReply);
    }
    article.append(bubble, meta);
    this.mountMessageActions(article, message);
    return article;
  }

  private async exportRecovery(): Promise<void> {
    const session = this.session;
    if (!session || this.privacyCovered) return;
    const epoch = this.runtimeEpoch;
    try {
      this.beginFileExport();
      const recovery = await downloadRecoveryPackage(session);
      if (!this.isRuntimeActive(epoch, session)) return;
      session.vault.recoveryExportedAt = recovery.exportedAt;
      await saveVault(session);
      if (!this.isRuntimeActive(epoch, session)) return;
      this.showRecoveryCode(recovery.recoveryCode);
      this.root.querySelector('.recovery-reminder')?.remove();
    } catch (cause) {
      this.finishFileExport();
      this.operationalError(cause, '恢复包导出失败');
    }
  }

  private beginFileExport(): void {
    this.fileExportActive = true;
    if (this.fileExportResetTimer !== null) window.clearTimeout(this.fileExportResetTimer);
    // Safari can briefly blur the page while handing a generated file to the
    // download surface. Bound the exception tightly so later blurs still lock.
    this.fileExportResetTimer = window.setTimeout(() => this.finishFileExport(), 1800);
  }

  private finishFileExport(): void {
    this.fileExportActive = false;
    if (this.fileExportResetTimer !== null) window.clearTimeout(this.fileExportResetTimer);
    this.fileExportResetTimer = null;
  }

  private showRecoveryCode(recoveryCode: string): void {
    this.root.querySelector('.recovery-code-sheet')?.remove();
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const sheet = document.createElement('section');
    sheet.className = 'recovery-code-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-labelledby', 'recovery-code-title');
    sheet.setAttribute('aria-describedby', 'recovery-code-description');
    sheet.innerHTML = `
      <div class="recovery-code-panel">
        <p class="eyebrow">一次性显示</p>
        <h2 id="recovery-code-title">单独保存恢复码</h2>
        <p id="recovery-code-description">刚下载的恢复文件无法单独解锁。请把下面的恢复码保存在不同的位置；关闭后无法再次查看，只能重新导出一组。</p>
        <code></code>
        <div class="recovery-code-actions">
          <button class="secondary-button" type="button" data-copy-code>复制恢复码</button>
          <button class="primary-button" type="button" data-close-code>我已分开保存</button>
        </div>
      </div>
    `;
    sheet.querySelector('code')!.textContent = recoveryCode;
    this.root.append(sheet);
    const close = () => {
      recoveryCode = '';
      this.finishFileExport();
      sheet.remove();
      previouslyFocused?.focus();
      this.showNotice('恢复文件和恢复码已生成，请分开保存');
    };
    sheet.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...sheet.querySelectorAll<HTMLElement>('button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])')]
        .filter((element) => !element.hasAttribute('disabled'));
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    sheet.querySelector('[data-copy-code]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      try {
        await navigator.clipboard.writeText(recoveryCode);
        button.textContent = '已复制';
      } catch {
        button.textContent = '复制失败，请手动记录';
      }
    });
    sheet.querySelector('[data-close-code]')?.addEventListener('click', close);
    sheet.querySelector<HTMLButtonElement>('[data-close-code]')?.focus();
  }

  private createImagePreview(manifest: ImageManifest, album: ImageManifest[], index: number): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'image-preview';
    button.dataset.blobId = manifest.blobId;
    button.dataset.imageState = 'pending';
    button.setAttribute('aria-label', manifest.originalName ? `放大查看 ${manifest.originalName}` : '放大查看聊天图片');
    button.innerHTML = `${icons.image}<span>正在载入缩略图…</span><small>${this.fileSize(manifest.originalSize)}</small>`;
    const cached = this.imageCache.get(manifest.blobId);
    if (cached) this.renderImageIntoButton(button, manifest, cached);
    button.addEventListener('click', () => {
      if (Date.now() < this.suppressMediaClickUntil) return;
      if (button.dataset.imageState === 'error') {
        void this.hydrateImagePreview(button, manifest);
        return;
      }
      this.openImageViewer(album, index, button);
    });
    return button;
  }

  private renderImageIntoButton(button: HTMLButtonElement, manifest: ImageManifest, cached: CachedImage): void {
    const image = document.createElement('img');
    image.src = cached.url;
    image.alt = manifest.originalName || '聊天图片';
    image.decoding = 'async';
    image.draggable = false;
    if (/^quiet-room-meme-/i.test(manifest.originalName)) button.classList.add('is-sticker');
    button.replaceChildren(image);
    button.dataset.imageState = 'loaded';
  }

  private async hydrateImagePreview(button: HTMLButtonElement, manifest: ImageManifest): Promise<void> {
    if (button.dataset.imageState === 'loading' || button.dataset.imageState === 'loaded') return;
    button.dataset.imageState = 'loading';
    const label = button.querySelector<HTMLElement>('span');
    if (label) label.textContent = '正在本地解密…';
    try {
      const cached = await this.loadImage(manifest);
      if (!button.isConnected || this.privacyCovered) return;
      const anchor = this.captureChatAnchor(false);
      this.renderImageIntoButton(button, manifest, cached);
      if (anchor && !anchor.pinnedToBottom) this.restoreChatAnchor(this.root.querySelector<HTMLElement>('#message-list')!, anchor);
      else if (anchor?.pinnedToBottom) requestAnimationFrame(() => {
        const list = this.root.querySelector<HTMLElement>('#message-list');
        if (list) list.scrollTop = list.scrollHeight;
      });
    } catch (cause) {
      if (!button.isConnected || cause instanceof DOMException && cause.name === 'AbortError') return;
      button.dataset.imageState = 'error';
      const error = document.createElement('span');
      error.textContent = cause instanceof Error ? `${cause.message}，点按重试` : '载入失败，点按重试';
      button.replaceChildren(error);
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
      if (message.payload.kind === 'image-album') {
        manifest = message.payload.images.find((item) => item.blobId === button.dataset.blobId);
      }
      if (manifest) void this.hydrateImagePreview(button, manifest);
    };
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
    }, { root: list, rootMargin: '75% 0px', threshold: 0.01 });
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
      const blob = await decryptImageFile(
        manifest,
        (blobId, chunkIndex) => fetchBlobChunk(roomId, accessToken, blobId, chunkIndex, signal),
        undefined,
        signal,
      );
      if (!this.isRuntimeActive(epoch, session)) throw new DOMException('Session locked', 'AbortError');
      this.cacheLocalImage(manifest, blob);
      const cached = this.imageCache.get(manifest.blobId);
      if (!cached) throw new Error('图片缓存失败');
      return cached;
    }).finally(() => this.imageLoadPromises.delete(manifest.blobId));
    this.imageLoadPromises.set(manifest.blobId, operation);
    return operation;
  }

  private openImageViewer(manifests: ImageManifest[], startIndex = 0, returnFocus?: HTMLElement): void {
    if (manifests.length === 0 || this.privacyCovered) return;
    this.closeImageViewer(true);
    this.viewerPreviousSurface = this.activeSurface;
    this.setActiveSurface('away');
    this.viewerReturnFocus = returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const viewer = document.createElement('section');
    viewer.className = 'image-viewer';
    viewer.setAttribute('role', 'dialog');
    viewer.setAttribute('aria-modal', 'true');
    viewer.setAttribute('aria-label', '图片查看器');
    viewer.innerHTML = `
      <header class="viewer-header">
        <button class="viewer-control" type="button" data-viewer-close aria-label="关闭查看器">${icons.close}</button>
        <div><strong data-viewer-name></strong><span data-viewer-counter></span></div>
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
    const render = async (index: number) => {
      current = (index + manifests.length) % manifests.length;
      const token = ++renderToken;
      const manifest = manifests[current]!;
      stage.dataset.blobId = manifest.blobId;
      viewer.querySelector<HTMLElement>('[data-viewer-name]')!.textContent = manifest.originalName || '原图';
      viewer.querySelector<HTMLElement>('[data-viewer-counter]')!.textContent = manifests.length > 1 ? `${current + 1} / ${manifests.length}` : this.fileSize(manifest.originalSize);
      previous.hidden = manifests.length < 2;
      next.hidden = manifests.length < 2;
      const cached = this.imageCache.get(manifest.blobId);
      if (cached) {
        const image = document.createElement('img');
        image.src = cached.url;
        image.alt = manifest.originalName || `第 ${current + 1} 张图片`;
        image.draggable = false;
        stage.replaceChildren(image);
      } else {
        const loading = document.createElement('p');
        loading.className = 'viewer-loading';
        loading.textContent = '正在下载、解密并校验原图…';
        stage.replaceChildren(loading);
      }
      try {
        const loaded = cached ?? await this.loadImage(manifest);
        if (!viewer.isConnected || token !== renderToken) return;
        const image = document.createElement('img');
        image.src = loaded.url;
        image.alt = manifest.originalName || `第 ${current + 1} 张图片`;
        image.draggable = false;
        stage.replaceChildren(image);
        const adjacent = manifests[(current + 1) % manifests.length];
        if (adjacent && adjacent !== manifest && !(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) {
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
        await downloadBlob(cached.blob, manifest.originalName || 'image');
      } catch (cause) {
        this.finishFileExport();
        this.operationalError(cause, '原图保存失败');
      }
    });
    let touchStartX: number | null = null;
    stage.addEventListener('pointerdown', (event) => {
      if (event.pointerType !== 'mouse') touchStartX = event.clientX;
    });
    stage.addEventListener('pointerup', (event) => {
      if (touchStartX === null) return;
      const distance = event.clientX - touchStartX;
      touchStartX = null;
      if (Math.abs(distance) < 44 || manifests.length < 2) return;
      void render(current + (distance < 0 ? 1 : -1));
    });
    this.viewerKeyHandler = (event: KeyboardEvent) => {
      if (!viewer.isConnected) return;
      if (event.key === 'ArrowLeft' && manifests.length > 1) {
        event.preventDefault();
        void render(current - 1);
      }
      if (event.key === 'ArrowRight' && manifests.length > 1) {
        event.preventDefault();
        void render(current + 1);
      }
    };
    document.addEventListener('keydown', this.viewerKeyHandler);
    requestAnimationFrame(() => viewer.classList.add('is-visible'));
    viewer.querySelector<HTMLButtonElement>('[data-viewer-close]')?.focus({ preventScroll: true });
    void render(current);
  }

  private closeImageViewer(immediate = false): void {
    const viewer = this.root.querySelector<HTMLElement>('.image-viewer');
    if (this.viewerKeyHandler) document.removeEventListener('keydown', this.viewerKeyHandler);
    this.viewerKeyHandler = null;
    if (!viewer) return;
    const finish = () => {
      viewer.remove();
      this.setActiveSurface(this.viewerPreviousSurface);
      const returnFocus = this.viewerReturnFocus;
      this.viewerReturnFocus = null;
      if (!immediate && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    };
    if (immediate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      finish();
      return;
    }
    viewer.classList.remove('is-visible');
    viewer.classList.add('is-closing');
    window.setTimeout(finish, 340);
  }

  private renderGallery(): void {
    const session = this.session;
    if (!session || this.privacyCovered) return;
    this.setActiveSurface('away');
    if (session.vault.role !== 'creator') {
      this.renderChat();
      this.showNotice('相册仅对会话创建者开放', 'error');
      return;
    }
    const cryptoReady = session.vault.protocol !== 'mls-rfc9420' || session.vault.mls?.phase === 'active';
    const assets: GalleryAsset[] = [...this.messages.values(), ...this.pending.values()]
      .filter((message) => ['image', 'image-album', 'gallery-image'].includes(message.payload.kind))
      .sort((left, right) => right.acceptedAt.localeCompare(left.acceptedAt))
      .flatMap((message): GalleryAsset[] => {
        if (message.payload.kind === 'image-album') {
          return message.payload.images.map((manifest, assetIndex) => ({
            manifest,
            clientMsgId: message.clientMsgId,
            sentAt: message.payload.sentAt,
            assetIndex,
          }));
        }
        if (message.payload.kind === 'image' || message.payload.kind === 'gallery-image') {
          return [{ manifest: message.payload.image, clientMsgId: message.clientMsgId, sentAt: message.payload.sentAt, assetIndex: 0 }];
        }
        return [];
      });
    this.galleryObserver?.disconnect();
    this.galleryObserver = null;
    this.root.innerHTML = `
      <section class="gallery-shell">
        <header class="subpage-header gallery-header">
          <button class="icon-button" id="gallery-back" type="button" aria-label="返回聊天">${icons.back}</button>
          <div><h1>相册</h1><p id="gallery-total">${assets.length > 0 ? `${assets.length} 张` : '原图'}</p></div>
          <button class="icon-button gallery-upload-button${cryptoReady ? '' : ' is-disabled'}" id="open-gallery-image-picker" type="button" aria-label="上传图片到相册" title="上传图片到相册" ${cryptoReady ? '' : 'disabled'}>${icons.upload}</button>
          <input id="gallery-image-input" type="file" accept="image/*" ${cryptoReady ? '' : 'disabled'} hidden />
        </header>
        <div class="notice gallery-notice" id="notice" role="status" hidden></div>
        <div class="upload-progress gallery-upload-progress" id="upload-progress" hidden><span></span><output></output></div>
        <div class="gallery-grid" id="gallery-grid"></div>
      </section>
    `;
    this.root.querySelector('#gallery-back')?.addEventListener('click', () => this.transitionPage('backward', () => this.renderChat()));
    this.mountImagePicker(
      this.root.querySelector<HTMLInputElement>('#gallery-image-input'),
      'gallery',
      this.root.querySelector<HTMLButtonElement>('#open-gallery-image-picker'),
    );
    const grid = this.root.querySelector<HTMLElement>('#gallery-grid')!;
    if (assets.length === 0) {
      grid.innerHTML = '<div class="gallery-empty"><p>还没有图片</p><span>聊天中的原图和从这里上传的图片都会出现在这里。</span></div>';
      return;
    }
    const manifests = assets.map((asset) => asset.manifest);
    for (const [index, asset] of assets.entries()) {
      const manifest = asset.manifest;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'gallery-tile';
      button.dataset.galleryIndex = String(index);
      button.dataset.blobId = manifest.blobId;
      button.setAttribute('aria-label', `查看原图 ${manifest.originalName}`);
      button.innerHTML = `${icons.image}<span class="tile-loading">正在载入…</span><time>${timeLabel(asset.sentAt)}</time>`;
      button.addEventListener('click', () => {
        this.galleryScrollTop = grid.scrollTop;
        this.openImageViewer(manifests, index, button);
      });
      grid.append(button);
    }
    this.mountGalleryThumbnails(grid, assets);
    requestAnimationFrame(() => { grid.scrollTop = this.galleryScrollTop; });
  }

  private mountGalleryThumbnails(grid: HTMLElement, assets: GalleryAsset[]): void {
    const session = this.session;
    if (!session) return;
    const epoch = this.runtimeEpoch;
    const loadThumbnail = async (tile: HTMLButtonElement) => {
      const index = Number(tile.dataset.galleryIndex);
      const manifest = Number.isSafeInteger(index) ? assets[index]?.manifest : undefined;
      if (!manifest || tile.dataset.thumbnailState === 'loading' || tile.dataset.thumbnailState === 'loaded') return;
      tile.dataset.thumbnailState = 'loading';
      tile.querySelector<HTMLElement>('.tile-loading')!.textContent = '正在载入…';
      try {
        const cached = await this.loadImage(manifest);
        if (!this.isRuntimeActive(epoch, session) || !tile.isConnected) return;
        const image = document.createElement('img');
        image.src = cached.url;
        image.alt = manifest.originalName || '相册图片';
        image.decoding = 'async';
        const time = tile.querySelector('time');
        tile.replaceChildren(image);
        if (time) tile.append(time);
        tile.dataset.thumbnailState = 'loaded';
      } catch (cause) {
        if (!this.isRuntimeActive(epoch, session) || !tile.isConnected) return;
        tile.dataset.thumbnailState = 'error';
        const label = tile.querySelector<HTMLElement>('.tile-loading');
        if (label) label.textContent = cause instanceof Error ? cause.message : '载入失败，点按重试';
      }
    };

    if (!('IntersectionObserver' in window)) {
      grid.querySelectorAll<HTMLButtonElement>('.gallery-tile').forEach((tile) => void loadThumbnail(tile));
      return;
    }
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
      this.showNotice('相册仅对会话创建者开放', 'error');
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
        <div class="detail-stage"><p id="detail-loading">正在下载并校验原图…</p></div>
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
        void downloadBlob(cached.blob, manifest.originalName || 'image').catch((cause) => {
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
    const update = (row: HTMLElement, value: boolean | null) => {
      const state = value === null ? 'syncing' : value ? 'online' : 'offline';
      row.dataset.state = state;
      row.querySelector<HTMLElement>('strong')!.textContent = value === null ? '同步中' : value ? '在线' : '离线';
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
    summary.dataset.state = snapshotAvailable ? 'ready' : 'syncing';
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
    this.captureChatAnchor(false);
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
    for (const cached of this.imageCache.values()) URL.revokeObjectURL(cached.url);
    this.imageCache.clear();
    this.imageLoadPromises.clear();
    this.imageManifestSignatures.clear();
    this.imageCacheBytes = 0;
    this.connectionState = 'disconnected';
    this.rolePresence = null;
    this.activeSurface = 'away';
    this.uiPreferences = { favoriteExpressions: [] };
    this.restoreChatAnchorOnNextRender = true;
    this.expressionTab = 'emoji';
    this.galleryScrollTop = 0;
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.sendChain = Promise.resolve();
    if (!preserveFilePicker) {
      this.deferredImageUpload = null;
      this.filePickerActive = false;
      this.finishImagePicker();
    }
  }

  private resetIdleLock(): void {
    if (!this.session) return;
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => this.lockNow(), 10 * 60_000);
  }
}
