import type {
  DeliveryReceipt,
  MessageEnvelope,
  MlsMembershipEnvelope,
  MlsWelcomeEnvelope,
  PublicBundle,
  RecoveryRequest,
  RoomState,
  ServerMessage,
  ServerMlsMembershipEvent,
  ServerReceipt,
} from './types';

export type DeviceLinkRecord = {
  linkId: string;
  roomId: string;
  authorizerId: string;
  role: 'creator' | 'joiner';
  expiresAt: string;
  claimedDeviceId: string | null;
  createdAt: string;
  claimedAt: string | null;
  usedAt: string | null;
};

export type DeviceLinkState = { link: DeviceLinkRecord; state: RoomState };

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

async function responseError(response: Response): Promise<Error> {
  try {
    const body = await response.json() as { error?: string; code?: string };
    return new ApiError(body.error || `请求失败（${response.status}）`, response.status, body.code ?? 'REQUEST_FAILED');
  } catch {
    return new ApiError(`请求失败（${response.status}）`, response.status, 'REQUEST_FAILED');
  }
}

async function authorizedFetch(path: string, accessToken: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...init.headers,
    },
  });
  if (!response.ok) throw await responseError(response);
  return response;
}

export async function createRoom(
  creatorBundle: unknown,
  accessToken: string,
  inviteToken = accessToken,
  deviceName = '此设备',
  capabilities: string[] = [],
): Promise<{ roomId: string; createdAt: string; protocol: 'legacy-v1' | 'mls-rfc9420' }> {
  const response = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creatorBundle, accessToken, inviteToken, deviceName, capabilities }),
  });
  if (!response.ok) throw await responseError(response);
  return response.json();
}

export async function deleteRoom(roomId: string, accessToken: string): Promise<void> {
  await authorizedFetch(`/api/rooms/${roomId}`, accessToken, { method: 'DELETE' });
}

export async function getRoomState(roomId: string, accessToken: string): Promise<RoomState> {
  const response = await authorizedFetch(`/api/rooms/${roomId}`, accessToken);
  return response.json();
}

export async function requestRecovery(
  roomId: string,
  request: RecoveryRequest,
  accessToken: string,
  deviceName: string,
  capabilities: string[],
  signal?: AbortSignal,
): Promise<{ state: RoomState }> {
  const response = await fetch(`/api/rooms/${roomId}/recovery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request, accessToken, deviceName, capabilities }),
    signal,
  });
  if (!response.ok) throw await responseError(response);
  return response.json();
}

export async function recoveryStatus(
  roomId: string,
  requestId: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<{ state: RoomState }> {
  const response = await authorizedFetch(`/api/rooms/${roomId}/recovery/${requestId}`, accessToken, { signal });
  return response.json();
}

export async function joinRoom(
  roomId: string,
  accessToken: string,
  bundle: unknown,
  proof: string,
  deviceAccessToken?: string,
  deviceName = '此设备',
  capabilities: string[] = [],
): Promise<RoomState> {
  const response = await authorizedFetch(`/api/rooms/${roomId}/join`, accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bundle, proof, deviceAccessToken, deviceName, capabilities }),
  });
  return response.json();
}

export async function createDeviceLink(
  roomId: string,
  accessToken: string,
  authorizerId: string,
  linkId: string,
  secret: string,
  expiresAt: string,
  signal?: AbortSignal,
): Promise<DeviceLinkRecord> {
  const response = await authorizedFetch(`/api/rooms/${roomId}/device-links`, accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authorizerId, linkId, secret, expiresAt }),
    signal,
  });
  return response.json();
}

export async function listDeviceLinks(
  roomId: string,
  accessToken: string,
): Promise<{ links: DeviceLinkRecord[]; state: RoomState }> {
  const response = await authorizedFetch(`/api/rooms/${roomId}/device-links`, accessToken);
  return response.json();
}

export async function claimDeviceLink(
  linkId: string,
  secret: string,
  bundle: PublicBundle,
  deviceAccessToken: string,
  deviceName: string,
  capabilities: string[],
): Promise<DeviceLinkState> {
  const response = await fetch(`/api/device-links/${linkId}/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret, bundle, deviceAccessToken, deviceName, capabilities }),
  });
  if (!response.ok) throw await responseError(response);
  return response.json();
}

export async function getDeviceLinkStatus(
  linkId: string,
  secret: string,
  deviceAccessToken?: string,
): Promise<DeviceLinkState> {
  const response = await fetch(`/api/device-links/${linkId}/status`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(deviceAccessToken ? { Authorization: `Bearer ${deviceAccessToken}` } : {}),
    },
    body: JSON.stringify({ secret }),
  });
  if (!response.ok) throw await responseError(response);
  return response.json();
}

export async function publishMlsMembership(
  roomId: string,
  accessToken: string,
  event: MlsMembershipEnvelope,
): Promise<{ event: ServerMlsMembershipEvent; state: RoomState }> {
  const response = await authorizedFetch(`/api/rooms/${roomId}/mls-events`, accessToken, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event }),
  });
  return response.json();
}

