import QRCode from 'qrcode';
import {
  ApiError,
  completeBlob,
  createRoom,
  fetchBlobChunk,
  getBlobStatus,
  getRoomState,
  joinRoom,
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
import { gestureSecret, GesturePad, RECOMMENDED_GESTURE_POINTS } from './lib/gesture';
import {
  createCreatorMlsState,
  decryptMlsApplication,
  encryptMlsApplication,
  joinMlsGroup,
  prepareCreatorWelcome,
} from './lib/mls';
import {
  backgroundNotificationStatus,
  disableBackgroundNotifications,
  enableBackgroundNotifications,
} from './lib/push';
import type {
  DecryptedMessage,
  DeliveryReceipt,
  ImageManifest,
  ImageUploadPlan,
  MessagePayload,
  OutboxItem,
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
  deletePendingReceipt,
  deleteUploadPlan,
  downloadRecoveryPackage,
  hasStoredVault,
  importRecoveryPackage,
  bindRecoveredVaultToPlatform,
  loadHistory,
  loadOutbox,
  loadPendingReceipts,
  loadUploadPlans,
  migrateVaultToPlatform,
  readStoredVault,
  saveOutboxItem,
  savePendingReceipt,
  saveHistoryMessage,
  saveUploadPlan,
  saveVault,
  unlockRecoveryVault,
  unlockVault,
  type VaultSession,
} from './lib/vault';

type Invite = {
  v: 1;
  roomId: string;
  accessToken: string;
  pairingSecret: string;
  creatorFingerprint: string;
};

type CachedImage = { blob: Blob; url: string };

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
};

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
  private connectionState: 'connecting' | 'connected' | 'disconnected' = 'disconnected';
  private draining = false;
  private receiptDraining = false;
  private coverTimer: number | null = null;
  private idleTimer: number | null = null;
  private sendChain: Promise<void> = Promise.resolve();
  private sending = new Set<string>();
  private retryTimers = new Map<string, number>();
  private retryCounts = new Map<string, number>();
  private gesturePad: GesturePad | null = null;
  private privacyCovered = true;
  private runtimeAbort: AbortController | null = null;
  private runtimeEpoch = 0;
  private filePickerActive = false;
  private imagePickerActive = false;
  private imagePickerResetTimer: number | null = null;
  private deferredImageUpload: { file: File; destination: 'chat' | 'gallery' } | null = null;
  private unlocking = false;
  private galleryObserver: IntersectionObserver | null = null;

  constructor(private readonly root: HTMLElement) {
    document.addEventListener('pointerdown', () => this.resetIdleLock(), { capture: true, passive: true });
    document.addEventListener('keydown', () => this.resetIdleLock(), { capture: true });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && !this.imagePickerActive) this.lockNow({ preserveFilePicker: this.filePickerActive });
    });
    window.addEventListener('blur', () => {
      if (!this.imagePickerActive) this.lockNow({ preserveFilePicker: this.filePickerActive });
    });
    window.addEventListener('pagehide', () => {
      this.finishImagePicker();
      this.lockNow({ preserveFilePicker: false });
    });
  }

  async start(): Promise<void> {
    this.renderCover();
  }

  private renderCover(preserveFilePicker = false): void {
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
    if (hasVault) void this.renderUnlock();
    else this.renderFirstRun(inviteFromHash());
  }

  private gatewayTemplate(title: string, subtitle: string, content: string): void {
    this.root.innerHTML = `
      <section class="gateway">
        <div class="gateway-mark" aria-hidden="true">${icons.lock}</div>
        <div class="gateway-heading">
          <p class="eyebrow">Quiet Room</p>
          <h1>${title}</h1>
          <p>${subtitle}</p>
        </div>
        ${content}
        <p class="privacy-note">解锁凭据和解密密钥只在这台设备上使用，服务器无法代为找回。</p>
      </section>
    `;
  }

  private async renderUnlock(): Promise<void> {
    const stored = await readStoredVault();
    if (this.privacyCovered || !stored) return;
    if (stored.unlockMethod === 'recovery') {
      this.renderRecoveryUnlock();
      return;
    }
    if (stored.v === 1 && stored.unlockMethod !== 'gesture') {
      this.gatewayTemplate('升级旧保险库', '输入原本机密码。解锁后需要设置手势，并通过设备安全验证完成一次性迁移。', `
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
    } else {
      const platformBound = stored.v === 2;
      this.gatewayTemplate('回到会话', platformBound
        ? '绘制本机手势，然后使用生物识别、设备密码或硬件安全密钥解锁。'
        : '绘制旧版本机手势。解锁后需要绑定设备安全凭据。', `
        ${this.gestureSetupMarkup('连接至少 4 个点，建议使用 6 个或更多点。')}
        <div class="gateway-secondary">
          <button class="text-button" id="back-to-cover" type="button">返回白屏</button>
        </div>
      `);
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
            const unlocked = await unlockVault(secret);
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
    }
    this.root.querySelector('#back-to-cover')?.addEventListener('click', () => this.lockNow());
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

  private gestureSetupMarkup(instruction: string): string {
    return `
      <div class="gesture-block">
        <p class="gesture-instruction">${instruction}</p>
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

  private mountGestureSetup(onConfirmed: (secret: string) => Promise<void>, busyLabel: string): void {
    const instruction = this.root.querySelector<HTMLElement>('.gesture-instruction')!;
    const error = this.root.querySelector<HTMLElement>('.form-error')!;
    let firstSecret = '';
    let busy = false;
    this.mountGesturePad((pattern) => {
      if (busy) return;
      let secret: string;
      try {
        secret = gestureSecret(pattern);
      } catch (cause) {
        error.textContent = cause instanceof Error ? cause.message : '手势无法识别';
        return;
      }
      error.textContent = '';
      if (!firstSecret) {
        firstSecret = secret;
        instruction.textContent = pattern.length < RECOMMENDED_GESTURE_POINTS
          ? '已记录。该手势可用，但建议至少连接 6 个点。请再绘制一次确认。'
          : '已记录，请再绘制一次相同手势确认。';
        return;
      }
      if (secret !== firstSecret) {
        firstSecret = '';
        secret = '';
        error.textContent = '两次手势不一致，请重新设置';
        instruction.textContent = '重新绘制新手势。至少连接 4 个点，建议 6 个或更多点。';
        return;
      }
      firstSecret = '';
      busy = true;
      instruction.textContent = busyLabel;
      void onConfirmed(secret).finally(() => {
        secret = '';
        busy = false;
      });
    }, '设置手势');
  }

  private renderPlatformMigration(): void {
    if (!this.session) return;
    this.gatewayTemplate('绑定这台设备', '旧保险库已解锁。设置手势后，浏览器会要求生物识别、设备密码或硬件安全密钥确认。', `
      ${this.gestureSetupMarkup('绘制新手势。至少连接 4 个点，建议 6 个或更多点。')}
      <button class="text-button gateway-back" id="migration-lock" type="button">取消并锁定</button>
    `);
    this.mountGestureSetup(async (secret) => {
      const session = this.session;
      if (!session) return;
      try {
        await migrateVaultToPlatform(session, secret);
        if (!this.privacyCovered && this.session === session) await this.openSession();
      } catch (cause) {
        if (!this.privacyCovered) {
          this.root.querySelector<HTMLElement>('.form-error')!.textContent = cause instanceof Error
            ? cause.message
            : '设备绑定失败';
        }
      }
    }, '请完成设备安全验证…');
    this.root.querySelector('#migration-lock')?.addEventListener('click', () => this.lockNow());
  }

  private renderRecoveredVaultBinding(): void {
    if (!this.session) return;
    this.gatewayTemplate('重新绑定设备', '恢复码已验证。设置新的本机手势，并用设备安全凭据保护保险库密钥。', `
      ${this.gestureSetupMarkup('绘制新手势。至少连接 4 个点，建议 6 个或更多点。')}
      <button class="text-button gateway-back" id="recovery-lock" type="button">取消并锁定</button>
    `);
    this.mountGestureSetup(async (secret) => {
      const session = this.session;
      if (!session) return;
      try {
        await bindRecoveredVaultToPlatform(session, secret);
        if (!this.privacyCovered && this.session === session) await this.openSession();
      } catch (cause) {
        if (!this.privacyCovered) {
          this.root.querySelector<HTMLElement>('.form-error')!.textContent = cause instanceof Error
            ? cause.message
            : '重新绑定设备失败';
        }
      }
    }, '请完成设备安全验证…');
    this.root.querySelector('#recovery-lock')?.addEventListener('click', () => this.lockNow());
  }

  private renderFirstRun(invite: Invite | null): void {
    if (invite) {
      this.renderJoin(invite);
      return;
    }
    this.gatewayTemplate('建立私密会话', '只允许两台设备加入，不需要账号。', `
      <div class="choice-stack">
        <button class="choice-row" id="create-room" type="button">
          <span><strong>创建会话</strong><small>生成一次性邀请，等待另一台设备加入</small></span>
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
    this.gatewayTemplate('创建会话', '设置本机手势后，用设备安全凭据保护保险库密钥。', `
      ${this.gestureSetupMarkup('绘制新手势。至少连接 4 个点，建议 6 个或更多点。')}
      <button class="text-button gateway-back" type="button">返回</button>
    `);
    this.mountGestureSetup(
      (secret) => this.handleCreate(secret),
      '请完成设备安全验证…',
    );
    this.root.querySelector('.gateway-back')?.addEventListener('click', () => this.renderFirstRun(null));
  }

  private async handleCreate(secret: string): Promise<void> {
    const error = this.root.querySelector<HTMLElement>('.form-error')!;
    error.textContent = '';
    try {
      const identity = await generateIdentity();
      const accessToken = randomBase64Url(32);
      const pairingSecret = randomBase64Url(32);
      const room = await createRoom(identity.publicBundle, accessToken);
      if (room.protocol !== 'mls-rfc9420') {
        throw new SecurityViolation('服务器未按 MLS 协议创建会话，已拒绝继续');
      }
      const creatorFingerprint = await bundleFingerprint(identity.publicBundle);
      const creator: RoomMember = {
        ...identity.publicBundle,
        role: 'creator',
        joinProof: null,
        createdAt: room.createdAt,
      };
      const vault: Vault = {
        v: 2,
        roomId: room.roomId,
        accessToken,
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
      const createdSession = await createVault(vault, secret, 'gesture');
      if (this.privacyCovered) return;
      this.session = createdSession;
      await this.openSession();
    } catch (cause) {
      if (!this.privacyCovered) error.textContent = cause instanceof Error ? cause.message : '创建失败';
    }
  }

  private renderPasteInvite(): void {
    this.gatewayTemplate('使用邀请加入', '粘贴完整邀请链接。邀请中的密钥片段不会作为 HTTP 参数发送。', `
      <form class="gateway-form" id="paste-form">
        <label>邀请链接<textarea name="invite" rows="4" inputmode="url" required autofocus></textarea></label>
        <p class="form-error" role="alert"></p>
        <button class="primary-button" type="submit">继续</button>
      </form>
      <button class="text-button gateway-back" type="button">返回</button>
    `);
    const form = this.root.querySelector<HTMLFormElement>('#paste-form')!;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const invite = inviteFromText(String(new FormData(form).get('invite') ?? ''));
      if (!invite) {
        form.querySelector<HTMLElement>('.form-error')!.textContent = '邀请链接无法识别';
        return;
      }
      this.renderJoin(invite);
    });
    this.root.querySelector('.gateway-back')?.addEventListener('click', () => this.renderFirstRun(null));
  }

  private renderJoin(invite: Invite): void {
    this.gatewayTemplate('加入私密会话', '设置本机手势后，用设备安全凭据保护保险库密钥。该邀请仅允许绑定一台新设备。', `
      ${this.gestureSetupMarkup('绘制新手势。至少连接 4 个点，建议 6 个或更多点。')}
      <button class="text-button gateway-back" type="button">返回</button>
    `);
    this.mountGestureSetup(
      (secret) => this.handleJoin(secret, invite),
      '请完成设备安全验证…',
    );
    this.root.querySelector('.gateway-back')?.addEventListener('click', () => this.renderFirstRun(null));
  }

  private async handleJoin(secret: string, invite: Invite): Promise<void> {
    const error = this.root.querySelector<HTMLElement>('.form-error')!;
    error.textContent = '';
    try {
      const initialState = await getRoomState(invite.roomId, invite.accessToken);
      if (this.privacyCovered) return;
      const creator = initialState.members.find((member) => member.role === 'creator');
      if (!creator || await bundleFingerprint(memberBundle(creator)) !== invite.creatorFingerprint) {
        throw new Error('创建者身份与邀请不一致，已拒绝加入');
      }
      if (initialState.members.length !== 1) throw new Error('该会话已经绑定两台设备');
      if (initialState.protocol !== 'legacy-v1' && initialState.protocol !== 'mls-rfc9420') {
        throw new SecurityViolation('服务器没有声明受支持的会话加密协议');
      }
      if (initialState.protocol === 'mls-rfc9420' && !creator.mlsKeyPackage) {
        throw new SecurityViolation('MLS 会话的创建者密钥包缺失');
      }
      const identity = await generateIdentity();
      const proof = await createJoinProof(invite.pairingSecret, identity.publicBundle);
      const provisionalJoiner: RoomMember = {
        ...identity.publicBundle,
        role: 'joiner',
        joinProof: proof,
        createdAt: new Date().toISOString(),
      };
      const vault: Vault = {
        v: 2,
        roomId: invite.roomId,
        accessToken: invite.accessToken,
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
      const createdSession = await createVault(vault, secret, 'gesture');
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
      if (!this.privacyCovered) error.textContent = cause instanceof Error ? cause.message : '无法加入会话';
    }
  }

  private async openSession(): Promise<void> {
    const session = this.session;
    if (!session || this.privacyCovered) return;
    const epoch = this.runtimeEpoch;
    this.runtimeAbort?.abort();
    this.runtimeAbort = new AbortController();
    this.resetIdleLock();
    const cached = await loadHistory(session);
    if (!this.isRuntimeActive(epoch, session)) return;
    this.messages = new Map(cached.map((message) => [message.seq, {
      ...message,
      status: message.status === 'sent'
        ? (message.senderId === session.vault.identity.publicBundle.deviceId ? 'stored' : 'delivered')
        : message.status,
    }]));
    let contiguousSeq = session.vault.historyUnavailableBeforeSeq ?? 0;
    while (this.messages.has(contiguousSeq + 1)) contiguousSeq += 1;
    session.vault.lastSeq = contiguousSeq;
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
    if (!this.isRuntimeActive(epoch, session)) return;
    if (session.vault.members.length < 2) this.renderInviteWait();
    else this.renderChat();
    this.connectSocket();
    if (session.vault.members.length === 2) void this.resumeDeferredImage();
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
      session.vault.accessToken,
      session.vault.identity.publicBundle,
      ownMember.joinProof,
    );
    if (!this.isRuntimeActive(epoch, session)) return;
    await this.applyRoomState(state);
    if (!this.isRuntimeActive(epoch, session)) return;
    session.vault.pairingState = 'ready';
    await saveVault(session);
  }

  private renderPendingJoin(cause?: unknown): void {
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
    const creator = state.members.find((member) => member.role === 'creator');
    const joiner = state.members.find((member) => member.role === 'joiner');
    if (!creator || await bundleFingerprint(memberBundle(creator)) !== session.vault.creatorFingerprint) {
      throw new SecurityViolation('服务器返回的创建者身份已改变，已停止连接');
    }
    if (!this.isRuntimeActive(epoch, session)) return;
    const ownStored = session.vault.identity.publicBundle;
    const ownRemote = state.members.find((member) => member.deviceId === ownStored.deviceId);
    if (!ownRemote || canonicalStringify(memberBundle(ownRemote)) !== canonicalStringify(ownStored)) {
      throw new SecurityViolation('服务器返回的本设备公钥已改变，已停止连接');
    }
    if (joiner) {
      if (!joiner.joinProof || !(await verifyJoinProof(session.vault.pairingSecret, memberBundle(joiner), joiner.joinProof))) {
        throw new SecurityViolation('加入设备未通过邀请密钥验证，已停止连接');
      }
      const knownJoiner = session.vault.members.find((member) => member.role === 'joiner');
      if (knownJoiner && await bundleFingerprint(memberBundle(knownJoiner)) !== await bundleFingerprint(memberBundle(joiner))) {
        throw new SecurityViolation('加入设备身份发生变化，已停止连接');
      }
    }
    if (!this.isRuntimeActive(epoch, session)) return;
    session.vault.protocol = localProtocol;
    session.vault.members = state.members;
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
          this.updateConnectionStatus();
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
          if ((this.session?.vault.members.length ?? 0) === 2) void this.drainServerQueue();
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
        error: (message, code) => {
          if (!this.isRuntimeActive(epoch, session) || this.socket !== roomSocket) return;
          this.showNotice(message, 'error');
          if (code?.startsWith('INVALID_') || code === 'MESSAGE_CONFLICT' || code === 'RECEIPT_CONFLICT') {
            this.fatalSecurityError(new SecurityViolation(message));
          }
        },
      },
    );
    this.socket = roomSocket;
    roomSocket.connect();
  }

  private async handleMembership(state: RoomState): Promise<void> {
    const session = this.session;
    if (!session) return;
    const epoch = this.runtimeEpoch;
    try {
      const before = session.vault.members.length;
      const mlsWasReady = session.vault.protocol !== 'mls-rfc9420' || session.vault.mls?.phase === 'active';
      await this.applyRoomState(state);
      if (!this.isRuntimeActive(epoch, session)) return;
      await this.ensureMlsReady(state);
      if (!this.isRuntimeActive(epoch, session)) return;
      const mlsBecameReady = !mlsWasReady && session.vault.mls?.phase === 'active';
      if ((before < 2 && state.members.length === 2) || mlsBecameReady) {
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
      if (state.members.length < 2) return;
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
        const own = serverMessage.envelope.senderId === session.vault.identity.publicBundle.deviceId;
        try {
          if (serverMessage.envelope.v === 2) {
            if (own) {
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
          status: own ? 'stored' : 'delivered',
        };
        try {
          let receipt: DeliveryReceipt | null = null;
          if (!own) {
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
          if (own) {
            this.clearRetry(message.clientMsgId);
            await deleteOutboxItem(session, message.clientMsgId);
          }
          if (!this.isRuntimeActive(epoch, session)) return;
          this.messages.set(message.seq, message);
          this.serverQueue.delete(expected);
          this.pending.delete(message.clientMsgId);
          if (own) this.outbox.delete(message.clientMsgId);
          if (receipt) {
            this.pendingReceipts.set(receipt.clientMsgId, receipt);
            this.sendPendingReceipt(receipt);
          }
          expected += 1;
        } catch (cause) {
          let durableSeq = 0;
          while (this.messages.has(durableSeq + 1)) durableSeq += 1;
          session.vault.lastSeq = durableSeq;
          if (!this.isRuntimeActive(epoch, session)) return;
          this.operationalError(cause);
          break;
        }
      }
      this.renderMessages();
      this.updateGalleryCount();
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
        const receipt = serverReceipt.receipt;
        const message = this.messages.get(receipt.seq);
        if (!message) {
          this.socket?.requestSync(session.vault.lastSeq);
          break;
        }
        if (
          message.clientMsgId !== receipt.clientMsgId ||
          message.senderId === receipt.receiverId ||
          !(await verifyDeliveryReceipt(session.vault, receipt))
        ) {
          if (!this.isRuntimeActive(epoch, session)) return;
          this.fatalSecurityError(new SecurityViolation('对端送达回执未通过签名或消息绑定校验'));
          return;
        }
        try {
          if (message.senderId === session.vault.identity.publicBundle.deviceId) {
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
    document.body.className = 'app-mode';
    const invite: Invite = {
      v: 1,
      roomId: this.session.vault.roomId,
      accessToken: this.session.vault.accessToken,
      pairingSecret: this.session.vault.pairingSecret,
      creatorFingerprint: this.session.vault.creatorFingerprint,
    };
    const inviteUrl = makeInviteUrl(invite);
    this.root.innerHTML = `
      <section class="pairing-screen">
        <header class="pairing-header">
          <div><p class="eyebrow">一次性邀请</p><h1>等待另一台设备</h1></div>
          <button class="icon-button" id="pairing-lock" type="button" aria-label="锁定并返回白屏">${icons.lock}</button>
        </header>
        <div class="pairing-body">
          <canvas id="invite-qr" width="248" height="248" aria-label="会话邀请二维码"></canvas>
          <p class="pairing-instruction">让对方扫描二维码，或安全地发送邀请链接。第二台设备加入后，房间将永久封闭。</p>
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
    const cryptoReady = this.session.vault.protocol !== 'mls-rfc9420' || this.session.vault.mls?.phase === 'active';
    this.galleryObserver?.disconnect();
    this.galleryObserver = null;
    document.body.className = 'app-mode';
    this.root.innerHTML = `
      <section class="chat-shell">
        <header class="chat-header">
          <div class="peer-summary">
            <span class="peer-avatar" aria-hidden="true">二</span>
            <div><h1>私密会话</h1><p id="peer-status">正在确认连接…</p></div>
          </div>
          <nav class="header-actions" aria-label="会话操作">
            ${this.session.vault.role === 'creator' ? `
              <button class="icon-button gallery-button" id="open-gallery" type="button" aria-label="查看相册">
                ${icons.image}<span id="gallery-count" class="badge" hidden></span>
              </button>
            ` : ''}
            <details class="more-menu">
              <summary class="icon-button" aria-label="更多操作">${icons.more}</summary>
              <div class="menu-panel">
                <p class="menu-title">本机安全</p>
                <p class="protocol-label">${this.session.vault.protocol === 'mls-rfc9420' ? 'RFC 9420 MLS · 前向保密' : '旧版静态会话密钥 · 建议重建会话'}</p>
                <p class="safety-label">设备安全码</p>
                <code class="safety-code" id="safety-code">正在计算…</code>
                <button id="toggle-notifications" type="button">${icons.bell}<span>后台通知：正在检查…</span></button>
                <button id="export-recovery" type="button">${icons.download}<span>导出加密恢复包</span></button>
                <button id="lock-room" type="button">${icons.lock}<span>立即锁定</span></button>
                <p class="menu-footnote">恢复包包含加密后的设备私钥，请勿与解锁手势一起分享。</p>
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
              <div><strong>先保存恢复包</strong><span>忘记解锁手势或清除浏览器数据后，服务器无法找回密钥。</span></div>
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
          <label class="image-picker icon-button" aria-label="发送原图">
            ${icons.image}
            <input id="image-input" type="file" accept="image/*" />
          </label>
          <label class="composer-field"><span class="sr-only">输入消息</span><textarea id="message-input" rows="1" maxlength="4000" placeholder="${cryptoReady ? '输入消息' : '正在建立安全会话…'}" enterkeyhint="send" ${cryptoReady ? '' : 'disabled'}></textarea></label>
          <button class="send-button" type="submit" aria-label="发送消息" ${cryptoReady ? '' : 'disabled'}>${icons.send}</button>
          <div class="upload-progress" id="upload-progress" hidden><span></span><output></output></div>
        </form>
      </section>
    `;
    this.root.querySelector('#composer')?.addEventListener('submit', (event) => void this.handleSendText(event));
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
    const imageInput = this.root.querySelector<HTMLInputElement>('#image-input');
    this.mountImagePicker(imageInput, 'chat');
    this.root.querySelector('#open-gallery')?.addEventListener('click', () => this.renderGallery());
    this.root.querySelector('#export-recovery')?.addEventListener('click', () => void this.exportRecovery());
    this.root.querySelector('#reminder-export')?.addEventListener('click', () => void this.exportRecovery());
    this.root.querySelector('#lock-room')?.addEventListener('click', () => this.lockNow());
    this.root.querySelector('#toggle-notifications')?.addEventListener('click', () => void this.toggleBackgroundNotifications());
    this.renderMessages();
    this.updateGalleryCount();
    this.updatePeerStatus();
    void this.updateSafetyCode();
    void this.updateBackgroundNotificationControl();
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
    if (!text) return;
    const payload: MessagePayload = { v: 1, kind: 'text', text, sentAt: new Date().toISOString() };
    if (input) {
      input.value = '';
      input.style.height = 'auto';
    }
    await this.enqueuePayload(payload);
    if (this.connectionState !== 'connected') this.showNotice('消息已加密保存在本机，连接恢复后会自动发送');
  }

  private enqueuePayload(payload: MessagePayload, existingClientMsgId?: string): Promise<void> {
    this.sendChain = this.sendChain.then(() => this.sendPayload(payload, existingClientMsgId));
    return this.sendChain;
  }

  private async sendPayload(payload: MessagePayload, existingClientMsgId?: string): Promise<void> {
    const session = this.session;
    if (!session || this.privacyCovered) return;
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
      return;
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
    this.renderMessages();
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

  private beginImagePicker(): void {
    this.imagePickerActive = true;
    if (this.imagePickerResetTimer !== null) window.clearTimeout(this.imagePickerResetTimer);
    this.imagePickerResetTimer = window.setTimeout(() => this.finishImagePicker(), 5 * 60_000);
  }

  private finishImagePicker(): void {
    this.imagePickerActive = false;
    if (this.imagePickerResetTimer !== null) window.clearTimeout(this.imagePickerResetTimer);
    this.imagePickerResetTimer = null;
  }

  private mountImagePicker(input: HTMLInputElement | null, destination: 'chat' | 'gallery'): void {
    input?.addEventListener('click', () => this.beginImagePicker());
    input?.addEventListener('cancel', () => {
      this.finishImagePicker();
      this.deferredImageUpload = null;
    });
    input?.addEventListener('change', (event) => void this.handleSendImage(event, destination));
  }

  private async handleSendImage(event: Event, destination: 'chat' | 'gallery'): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    this.finishImagePicker();
    if (!file) {
      this.deferredImageUpload = null;
      return;
    }
    if (!this.session || this.privacyCovered) {
      this.deferredImageUpload = { file, destination };
      return;
    }
    await this.processImageFile(file, destination);
  }

  private async resumeDeferredImage(): Promise<void> {
    if (!this.deferredImageUpload || !this.session || this.privacyCovered) return;
    const { file, destination } = this.deferredImageUpload;
    this.deferredImageUpload = null;
    await this.processImageFile(file, destination);
  }

  private async processImageFile(file: File, destination: 'chat' | 'gallery' = 'chat'): Promise<void> {
    const session = this.session;
    if (!session || this.privacyCovered) return;
    if (destination === 'gallery' && session.vault.role !== 'creator') {
      this.showNotice('只有会话创建者可以向相册上传图片', 'error');
      return;
    }
    const epoch = this.runtimeEpoch;
    const signal = this.runtimeAbort?.signal;
    if (file.size > MAX_IMAGE_BYTES) {
      this.showNotice('首版单张原图上限为 256 MiB', 'error');
      return;
    }
    const uploadScope = this.root.querySelector<HTMLElement>(destination === 'gallery' ? '.gallery-shell' : '#composer');
    const progress = this.root.querySelector<HTMLElement>('#upload-progress');
    const bar = progress?.querySelector<HTMLElement>('span');
    const output = progress?.querySelector<HTMLOutputElement>('output');
    uploadScope?.classList.add('is-uploading');
    uploadScope?.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement | HTMLInputElement>('button, textarea, input').forEach((control) => {
      control.disabled = true;
    });
    if (progress) progress.hidden = false;
    try {
      const vault = session.vault;
      const existingPlan = this.uploadPlans.find((plan) =>
        plan.originalSize === file.size &&
        plan.originalName === file.name &&
        plan.mimeType === file.type &&
        plan.lastModified === file.lastModified,
      );
      const manifest = await encryptImageFile(file, {
        reserve: (blobId, chunkCount, encryptedSize) =>
          reserveBlob(vault.roomId, vault.accessToken, blobId, chunkCount, encryptedSize, signal),
        status: (blobId) => getBlobStatus(vault.roomId, vault.accessToken, blobId, signal),
        upload: (blobId, index, bytes) => this.retryOperation(
          () => uploadBlobChunk(vault.roomId, vault.accessToken, blobId, index, bytes, signal),
          3,
          signal,
        ),
        complete: (blobId) => completeBlob(vault.roomId, vault.accessToken, blobId, signal),
        savePlan: async (plan) => {
          await saveUploadPlan(session, plan);
          if (!this.isRuntimeActive(epoch, session)) return;
          if (!this.uploadPlans.some((item) => item.blobId === plan.blobId)) this.uploadPlans.push(plan);
        },
        progress: (ratio) => {
          if (!this.isRuntimeActive(epoch, session)) return;
          if (bar) bar.style.transform = `scaleX(${ratio})`;
          if (output) output.textContent = `正在加密上传原图 ${Math.round(ratio * 100)}%`;
        },
        signal,
      }, existingPlan);
      if (!this.isRuntimeActive(epoch, session)) return;
      const clientMsgId = crypto.randomUUID();
      await this.enqueuePayload(
        { v: 1, kind: destination === 'gallery' ? 'gallery-image' : 'image', image: manifest, sentAt: new Date().toISOString() },
        clientMsgId,
      );
      if (this.outbox.has(clientMsgId)) {
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
      uploadScope?.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement | HTMLInputElement>('button, textarea, input').forEach((control) => {
        control.disabled = false;
      });
      if (progress) progress.hidden = true;
      if (bar) bar.style.transform = 'scaleX(0)';
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

  private renderMessages(): void {
    const list = this.root.querySelector<HTMLElement>('#message-list');
    if (!list || !this.session) return;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
    list.replaceChildren();
    const messages = this.orderedMessages();
    if (messages.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-conversation';
      empty.innerHTML = '<p>会话已经准备好</p><span>文字和原图都会在这台设备上加密后再发送。</span>';
      list.append(empty);
    } else {
      for (const message of messages) list.append(this.createMessageElement(message));
    }
    if (nearBottom || messages.length <= 1) requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  }

  private createMessageElement(message: DecryptedMessage): HTMLElement {
    const own = message.senderId === this.session?.vault.identity.publicBundle.deviceId;
    const article = document.createElement('article');
    article.className = `message ${own ? 'outgoing' : 'incoming'} is-${message.status}`;
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    if (message.payload.kind === 'text') {
      const text = document.createElement('p');
      text.textContent = message.payload.text;
      bubble.append(text);
    } else {
      bubble.classList.add('image-bubble');
      bubble.append(this.createImagePreview(message.payload.image));
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
    article.append(bubble, meta);
    return article;
  }

  private async exportRecovery(): Promise<void> {
    const session = this.session;
    if (!session || this.privacyCovered) return;
    const epoch = this.runtimeEpoch;
    try {
      const recovery = await downloadRecoveryPackage(session);
      if (!this.isRuntimeActive(epoch, session)) return;
      session.vault.recoveryExportedAt = recovery.exportedAt;
      await saveVault(session);
      if (!this.isRuntimeActive(epoch, session)) return;
      this.showRecoveryCode(recovery.recoveryCode);
      this.root.querySelector('.recovery-reminder')?.remove();
    } catch (cause) {
      this.operationalError(cause, '恢复包导出失败');
    }
  }

  private showRecoveryCode(recoveryCode: string): void {
    this.root.querySelector('.recovery-code-sheet')?.remove();
    const sheet = document.createElement('section');
    sheet.className = 'recovery-code-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-labelledby', 'recovery-code-title');
    sheet.innerHTML = `
      <div class="recovery-code-panel">
        <p class="eyebrow">一次性显示</p>
        <h2 id="recovery-code-title">单独保存恢复码</h2>
        <p>刚下载的恢复文件无法单独解锁。请把下面的恢复码保存在不同的位置；关闭后无法再次查看，只能重新导出一组。</p>
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
      sheet.remove();
      this.showNotice('恢复文件和恢复码已生成，请分开保存');
    };
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

  private createImagePreview(manifest: ImageManifest): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'image-preview';
    const cached = this.imageCache.get(manifest.blobId);
    if (cached) {
      const image = document.createElement('img');
      image.src = cached.url;
      image.alt = manifest.originalName || '聊天图片';
      wrapper.append(image);
      return wrapper;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.innerHTML = `${icons.image}<span>载入原图</span><small>${this.fileSize(manifest.originalSize)}</small>`;
    button.addEventListener('click', async () => {
      button.disabled = true;
      button.querySelector('span')!.textContent = '正在本地解密…';
      try {
        const cachedImage = await this.loadImage(manifest);
        const image = document.createElement('img');
        image.src = cachedImage.url;
        image.alt = manifest.originalName || '聊天图片';
        wrapper.replaceChildren(image);
      } catch (cause) {
        button.disabled = false;
        button.querySelector('span')!.textContent = cause instanceof Error ? cause.message : '载入失败';
      }
    });
    wrapper.append(button);
    return wrapper;
  }

  private async loadImage(manifest: ImageManifest): Promise<CachedImage> {
    const existing = this.imageCache.get(manifest.blobId);
    if (existing) return existing;
    const session = this.session;
    if (!session || this.privacyCovered) throw new Error('会话已锁定');
    const epoch = this.runtimeEpoch;
    const signal = this.runtimeAbort?.signal;
    const { roomId, accessToken } = session.vault;
    const blob = await decryptImageFile(
      manifest,
      (blobId, index) => fetchBlobChunk(roomId, accessToken, blobId, index, signal),
      undefined,
      signal,
    );
    if (!this.isRuntimeActive(epoch, session)) throw new DOMException('Session locked', 'AbortError');
    const cached = { blob, url: URL.createObjectURL(blob) };
    this.imageCache.set(manifest.blobId, cached);
    return cached;
  }

  private renderGallery(): void {
    const session = this.session;
    if (!session || this.privacyCovered) return;
    if (session.vault.role !== 'creator') {
      this.renderChat();
      this.showNotice('相册仅对会话创建者开放', 'error');
      return;
    }
    const cryptoReady = session.vault.protocol !== 'mls-rfc9420' || session.vault.mls?.phase === 'active';
    const images = [...this.messages.values(), ...this.pending.values()]
      .filter((message) => message.payload.kind === 'image' || message.payload.kind === 'gallery-image')
      .sort((left, right) => right.acceptedAt.localeCompare(left.acceptedAt));
    this.galleryObserver?.disconnect();
    this.galleryObserver = null;
    this.root.innerHTML = `
      <section class="gallery-shell">
        <header class="subpage-header gallery-header">
          <button class="icon-button" id="gallery-back" type="button" aria-label="返回聊天">${icons.back}</button>
          <div><h1>相册</h1><p id="gallery-total">${images.length} 张原图</p></div>
          <label class="icon-button gallery-upload-button${cryptoReady ? '' : ' is-disabled'}" aria-label="上传图片到相册" title="上传图片到相册">
            ${icons.upload}
            <input id="gallery-image-input" type="file" accept="image/*" ${cryptoReady ? '' : 'disabled'} />
          </label>
        </header>
        <div class="notice gallery-notice" id="notice" role="status" hidden></div>
        <div class="upload-progress gallery-upload-progress" id="upload-progress" hidden><span></span><output></output></div>
        <div class="gallery-grid" id="gallery-grid"></div>
      </section>
    `;
    this.root.querySelector('#gallery-back')?.addEventListener('click', () => this.renderChat());
    this.mountImagePicker(this.root.querySelector<HTMLInputElement>('#gallery-image-input'), 'gallery');
    const grid = this.root.querySelector<HTMLElement>('#gallery-grid')!;
    if (images.length === 0) {
      grid.innerHTML = '<div class="gallery-empty"><p>还没有图片</p><span>聊天中的原图和从这里上传的图片都会出现在这里。</span></div>';
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const button = entry.target as HTMLButtonElement;
        observer.unobserve(button);
        const message = images.find((item) => item.clientMsgId === button.dataset.clientMsgId);
        if (message && (message.payload.kind === 'image' || message.payload.kind === 'gallery-image')) {
          void this.populateGalleryTile(button, message.payload.image);
        }
      }
    }, { root: grid, rootMargin: '160px' });
    this.galleryObserver = observer;
    for (const message of images) {
      if (message.payload.kind !== 'image' && message.payload.kind !== 'gallery-image') continue;
      const manifest = message.payload.image;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'gallery-tile';
      button.dataset.clientMsgId = message.clientMsgId;
      button.setAttribute('aria-label', `查看原图 ${manifest.originalName}`);
      button.innerHTML = `<span class="tile-loading">正在解密</span><time>${timeLabel(message.payload.sentAt)}</time>`;
      button.addEventListener('click', () => void this.renderImageDetail(manifest));
      grid.append(button);
      observer.observe(button);
    }
  }

  private async populateGalleryTile(button: HTMLButtonElement, manifest: ImageManifest): Promise<void> {
    try {
      const cached = await this.loadImage(manifest);
      const image = document.createElement('img');
      image.src = cached.url;
      image.alt = '';
      button.prepend(image);
      button.querySelector('.tile-loading')?.remove();
    } catch {
      const loading = button.querySelector<HTMLElement>('.tile-loading');
      if (loading) loading.textContent = '无法载入';
    }
  }

  private async renderImageDetail(manifest: ImageManifest): Promise<void> {
    const session = this.session;
    if (!session || this.privacyCovered) return;
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
        <div class="detail-stage"><p id="detail-loading">正在下载并校验原图…</p></div>
      </section>
    `;
    this.root.querySelector<HTMLElement>('#detail-name')!.textContent = manifest.originalName || '原图';
    this.root.querySelector('#detail-back')?.addEventListener('click', () => this.renderGallery());
    try {
      const cached = await this.loadImage(manifest);
      if (!this.isRuntimeActive(epoch, session)) return;
      const image = document.createElement('img');
      image.src = cached.url;
      image.alt = manifest.originalName || '原图';
      this.root.querySelector('.detail-stage')?.replaceChildren(image);
      this.root.querySelector('#download-image')?.addEventListener('click', () => {
        const anchor = document.createElement('a');
        anchor.href = cached.url;
        anchor.download = manifest.originalName || 'image';
        anchor.click();
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
    const status = this.root.querySelector<HTMLElement>('#peer-status');
    if (!status || !this.session) return;
    const paired = this.session.vault.members.length === 2;
    const mlsPending = this.session.vault.protocol === 'mls-rfc9420' && this.session.vault.mls?.phase !== 'active';
    status.textContent = !paired
      ? '等待另一台设备'
      : mlsPending
        ? '正在建立前向保密会话…'
      : this.connectionState === 'connected'
        ? this.session.vault.protocol === 'mls-rfc9420'
          ? 'MLS 前向保密 · 实时连接正常'
          : '旧版端到端加密 · 实时连接正常'
        : this.connectionState === 'connecting'
          ? '正在恢复实时连接…'
          : '离线 · 新消息会在本机排队';
    status.dataset.state = this.connectionState;
  }

  private updateGalleryCount(): void {
    const badge = this.root.querySelector<HTMLElement>('#gallery-count');
    if (!badge) return;
    const count = [...this.messages.values(), ...this.pending.values()]
      .filter((message) => message.payload.kind === 'image' || message.payload.kind === 'gallery-image')
      .length;
    badge.textContent = String(count);
    badge.hidden = count === 0;
  }

  private async updateSafetyCode(): Promise<void> {
    const target = this.root.querySelector<HTMLElement>('#safety-code');
    if (!target || !this.session || this.session.vault.members.length !== 2) return;
    const fingerprints = await Promise.all(this.session.vault.members.map((member) => bundleFingerprint(memberBundle(member))));
    fingerprints.sort();
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(fingerprints.join(':'))));
    const value = [...digest.slice(0, 12)].map((byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
    target.textContent = value.match(/.{1,4}/g)?.join(' ') ?? value;
  }

  private showNotice(message: string, tone: 'error' | 'info' = 'info'): void {
    const notice = this.root.querySelector<HTMLElement>('#notice');
    if (!notice) return;
    notice.hidden = false;
    notice.dataset.tone = tone;
    notice.textContent = message;
    window.setTimeout(() => {
      if (notice.textContent === message) notice.hidden = true;
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
    this.runtimeEpoch += 1;
    this.runtimeAbort?.abort();
    this.runtimeAbort = null;
    this.gesturePad?.destroy();
    this.gesturePad = null;
    this.galleryObserver?.disconnect();
    this.galleryObserver = null;
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
    this.draining = false;
    this.receiptDraining = false;
    this.unlocking = false;
    for (const cached of this.imageCache.values()) URL.revokeObjectURL(cached.url);
    this.imageCache.clear();
    this.connectionState = 'disconnected';
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