export async function publishMlsWelcome(
  roomId: string,
  accessToken: string,
  welcome: MlsWelcomeEnvelope,
): Promise<RoomState> {
  const response = await authorizedFetch(`/api/rooms/${roomId}/mls-welcome`, accessToken, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ welcome }),
  });
  return response.json();
}

export async function reserveBlob(
  roomId: string,
  accessToken: string,
  blobId: string,
  chunkCount: number,
  encryptedSize: number,
  signal?: AbortSignal,
): Promise<void> {
  await authorizedFetch(`/api/rooms/${roomId}/blobs`, accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blobId, chunkCount, encryptedSize }),
    signal,
  });
}

export async function getBlobStatus(
  roomId: string,
  accessToken: string,
  blobId: string,
  signal?: AbortSignal,
): Promise<{ uploadedIndexes: number[]; completed: boolean }> {
  const response = await authorizedFetch(`/api/rooms/${roomId}/blobs/${blobId}`, accessToken, { signal });
  return response.json();
}

export async function uploadBlobChunk(
  roomId: string,
  accessToken: string,
  blobId: string,
  index: number,
  bytes: ArrayBuffer,
  signal?: AbortSignal,
): Promise<void> {
  await authorizedFetch(`/api/rooms/${roomId}/blobs/${blobId}/chunks/${index}`, accessToken, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes,
    signal,
  });
}

export async function completeBlob(roomId: string, accessToken: string, blobId: string, signal?: AbortSignal): Promise<void> {
  await authorizedFetch(`/api/rooms/${roomId}/blobs/${blobId}/complete`, accessToken, { method: 'POST', signal });
}

export async function fetchBlobChunk(
  roomId: string,
  accessToken: string,
  blobId: string,
  index: number,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const response = await authorizedFetch(`/api/rooms/${roomId}/blobs/${blobId}/chunks/${index}`, accessToken, { signal });
  return response.arrayBuffer();
}

type AsyncSocketHandler = void | Promise<void>;

export type RoomPresence = {
  creator: boolean;
  joiner: boolean;
};

function isRoomPresence(value: unknown): value is RoomPresence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const roles = value as Record<string, unknown>;
  return Object.keys(roles).length === 2 &&
    typeof roles.creator === 'boolean' &&
    typeof roles.joiner === 'boolean';
}

type SocketHandlers = {
  connection: (state: 'connecting' | 'connected' | 'disconnected') => void;
  presence: (roles: RoomPresence, lastSeen: { creator: number | null; joiner: number | null }) => void;
  ready: (state: RoomState) => AsyncSocketHandler;
  membership: (state: RoomState) => AsyncSocketHandler;
  message: (message: ServerMessage) => AsyncSocketHandler;
  sync: (messages: ServerMessage[]) => AsyncSocketHandler;
  receipt: (receipt: ServerReceipt) => AsyncSocketHandler;
  receiptSync: (receipts: ServerReceipt[]) => AsyncSocketHandler;
  ack: (clientMsgId: string, seq: number) => void;
  receiptAck: (clientMsgId: string, receiptSeq: number) => void;
  error: (message: string, code?: string, clientMsgId?: string) => AsyncSocketHandler;
};

export class RoomSocket {
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private retry = 0;
  private closed = false;
  private heartbeatTimer: number | null = null;
  private lastPongAt = 0;
  private membershipBarrier: Promise<void> = Promise.resolve();
  private desiredPresenceView: 'chat' | 'away' = 'away';
  private authenticated = false;
  private lastSentPresenceView: 'chat' | 'away' | null = null;

  constructor(
    private readonly roomId: string,
    private readonly accessToken: string,
    private readonly afterSeq: () => number,
    private readonly afterReceiptSeq: () => number,
    private readonly handlers: SocketHandlers,
    private readonly deviceId = '',
    private readonly capabilities?: readonly string[],
  ) {}

  connect(): void {
    if (this.closed || this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;
    this.handlers.connection('connecting');
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.socket = new WebSocket(`${scheme}//${location.host}/ws`);
    this.socket.addEventListener('open', () => {
      this.authenticated = false;
      this.lastSentPresenceView = null;
      this.socket?.send(JSON.stringify({
        type: 'auth',
        roomId: this.roomId,
        accessToken: this.accessToken,
        deviceId: this.deviceId,
        ...(this.capabilities ? { capabilities: this.capabilities } : {}),
        afterSeq: this.afterSeq(),
        afterReceiptSeq: this.afterReceiptSeq(),
      }));
    });
    this.socket.addEventListener('message', (event) => this.handleFrame(String(event.data)));
    this.socket.addEventListener('close', () => {
      this.stopHeartbeat();
      this.authenticated = false;
      this.lastSentPresenceView = null;
      this.socket = null;
      this.handlers.connection('disconnected');
      if (!this.closed) this.scheduleReconnect();
    });
    this.socket.addEventListener('error', () => this.socket?.close());
  }

  private handleFrame(raw: string): void {
    try {
      const frame = JSON.parse(raw) as Record<string, unknown>;
      if (frame.type === 'ready') {
        this.retry = 0;
        this.startHeartbeat();
        this.authenticated = true;
        this.handlers.connection('connected');
        this.flushChatPresence();
        this.queueMembershipUpdate(() => this.handlers.ready(frame.state as RoomState));
      } else if (frame.type === 'membership') {
        this.queueMembershipUpdate(() => this.handlers.membership(frame.state as RoomState));
      } else if (frame.type === 'presence') {
        if (!isRoomPresence(frame.roles)) throw new Error('Invalid presence frame');
        const rawLastSeen = frame.lastSeen as Record<string, unknown> | undefined;
        const timestamp = (role: string) => {
          const value = rawLastSeen?.[role];
          return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= Date.now() + 60_000 ? value : null;
        };
        this.handlers.presence(frame.roles, { creator: timestamp('creator'), joiner: timestamp('joiner') });
      } else if (frame.type === 'message') {
        this.runAfterMembershipUpdate(() => this.handlers.message(frame as unknown as ServerMessage & { type: string }));
      } else if (frame.type === 'sync') {
        this.runAfterMembershipUpdate(() => this.handlers.sync((frame.messages ?? []) as ServerMessage[]));
      } else if (frame.type === 'receipt') {
        this.runAfterMembershipUpdate(() => this.handlers.receipt(frame as unknown as ServerReceipt));
      } else if (frame.type === 'receiptSync') {
        this.runAfterMembershipUpdate(() => this.handlers.receiptSync((frame.receipts ?? []) as ServerReceipt[]));
      } else if (frame.type === 'ack') {
        this.handlers.ack(String(frame.clientMsgId), Number(frame.seq));
      } else if (frame.type === 'receiptAck') {
        this.handlers.receiptAck(String(frame.clientMsgId), Number(frame.receiptSeq));
      } else if (frame.type === 'pong') {
        this.lastPongAt = Date.now();
      } else if (frame.type === 'error') {
        this.runAfterMembershipUpdate(() => this.handlers.error(
          String(frame.message ?? '实时连接发生错误'),
          String(frame.code ?? 'SOCKET_ERROR'),
          typeof frame.clientMsgId === 'string' ? frame.clientMsgId : undefined,
        ));
      }
    } catch {
      this.runAfterMembershipUpdate(() => this.handlers.error('收到无法识别的实时数据', 'INVALID_SERVER_FRAME'));
    }
  }

  private queueMembershipUpdate(operation: () => AsyncSocketHandler): void {
    this.membershipBarrier = this.membershipBarrier
      .then(
        () => operation(),
        (cause) => {
          this.reportHandlerFailure(cause);
          return operation();
        },
      )
      .catch((cause) => {
        this.reportHandlerFailure(cause);
      });
  }

  private runAfterMembershipUpdate(operation: () => AsyncSocketHandler): void {
    void this.membershipBarrier.then(operation).catch((cause) => this.reportHandlerFailure(cause));
  }

  private reportHandlerFailure(cause: unknown): void {
    const message = cause instanceof Error && cause.message
      ? cause.message
      : '会话成员状态处理失败';
    this.handlers.error(message, 'INVALID_CLIENT_STATE');
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const delay = Math.min(1000 * 2 ** this.retry, 15000);
    this.retry += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  setChatPresence(inChat: boolean): void {
    this.desiredPresenceView = inChat ? 'chat' : 'away';
    this.flushChatPresence();
  }

  private flushChatPresence(): void {
    if (
      !this.authenticated ||
      this.socket?.readyState !== WebSocket.OPEN ||
      this.lastSentPresenceView === this.desiredPresenceView
    ) return;
    this.socket.send(JSON.stringify({ type: 'presence', view: this.desiredPresenceView }));
    this.lastSentPresenceView = this.desiredPresenceView;
  }

  sendEnvelope(envelope: MessageEnvelope, countUnread = true): void {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('实时连接尚未恢复');
    this.socket.send(JSON.stringify({ type: 'send', envelope, countUnread }));
  }

  sendReceipt(receipt: DeliveryReceipt): void {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('实时连接尚未恢复');
    this.socket.send(JSON.stringify({ type: 'receipt', receipt }));
  }

  requestSync(afterSeq: number): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'sync', afterSeq }));
    }
  }

  requestReceiptSync(afterReceiptSeq: number): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'receiptSync', afterReceiptSeq }));
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastPongAt = Date.now();
    this.heartbeatTimer = window.setInterval(() => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastPongAt > 45_000) {
        this.socket.close(4000, 'Heartbeat timeout');
        return;
      }
      this.socket.send(JSON.stringify({ type: 'ping', at: Date.now() }));
    }, 15_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) window.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  close(): void {
    this.desiredPresenceView = 'away';
    this.flushChatPresence();
    this.closed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, 'Locked');
  }
}
