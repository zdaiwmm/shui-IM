import { createServer as createHttpServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { createStore } from './storage.mjs';
import { createAdminConsole } from './admin.mjs';
import { createExpressionCatalog } from './expression-catalog.mjs';
import { callIceConfiguration, createCallService } from './calls.mjs';
import { createPushService, validatePushAuthorization, validatePushSubscription } from './push.mjs';
import {
  canonicalStringify,
  isUuid,
  mlsPrivateMessageEpoch,
  mlsPublicMessageEpoch,
  validateEnvelopeShape,
  validateMlsMembershipShape,
  validateMlsWelcomeShape,
  validatePublicBundle,
  validateReceiptShape,
  validateRecoveryRequestShape,
  verifyEnvelopeSignature,
  verifyReceiptSignature,
} from './protocol.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(MODULE_DIR, '..');
const MAX_JSON_BYTES = 640 * 1024;
const MAX_CHUNK_BYTES = 2 * 1024 * 1024 + 16;
const MAX_IMAGE_BYTES = 256 * 1024 * 1024 + 2048;
const ID_PATTERN = '[0-9a-fA-F-]{36}';

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.woff2', 'font/woff2'],
]);

function applySecurityHeaders(request, response) {
  const hostHeader = typeof request.headers.host === 'string' && /^[A-Za-z0-9.:[\]-]+$/.test(request.headers.host)
    ? request.headers.host
    : null;
  const socketSources = hostHeader ? ` ws://${hostHeader} wss://${hostHeader}` : '';
  response.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "object-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    `connect-src 'self'${socketSources}`,
    "worker-src 'self'",
    "manifest-src 'self'",
  ].join('; '));
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=(), usb=()');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
}

function json(request, response, status, body) {
  applySecurityHeaders(request, response);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readBody(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request) {
  const raw = await readBody(request, MAX_JSON_BYTES);
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('INVALID_JSON');
  }
}

function bearerToken(request) {
  const value = request.headers.authorization;
  if (!value?.startsWith('Bearer ')) return null;
  return value.slice(7);
}

function normalizeError(error) {
  const code = error instanceof Error ? error.message : 'INTERNAL_ERROR';
  const known = new Map([
    ['CALL_CONFIG_INVALID', [503, '通话网络配置暂不可用']],
    ['BODY_TOO_LARGE', [413, '上传内容过大']],
    ['INVALID_JSON', [400, '请求格式不正确']],
    ['ROOM_NOT_FOUND', [404, '会话不存在']],
    ['ROOM_SEALED', [409, '会话已经绑定两台设备']],
    ['INVALID_BLOB', [404, '图片数据不存在或尚未完成']],
    ['CHUNK_CONFLICT', [409, '图片分块与已上传内容冲突']],
    ['BLOB_CONFLICT', [409, '图片续传参数与原上传不一致']],
    ['BLOB_INCOMPLETE', [409, '图片分块尚未完整上传']],
    ['BLOB_SIZE_MISMATCH', [409, '图片分块总大小不正确']],
    ['BLOB_QUOTA', [413, '图片超过 256 MB 限制']],
    ['STORAGE_QUOTA', [507, '会话存储配额已用尽']],
    ['TOO_MANY_UPLOADS', [429, '未完成的图片上传过多，请先续传或等待清理']],
    ['INVALID_RECEIPT', [400, '送达回执与消息不匹配']],
    ['RECEIPT_CONFLICT', [409, '送达回执与已记录内容冲突']],
    ['MESSAGE_CONFLICT', [409, '消息标识与已记录消息冲突']],
    ['MESSAGE_QUOTA', [507, '会话消息存储配额已用尽']],
    ['MLS_WELCOME_CONFLICT', [409, 'MLS 会话欢迎消息与已保存内容冲突']],
    ['PROTOCOL_MISMATCH', [409, '加入设备不支持该会话的加密协议']],
    ['INVALID_DEVICE_TOKEN', [400, '设备访问凭证格式不正确']],
    ['INVALID_UNREAD_OBSERVER', [400, '未读计数请求格式不正确']],
    ['INVALID_DEVICE_LINK', [400, '设备链接无效或已经过期']],
    ['DEVICE_LINK_CLAIMED', [409, '设备链接已经被另一台设备使用']],
    ['DEVICE_LIMIT', [409, '每位参与者最多使用三台设备']],
    ['MLS_EVENT_CONFLICT', [409, 'MLS 设备变更与已记录内容冲突']],
    ['MLS_EVENT_STALE', [409, 'MLS 设备状态已更新，请刷新后重试']],
    ['MLS_EPOCH_STALE', [409, '加密设备状态已更新，消息正在使用新密钥重新加密']],
    ['INVALID_MLS_EVENT', [400, 'MLS 设备变更与待处理设备不匹配']],
    ['LAST_ROLE_DEVICE', [409, '不能移除该参与者的最后一台设备']],
    ['INVALID_RECOVERY_REQUEST', [400, '恢复请求无效，或原设备已被替换']],
    ['UNAUTHORIZED', [401, '设备凭证无效或已停用']],
    ['RECOVERY_ALREADY_PENDING', [409, '该设备已有恢复请求，请完成或等待过期后重试']],
    ['RECOVERY_REQUIRES_UPGRADE', [409, '请先让其它已授权设备打开最新版，再重试恢复']],
    ['RECOVERY_EXPIRED', [410, '恢复请求已过期，请重新输入恢复码获取备份']],
  ]);
  const [status, message] = known.get(code) ?? [500, '服务器暂时无法处理请求'];
  return [status, message, code];
}

function publicState(state) {
  return {
    roomId: state.roomId,
    nextSeq: state.nextSeq,
    nextReceiptSeq: state.nextReceiptSeq,
    sealedAt: state.sealedAt,
    protocol: state.protocol,
    members: state.members,
    mlsWelcome: state.mlsWelcome,
    nextMlsEventSeq: state.nextMlsEventSeq,
    mlsEvents: state.mlsEvents,
    recoveryRequests: state.recoveryRequests,
  };
}

function validCapabilities(capabilities) {
  return Array.isArray(capabilities) && capabilities.length <= 16 &&
    capabilities.every((value) => typeof value === 'string' && /^[a-z0-9-]{1,40}$/.test(value));
}

function validDeviceMetadata(name, capabilities) {
  return typeof name === 'string' && name.trim().length >= 1 && name.trim().length <= 40 &&
    validCapabilities(capabilities);
}

function validPresenceFrame(message) {
  return Boolean(
    message &&
    typeof message === 'object' &&
    !Array.isArray(message) &&
    Object.keys(message).length === 2 &&
    message.type === 'presence' &&
    (message.view === 'chat' || message.view === 'away'),
  );
}

function callIdentityMatchesDevice(proof, roomId, device) {
  if (!proof || typeof proof !== 'object' || Array.isArray(proof) ||
      JSON.stringify(Object.keys(proof).sort()) !== JSON.stringify(['deviceId', 'protocol', 'publicBundle', 'role', 'roomId', 'signature']) ||
      JSON.stringify(proof).length > 96 * 1024 ||
      proof.protocol !== 'quiet-room-call-identity-v1' || proof.roomId !== roomId || !isUuid(proof.roomId) ||
      proof.deviceId !== device.deviceId || !isUuid(proof.deviceId) ||
      !['creator', 'joiner'].includes(proof.role) || proof.role !== device.role ||
      !validatePublicBundle(proof.publicBundle) ||
      typeof proof.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(proof.signature)) return false;
  const signature = Buffer.from(proof.signature, 'base64url');
  if (signature.length !== 64 || signature.toString('base64url') !== proof.signature) return false;
  const expectedBundle = {
    deviceId: device.deviceId,
    encryptionKey: device.encryptionKey,
    signingKey: device.signingKey,
    ...(device.mlsKeyPackage ? { mlsKeyPackage: device.mlsKeyPackage } : {}),
  };
  return canonicalStringify(proof.publicBundle) === canonicalStringify(expectedBundle);
}

export async function startServer(options = {}) {
  const port = Number(options.port ?? process.env.PORT ?? 8787);
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';
  const dataDir = path.resolve(options.dataDir ?? process.env.DATA_DIR ?? path.join(PROJECT_DIR, 'data'));
  const staticDir = path.resolve(options.staticDir ?? path.join(PROJECT_DIR, 'dist'));
  const numericOption = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
  const store = await createStore({
    dataDir,
    maxBlobBytes: numericOption(options.maxBlobBytes ?? process.env.MAX_BLOB_BYTES, MAX_IMAGE_BYTES),
    maxRoomStorageBytes: numericOption(options.maxRoomStorageBytes ?? process.env.MAX_ROOM_STORAGE_BYTES, 1024 * 1024 * 1024),
    maxTotalStorageBytes: numericOption(options.maxTotalStorageBytes ?? process.env.MAX_TOTAL_STORAGE_BYTES, 10 * 1024 * 1024 * 1024),
    maxIncompleteBlobsPerRoom: numericOption(options.maxIncompleteBlobsPerRoom ?? process.env.MAX_INCOMPLETE_BLOBS, 4),
    maxMessagesPerRoom: numericOption(options.maxMessagesPerRoom ?? process.env.MAX_MESSAGES_PER_ROOM, 100_000),
    maxRoomMessageBytes: numericOption(options.maxRoomMessageBytes ?? process.env.MAX_ROOM_MESSAGE_BYTES, 512 * 1024 * 1024),
  });
  const pushService = options.pushService ?? createPushService({
    publicKey: options.vapidPublicKey,
    privateKey: options.vapidPrivateKey,
    subject: options.vapidSubject,
  });
  const clientsByRoom = new Map();
  const socketSessions = new WeakMap();
  const rateLimits = new Map();
  const incompleteBlobTtlMs = numericOption(options.incompleteBlobTtlMs ?? process.env.INCOMPLETE_BLOB_TTL_MS, 24 * 60 * 60 * 1000);
  const orphanRoomTtlMs = numericOption(options.orphanRoomTtlMs ?? process.env.ORPHAN_ROOM_TTL_MS, 24 * 60 * 60 * 1000);
  const maxConnectionsPerRoom = numericOption(options.maxConnectionsPerRoom ?? process.env.MAX_CONNECTIONS_PER_ROOM, 8);
  const maxConnectionsTotal = numericOption(options.maxConnectionsTotal ?? process.env.MAX_CONNECTIONS_TOTAL, 1000);
  const webSocketHeartbeatMs = numericOption(options.webSocketHeartbeatMs ?? process.env.WEBSOCKET_HEARTBEAT_MS, 30_000);
  const trustedProxyAddresses = new Set(
    String(options.trustedProxyAddresses ?? process.env.TRUSTED_PROXY_ADDRESSES ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );

  function requireActiveDevice(request, roomId, deviceId) {
    const device = store.authenticatedDevice(roomId, bearerToken(request), deviceId);
    if (!device) throw new Error('UNAUTHORIZED');
    return device;
  }

  function callIdentitiesForRoom(roomId) {
    const identities = new Map();
    for (const socket of clientsByRoom.get(roomId) ?? []) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const session = socketSessions.get(socket);
      if (!session?.callIdentity) continue;
      const member = store.getMember(roomId, session.deviceId);
      if (member?.status !== 'active' || store.deviceRecoveryPending(roomId, session.deviceId) ||
          !callIdentityMatchesDevice(session.callIdentity, roomId, member)) continue;
      // One immutable attestation per active device, even with multiple tabs.
      identities.set(member.deviceId, session.callIdentity);
    }
    return [...identities.values()].slice(0, 6);
  }

  function clientAddress(request) {
    const socketAddress = request.socket.remoteAddress ?? 'unknown';
    if (!trustedProxyAddresses.has(socketAddress)) return socketAddress;
    const forwarded = request.headers['x-forwarded-for'];
    const firstForwarded = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
    return firstForwarded?.trim() || socketAddress;
  }

  function allowRequest(request, bucket, limit, windowMs = 60_000) {
    const now = Date.now();
    if (rateLimits.size > 10_000) {
      for (const [storedKey, stored] of rateLimits) {
        if (stored.resetAt <= now) rateLimits.delete(storedKey);
      }
      while (rateLimits.size > 9_000) {
        const oldestKey = rateLimits.keys().next().value;
        if (oldestKey === undefined) break;
        rateLimits.delete(oldestKey);
      }
    }
    const key = `${clientAddress(request)}:${bucket}`;
    const current = rateLimits.get(key);
    if (!current || current.resetAt <= now) {
      rateLimits.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    current.count += 1;
    return current.count <= limit;
  }

  function send(socket, value) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
  }

  const callService = createCallService({
    store, clientsByRoom, socketSessions, send, isOpen: (socket) => socket.readyState === WebSocket.OPEN,
  });

  function broadcast(roomId, value, project = null) {
    if (value.type === 'membership') callService.sweep();
    for (const socket of clientsByRoom.get(roomId) ?? []) {
      const session = socketSessions.get(socket);
      const member = session ? store.getMember(roomId, session.deviceId) : null;
      if (!session || member?.status !== 'active' || store.deviceRecoveryPending(roomId, session.deviceId)) {
        socket.close(4403, 'Device no longer active');
        continue;
      }
      send(socket, project ? project(member) : value);
    }
  }

  function presenceForRoom(roomId) {
    const roles = { creator: false, joiner: false };
    for (const socket of clientsByRoom.get(roomId) ?? []) {
      const session = socketSessions.get(socket);
      if (!session || session.view !== 'chat' || socket.readyState !== WebSocket.OPEN) continue;
      const member = store.getMember(roomId, session.deviceId);
      if (member?.status === 'active' && member.role === session.role && !store.deviceRecoveryPending(roomId, session.deviceId)) roles[session.role] = true;
    }
    return roles;
  }

  // Only the latest transition per role is kept in process memory. Restarting
  // the service intentionally clears this behavioral metadata.
  const presenceHistory = new Map();
  function presenceFrame(roomId) {
    const roles = presenceForRoom(roomId);
    const previous = presenceHistory.get(roomId);
    const lastSeen = { ...(previous?.lastSeen ?? { creator: null, joiner: null }) };
    for (const role of ['creator', 'joiner']) {
      if (previous?.roles[role] && !roles[role]) lastSeen[role] = Date.now();
    }
    presenceHistory.set(roomId, { roles, lastSeen });
    if (presenceHistory.size > 10_000) presenceHistory.delete(presenceHistory.keys().next().value);
    return { type: 'presence', roles, lastSeen };
  }

  function broadcastPresence(roomId) {
    broadcast(roomId, presenceFrame(roomId));
  }

  function registerSocket(session, socket) {
    const clients = clientsByRoom.get(session.roomId) ?? new Set();
    clients.add(socket);
    socketSessions.set(socket, session);
    clientsByRoom.set(session.roomId, clients);
    socket.once('close', (code, reason) => {
      callService.disconnect(socket, code, reason.toString());
      delete session.callIdentity;
      clients.delete(socket);
      if (clients.size === 0) clientsByRoom.delete(session.roomId);
      broadcastPresence(session.roomId);
    });
  }

  async function notifyOtherDevices(roomId, senderId) {
    if (!pushService.enabled) return;
    const subscriptions = store.pushSubscriptionsForRoom(roomId, senderId);
    await Promise.allSettled(subscriptions.map(async (subscription) => {
      const result = await pushService.wake(subscription);
      if (result.expired) store.deletePushSubscriptionByEndpoint(subscription.endpoint);
      else if (!result.delivered && !result.disabled) console.error('Background wake-up failed:', result.statusCode || 'unknown');
    }));
  }

  const adminOrigin = options.adminOrigin ?? process.env.ADMIN_ORIGIN ?? 'https://admin.mijiu.cloud';
  const memes = createExpressionCatalog({ dataDir });
  const admin = await createAdminConsole({ config: options.adminConfig, configFile: options.adminConfigFile ?? process.env.ADMIN_CONFIG_FILE,
    origin: adminOrigin, data: store.cloudBackups, expressions: memes, json, readJson,
    readExpressionJson: async request => JSON.parse((await readBody(request, 70 * 1024 * 1024)).toString('utf8')),
    headers: applySecurityHeaders, staticDir,
    onDelete: async roomId => {
      for (const socket of clientsByRoom.get(roomId) ?? []) socket.close(4403, 'Room removed');
      callService.sweep();
      presenceHistory.delete(roomId);
      await store.cleanupDeletedRooms();
    } });
  await store.cleanupDeletedRooms();

  const httpServer = createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const pathname = decodeURIComponent(url.pathname);
      if (await admin(request, response, pathname)) return;

      const memeMatch = pathname.match(new RegExp(`^/api/rooms/(${ID_PATTERN})/memes/(search|media|pack)$`));
      if (request.method === 'POST' && memeMatch) {
        const device = requireActiveDevice(request, memeMatch[1]);
        const media = memeMatch[2] === 'media';
        if (!allowRequest(request, media ? 'meme-media' : 'meme-search', media ? 240 : 30)) {
          json(request, response, 429, { error: '请求过于频繁，请稍后再试' }); return;
        }
        const controller = new AbortController();
        response.once('close', () => controller.abort());
        try {
          const body = JSON.parse((await readBody(request, 2048)).toString('utf8'));
          const owner = `${memeMatch[1]}:${device.deviceId}`;
          if (media) {
            const result = await memes.media(owner, body?.id, controller.signal);
            requireActiveDevice(request, memeMatch[1], device.deviceId);
            applySecurityHeaders(request, response);
            response.writeHead(200, { 'Content-Type': result.type, 'Content-Length': result.bytes.length, 'Cache-Control': 'no-store' });
            response.end(result.bytes);
          } else {
            const result = memeMatch[2] === 'pack' ? await memes.pack(owner, body?.id, controller.signal) : await memes.search(owner, body, controller.signal);
            requireActiveDevice(request, memeMatch[1], device.deviceId);
            json(request, response, 200, result);
          }
        } catch (error) {
          if (controller.signal.aborted) return;
          const code = error instanceof Error ? error.message : '';
          const invalid = error instanceof SyntaxError || ['MEME_INVALID_QUERY', 'BODY_TOO_LARGE'].includes(code);
          json(request, response, invalid ? 400 : code === 'MEME_NOT_FOUND' ? 404 : code === 'UNAUTHORIZED' ? 401 : 502,
            { error: invalid ? '搜索条件不正确' : code === 'MEME_NOT_FOUND' ? '图片已过期，请重新搜索' : '网络梗图暂时不可用，请稍后重试' });
        }
        return;
      }

      const backupWrite = pathname.match(new RegExp(`^/api/rooms/(${ID_PATTERN})/backup$`));
      const archiveWrite = pathname.match(new RegExp(`^/api/rooms/(${ID_PATTERN})/archives/([A-Za-z0-9_-]{43})/([A-Za-z0-9_-]{43})$`));
      const backupRead = pathname.match(/^\/api\/recovery-backups\/([A-Za-z0-9_-]{22})$/);
      const archiveRead = pathname.match(/^\/api\/history-archives\/([A-Za-z0-9_-]{43})\/([A-Za-z0-9_-]{43})$/);
      if ((request.method === 'PUT' && (backupWrite || archiveWrite)) || (request.method === 'GET' && (backupRead || archiveRead))) {
        if (!allowRequest(request, 'cloud-backups', 120)) { json(request, response, 429, { error: '备份请求过于频繁', code: 'RATE_LIMITED' }); return; }
        try {
          const token = bearerToken(request);
          let result;
          if (backupWrite || archiveWrite) {
            const roomId = (backupWrite ?? archiveWrite)[1];
            requireActiveDevice(request, roomId);
            const body = JSON.parse((await readBody(request, 2 * 1024 * 1024)).toString('utf8'));
            result = backupWrite ? store.cloudBackups.save(roomId, token, body)
              : store.cloudBackups.putPart(roomId, token, archiveWrite[2], archiveWrite[3], body);
          } else result = backupRead ? store.cloudBackups.fetch(backupRead[1], token)
            : store.cloudBackups.getPart(archiveRead[1], archiveRead[2], token);
          json(request, response, 200, result);
        } catch (error) {
          const code = error instanceof Error ? error.message : '';
          if (/^(INVALID_BACKUP|BACKUP_|UNAUTHORIZED)/.test(code) || error instanceof SyntaxError) {
            const status = code === 'BACKUP_UNAVAILABLE' || code === 'UNAUTHORIZED' ? 401 : code.includes('CONFLICT') ? 409 : code === 'BACKUP_QUOTA' ? 413 : 400;
            json(request, response, status, { error: status === 401 ? '备份不存在、已停用或凭据不正确' : '备份保存失败，请重试', code });
          } else throw error;
        }
        return;
      }

      if (request.method === 'GET' && pathname === '/api/health') {
        const health = await store.healthCheck();
        json(request, response, health.ok ? 200 : 503, health);
        return;
      }

      if (request.method === 'GET' && pathname === '/api/push/public-key') {
        json(request, response, 200, { enabled: pushService.enabled, publicKey: pushService.publicKey });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/rooms') {
        if (!allowRequest(request, 'create-room', 20)) {
          response.setHeader('Retry-After', '60');
          json(request, response, 429, { error: '请求过于频繁', code: 'RATE_LIMITED' });
          return;
        }
        const body = await readJson(request);
        if (
          !validatePublicBundle(body.creatorBundle) ||
          typeof body.accessToken !== 'string' ||
          body.accessToken.length < 32 ||
          body.accessToken.length > 512 ||
          (body.inviteToken !== undefined && (typeof body.inviteToken !== 'string' || body.inviteToken.length < 32 || body.inviteToken.length > 512)) ||
          ((body.deviceName !== undefined || body.capabilities !== undefined) &&
            !validDeviceMetadata(body.deviceName ?? '此设备', body.capabilities ?? []))
        ) {
          json(request, response, 400, { error: 'INVALID_ROOM_REQUEST' });
          return;
        }
        const room = store.createRoom(
          body.creatorBundle,
          body.accessToken,
          body.inviteToken ?? body.accessToken,
          body.deviceName ?? '此设备',
          body.capabilities ?? [],
        );
        json(request, response, 201, room);
        return;
      }

      const roomMatch = pathname.match(new RegExp(`^/api/rooms/(${ID_PATTERN})$`));
      if (request.method === 'DELETE' && roomMatch) {
        const roomId = roomMatch[1];
        if (!isUuid(roomId)) {
          json(request, response, 400, { error: 'INVALID_ROOM_ID' });
          return;
        }
        json(request, response, 200, store.deleteRoom(roomId, bearerToken(request)));
        return;
      }
      if (request.method === 'GET' && roomMatch) {
        const roomId = roomMatch[1];
        const token = bearerToken(request);
        const state = isUuid(roomId) ? store.roomState(roomId) : null;
        const authorized = state && (
          store.authenticatedDevice(roomId, token) ||
          (!state.sealedAt && store.authenticateInvite(roomId, token))
        );
        if (!authorized) {
          json(request, response, 401, { error: 'UNAUTHORIZED' });
          return;
        }
        json(request, response, 200, publicState(state));
        return;
      }

      const joinMatch = pathname.match(new RegExp(`^/api/rooms/(${ID_PATTERN})/join$`));
      if (request.method === 'POST' && joinMatch) {
        const roomId = joinMatch[1];
        if (!isUuid(roomId) || !store.authenticateInvite(roomId, bearerToken(request))) {
          json(request, response, 401, { error: 'UNAUTHORIZED' });
          return;
        }
        if (!allowRequest(request, `join:${roomId}`, 30)) {
          response.setHeader('Retry-After', '60');
          json(request, response, 429, { error: '请求过于频繁', code: 'RATE_LIMITED' });
          return;
        }
        const body = await readJson(request);
        if (
          !validatePublicBundle(body.bundle) ||
          typeof body.proof !== 'string' || body.proof.length > 512 ||
          (body.deviceAccessToken !== undefined && (
            typeof body.deviceAccessToken !== 'string' || body.deviceAccessToken.length < 32 || body.deviceAccessToken.length > 512
          )) ||
          !validDeviceMetadata(body.deviceName ?? '此设备', body.capabilities ?? [])
        ) {
          json(request, response, 400, { error: 'INVALID_JOIN_REQUEST' });
          return;
        }
        const state = store.joinRoom(
          roomId,
          body.bundle,
          body.proof,
          body.deviceAccessToken,
          body.deviceName ?? '此设备',
          body.capabilities ?? [],
        );
        broadcast(roomId, { type: 'membership', state: publicState(state) });
        broadcastPresence(roomId);
        json(request, response, 201, publicState(state));
        return;
      }

      const callConfigMatch = pathname.match(new RegExp(`^/api/rooms/(${ID_PATTERN})/call-config$`));
      if (callConfigMatch && request.method === 'GET') {
        const roomId = callConfigMatch[1];
        requireActiveDevice(request, roomId);
        if (!allowRequest(request, `call-config:${roomId}`, 30)) {
          json(request, response, 429, { error: '通话请求过于频繁', code: 'RATE_LIMITED' });
          return;
        }
        json(request, response, 200, { ...callIceConfiguration(options), callIdentities: callIdentitiesForRoom(roomId) });
        return;
      }

      const deviceLinksMatch = pathname.match(new RegExp(`^/api/rooms/(${ID_PATTERN})/device-links$`));
      if (deviceLinksMatch && (request.method === 'GET' || request.method === 'POST')) {
        const roomId = deviceLinksMatch[1];
        const device = store.authenticatedDevice(roomId, bearerToken(request));
        if (!device) {
          json(request, response, 401, { error: 'UNAUTHORIZED' });
          return;
        }
        if (request.method === 'GET') {
          json(request, response, 200, {
            links: store.deviceLinksForRoom(roomId, device.deviceId),
            state: publicState(store.roomState(roomId)),
          });
          return;
        }
        if (!allowRequest(request, `device-link:${roomId}`, 12)) {
          response.setHeader('Retry-After', '60');
          json(request, response, 429, { error: '请求过于频繁', code: 'RATE_LIMITED' });
          return;
        }
        const body = await readJson(request);
        if (
          !isUuid(body.linkId) ||
          body.authorizerId !== device.deviceId ||
          typeof body.secret !== 'string' || body.secret.length < 32 || body.secret.length > 512 ||
          typeof body.expiresAt !== 'string'
        ) {
          json(request, response, 400, { error: 'INVALID_DEVICE_LINK' });
          return;
        }
        requireActiveDevice(request, roomId, device.deviceId);
        json(request, response, 201, store.createDeviceLink(
          roomId,
          device.deviceId,
          body.linkId,
          body.secret,
          body.expiresAt,
        ));
        return;
      }

      const claimDeviceLinkMatch = pathname.match(new RegExp(`^/api/device-links/(${ID_PATTERN})/claim$`));
      if (request.method === 'POST' && claimDeviceLinkMatch) {
        if (!allowRequest(request, `claim-device-link:${claimDeviceLinkMatch[1]}`, 20)) {
          response.setHeader('Retry-After', '60');
          json(request, response, 429, { error: '请求过于频繁', code: 'RATE_LIMITED' });
          return;
        }
        const body = await readJson(request);
        if (
          typeof body.secret !== 'string' || body.secret.length < 32 || body.secret.length > 512 ||
          !validatePublicBundle(body.bundle) ||
          !body.bundle.mlsKeyPackage ||
          typeof body.deviceAccessToken !== 'string' || body.deviceAccessToken.length < 32 || body.deviceAccessToken.length > 512 ||
          !validDeviceMetadata(body.deviceName, body.capabilities ?? [])
        ) {
          json(request, response, 400, { error: 'INVALID_DEVICE_LINK' });
          return;
        }
        const claimed = store.claimDeviceLink(
          claimDeviceLinkMatch[1],
          body.secret,
          body.bundle,
          body.deviceAccessToken,
          body.deviceName.trim(),
          body.capabilities ?? [],
        );
        broadcast(claimed.link.roomId, { type: 'membership', state: publicState(claimed.state) });
        broadcastPresence(claimed.link.roomId);
        json(request, response, 201, { link: claimed.link, state: publicState(claimed.state) });
        return;
      }

      const deviceLinkStatusMatch = pathname.match(new RegExp(`^/api/device-links/(${ID_PATTERN})/status$`));
      if (request.method === 'POST' && deviceLinkStatusMatch) {
        const body = await readJson(request);
        const result = store.deviceLinkStatus(deviceLinkStatusMatch[1], body.secret);
        if (
          result.link.usedAt &&
          (!result.link.claimedDeviceId || !store.authenticatedDevice(
            result.link.roomId,
            bearerToken(request),
            result.link.claimedDeviceId,
          ))
        ) {
          json(request, response, 401, { error: 'UNAUTHORIZED' });
          return;
        }
        json(request, response, 200, { link: result.link, state: publicState(result.state) });
        return;
      }

      const recoveryMatch = pathname.match(new RegExp(`^/api/rooms/(${ID_PATTERN})/recovery$`));
      if (recoveryMatch && request.method === 'POST') {
        const roomId = recoveryMatch[1];
        if (!allowRequest(request, 'recover-device', 10)) {
          json(request, response, 429, { error: '恢复请求过于频繁', code: 'RATE_LIMITED' });
          return;
        }
        const body = await readJson(request);
        const proof = body.request;
        const source = validateRecoveryRequestShape(proof, roomId) && store.getMember(roomId, proof.sourceDeviceId);
        if (!source || !validCapabilities(body.capabilities) || typeof body.deviceName !== 'string' ||
          !body.deviceName.trim() || body.deviceName.length > 80 || !(await verifyEnvelopeSignature(proof, source.signingKey))) {
          json(request, response, 400, { error: '恢复凭证验证失败', code: 'INVALID_RECOVERY_REQUEST' });
          return;
        }
        const state = store.createRecoveryRequest(roomId, proof, body.accessToken, body.deviceName.trim(), body.capabilities);
        callService.sweep();
        // Fence old sockets before broadcasting the pending replacement. Every
        // subsequent write is checked again at the durable store boundary.
        for (const socket of clientsByRoom.get(roomId) ?? []) {
          if (socketSessions.get(socket)?.deviceId === proof.sourceDeviceId) socket.terminate();
        }
        broadcast(roomId, { type: 'membership', state: publicState(state) });
        broadcastPresence(roomId);
        json(request, response, 200, { state: publicState(state) });
        return;
      }
      const recoveryStatusMatch = pathname.match(new RegExp(`^/api/rooms/(${ID_PATTERN})/recovery/(${ID_PATTERN})$`));
      if (recoveryStatusMatch && request.method === 'GET') {
        const [, roomId, requestId] = recoveryStatusMatch;
        json(request, response, 200, { state: publicState(store.recoveryStatus(roomId, requestId, bearerToken(request))) });
        return;
      }

      const mlsEventsMatch = pathname.match(new RegExp(`^/api/rooms/(${ID_PATTERN})/mls-events$`));
      if (mlsEventsMatch && request.method === 'PUT') {
        const roomId = mlsEventsMatch[1];
        const device = store.authenticatedDevice(roomId, bearerToken(request));
        if (!device) {
          json(request, response, 401, { error: 'UNAUTHORIZED' });
          return;
        }
        const body = await readJson(request);
        const envelope = body.event;
        if (
          !validateMlsMembershipShape(envelope, roomId) ||
          envelope.senderId !== device.deviceId ||
          !(await verifyEnvelopeSignature(envelope, device.signingKey)) ||
          mlsPublicMessageEpoch(envelope.commit) !== envelope.previousEventSeq + 1
        ) {
          json(request, response, 400, { error: 'INVALID_MLS_EVENT' });
          return;
        }
        requireActiveDevice(request, roomId, device.deviceId);
        const storedEvent = store.saveMlsEvent(roomId, envelope);
        const state = publicState(store.roomState(roomId));
        if (!storedEvent.duplicate) {
          broadcast(roomId, { type: 'membership', state });
          broadcastPresence(roomId);
        }
        json(request, response, 200, { event: storedEvent, state });
        return;
      }

      const unreadMatch = pathname.match(new RegExp(`^/api/rooms/(${ID_PATTERN})/unread/(${ID_PATTERN})$`));
      if (unreadMatch && (request.method === 'GET' || request.method === 'POST')) {
        const [, roomId, deviceId] = unreadMatch;
        if (!allowRequest(request, `unread:${request.method}:${roomId}:${deviceId}`, 240)) {
          response.setHeader('Retry-After', '60');
          json(request, response, 429, { error: '请求过于频繁', code: 'RATE_LIMITED' });
          return;
        }
        if (request.method === 'GET') {
          // This route deliberately does not accept a normal device credential.
          json(request, response, 200, store.unreadCount(roomId, deviceId, bearerToken(request)));
          return;
        }
        requireActiveDevice(request, roomId, deviceId);
        const body = await readJson(request);
        if (!body || typeof body !== 'object' || Array.isArray(body) ||
          Object.keys(body).some((key) => key !== 'token' && key !== 'readSeq') ||
          (body.token === undefined && body.readSeq === undefined)) throw new Error('INVALID_UNREAD_OBSERVER');
        // Recheck after reading a potentially slow body: recovery can revoke
        // the device while the request is still arriving.
        requireActiveDevice(request, roomId, deviceId);
        json(request, response, 200, store.saveUnreadObserver(roomId, deviceId, body));
        return;
      }

      const pushMatch = pathname.match(new RegExp(`^/api/rooms/(${ID_PATTERN})/push/(${ID_PATTERN})$`));
      if (pushMatch && (request.method === 'PUT' || request.method === 'DELETE')) {
        const [, roomId, deviceId] = pushMatch;
        if (!store.authenticatedDevice(roomId, bearerToken(request), deviceId)) {
          json(request, response, 401, { error: 'UNAUTHORIZED' });
          return;
        }
        const member = store.getMember(roomId, deviceId);
        if (!member) {
          json(request, response, 404, { error: 'MEMBER_NOT_FOUND' });
          return;
        }
        const body = await readJson(request);
        if (request.method === 'DELETE') {
          const endpoint = typeof body.authorization?.endpoint === 'string' ? body.authorization.endpoint : '';
          if (
            !validatePushAuthorization(body.authorization, roomId, deviceId, 'unsubscribe', endpoint) ||
            !(await verifyEnvelopeSignature(body.authorization, member.signingKey))
          ) {
            json(request, response, 400, { error: 'INVALID_PUSH_AUTHORIZATION' });
            return;
          }
          requireActiveDevice(request, roomId, deviceId);
          store.deletePushSubscription(roomId, deviceId);
          json(request, response, 200, { removed: true });
          return;
        }
        if (!pushService.enabled) {
          json(request, response, 503, { error: '后台通知尚未配置', code: 'PUSH_UNAVAILABLE' });
          return;
        }
        if (!allowRequest(request, `push:${roomId}`, 12)) {
          response.setHeader('Retry-After', '60');
          json(request, response, 429, { error: '请求过于频繁', code: 'RATE_LIMITED' });
          return;
        }
        if (
          !validatePushSubscription(body.subscription, { allowedHosts: pushService.allowedHosts }) ||
          !validatePushAuthorization(
            body.authorization,
            roomId,
            deviceId,
            'subscribe',
            body.subscription?.endpoint,
          ) ||
          !(await verifyEnvelopeSignature(body.authorization, member.signingKey))
        ) {
          json(request, response, 400, { error: 'INVALID_PUSH_SUBSCRIPTION' });
          return;
        }
        requireActiveDevice(request, roomId, deviceId);
        json(request, response, 200, store.savePushSubscription(roomId, deviceId, body.subscription));
        return;
      }

      const mlsWelcomeMatch = pathname.match(new RegExp(`^/api/rooms/(${ID_PATTERN})/mls-welcome$`));
      if (request.method === 'PUT' && mlsWelcomeMatch) {
        const roomId = mlsWelcomeMatch[1];
        const authenticated = store.authenticatedDevice(roomId, bearerToken(request));
        if (!authenticated) {
          json(request, response, 401, { error: 'UNAUTHORIZED' });
          return;
        }
        const body = await readJson(request);
        const envelope = body.welcome;
        if (store.roomState(roomId)?.protocol !== 'mls-rfc9420') {
          json(request, response, 409, { error: 'PROTOCOL_MISMATCH' });
          return;
        }
        const sender = validateMlsWelcomeShape(envelope, roomId) && store.getMember(roomId, envelope.senderId);
        const recipient = validateMlsWelcomeShape(envelope, roomId) && store.getMember(roomId, envelope.recipientId);
        if (
          !sender || sender.role !== 'creator' ||
          sender.deviceId !== authenticated.deviceId ||
          !recipient || recipient.role !== 'joiner' ||
          !(await verifyEnvelopeSignature(envelope, sender.signingKey))
        ) {
          json(request, response, 400, { error: 'INVALID_MLS_WELCOME' });
          return;
        }
        requireActiveDevice(request, roomId, authenticated.deviceId);
        const state = store.saveMlsWelcome(roomId, envelope);
        broadcast(roomId, { type: 'membership', state: publicState(state) });
        broadcastPresence(roomId);
        json(request, response, 200, publicState(state));
        return;
      }

      const reserveBlobMatch = pathname.match(new RegExp(`^/api/rooms/(${ID_PATTERN})/blobs$`));
      if (request.method === 'POST' && reserveBlobMatch) {
        const roomId = reserveBlobMatch[1];
        if (!store.authenticatedDevice(roomId, bearerToken(request))) {
          json(request, response, 401, { error: 'UNAUTHORIZED' });
          return;
        }
        if (!allowRequest(request, `blob:${roomId}`, 30)) {
          response.setHeader('Retry-After', '60');
          json(request, response, 429, { error: '请求过于频繁', code: 'RATE_LIMITED' });
          return;
        }
        const body = await readJson(request);
        if (
          !isUuid(body.blobId) ||
          !Number.isInteger(body.chunkCount) ||
          body.chunkCount < 1 ||
          body.chunkCount > 128 ||
          !Number.isSafeInteger(body.encryptedSize) ||
          body.encryptedSize < 17 ||
          body.encryptedSize > MAX_IMAGE_BYTES
        ) {
          json(request, response, 400, { error: 'INVALID_BLOB_REQUEST' });
          return;
        }
        const actor = requireActiveDevice(request, roomId);
        const blob = store.createBlob(roomId, body.blobId, body.chunkCount, body.encryptedSize, actor.deviceId);
        json(request, response, 201, blob);
        return;
      }

      const blobStatusMatch = pathname.match(new RegExp(`^/api/rooms/(${ID_PATTERN})/blobs/(${ID_PATTERN})$`));
      if (request.method === 'GET' && blobStatusMatch) {
        const [, roomId, blobId] = blobStatusMatch;
        if (!store.authenticatedDevice(roomId, bearerToken(request))) {
          json(request, response, 401, { error: 'UNAUTHORIZED' });
          return;
        }
        json(request, response, 200, store.blobStatus(roomId, blobId));
        return;
      }

      const blobChunkMatch = pathname.match(new RegExp(`^/api/rooms/(${ID_PATTERN})/blobs/(${ID_PATTERN})/chunks/(\\d+)$`));
      if (blobChunkMatch && (request.method === 'PUT' || request.method === 'GET')) {
        const [, roomId, blobId, rawIndex] = blobChunkMatch;
        if (!store.authenticatedDevice(roomId, bearerToken(request))) {
          json(request, response, 401, { error: 'UNAUTHORIZED' });
          return;
        }
        const index = Number(rawIndex);
        if (!Number.isSafeInteger(index) || index < 0) {
          json(request, response, 400, { error: 'INVALID_CHUNK_INDEX' });
          return;
        }
        if (request.method === 'PUT') {
          if (!allowRequest(request, `chunk-write:${roomId}`, 600)) {
            response.setHeader('Retry-After', '60');
            json(request, response, 429, { error: '图片分块请求过于频繁', code: 'RATE_LIMITED' });
            return;
          }
          const bytes = await readBody(request, MAX_CHUNK_BYTES);
          const actor = requireActiveDevice(request, roomId);
          await store.putBlobChunk(roomId, blobId, index, bytes, actor.deviceId);
          json(request, response, 200, { stored: true, index });
        } else {
          const bytes = await store.getBlobChunk(roomId, blobId, index);
          requireActiveDevice(request, roomId);
          applySecurityHeaders(request, response);
          response.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': bytes.length,
            'Cache-Control': 'private, max-age=31536000, immutable',
          });
          response.end(bytes);
        }
        return;
      }

      const completeBlobMatch = pathname.match(new RegExp(`^/api/rooms/(${ID_PATTERN})/blobs/(${ID_PATTERN})/complete$`));
      if (request.method === 'POST' && completeBlobMatch) {
        const [, roomId, blobId] = completeBlobMatch;
        if (!store.authenticatedDevice(roomId, bearerToken(request))) {
          json(request, response, 401, { error: 'UNAUTHORIZED' });
          return;
        }
        const actor = requireActiveDevice(request, roomId);
        const completed = await store.completeBlob(roomId, blobId, actor.deviceId);
        json(request, response, 200, completed);
        return;
      }

      if (pathname.startsWith('/api/')) {
        json(request, response, 404, { error: 'NOT_FOUND' });
        return;
      }

      const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
      let target = path.resolve(staticDir, relative);
      if (!target.startsWith(`${staticDir}${path.sep}`) && target !== path.join(staticDir, 'index.html')) {
        json(request, response, 404, { error: 'NOT_FOUND' });
        return;
      }
      try {
        const info = await stat(target);
        if (info.isDirectory()) target = path.join(target, 'index.html');
      } catch {
        target = path.join(staticDir, 'index.html');
      }
      const bytes = await readFile(target);
      applySecurityHeaders(request, response);
      response.writeHead(200, {
        'Content-Type': MIME_TYPES.get(path.extname(target)) ?? 'application/octet-stream',
        'Cache-Control': ['index.html', 'sw.js', 'manifest.webmanifest'].includes(path.basename(target))
          ? 'no-cache'
          : 'public, max-age=31536000, immutable',
      });
      response.end(bytes);
    } catch (error) {
      const [status, message, code] = normalizeError(error);
      if (status === 500) console.error('Request failed:', error instanceof Error ? error.message : 'unknown');
      json(request, response, status, { error: message, code });
    }
  });

  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_JSON_BYTES });
  httpServer.on('upgrade', (request, socket, head) => {
    let url;
    try {
      url = new URL(request.url ?? '/', 'http://localhost');
    } catch {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const origin = request.headers.origin;
    const expectedHost = request.headers.host;
    const originAllowed = !origin || (() => {
      try {
        return new URL(origin).host === expectedHost;
      } catch {
        return false;
      }
    })();
    if (request.headers.host === new URL(adminOrigin).host || url.pathname !== '/ws' || !originAllowed || webSocketServer.clients.size >= maxConnectionsTotal) {
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (ws) => webSocketServer.emit('connection', ws, request));
  });

  webSocketServer.on('connection', (socket) => {
    let session = null;
    let processing = Promise.resolve();
    let frameWindowStartedAt = Date.now();
    let frameCount = 0;
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });
    const authTimeout = setTimeout(() => socket.close(4401, 'Authentication required'), 5000);

    socket.on('message', (raw) => {
      const now = Date.now();
      if (now - frameWindowStartedAt >= 60_000) {
        frameWindowStartedAt = now;
        frameCount = 0;
      }
      frameCount += 1;
      if (frameCount > 300) {
        socket.close(4429, 'Rate limit exceeded');
        return;
      }
      processing = processing.then(async () => {
        try {
          const message = JSON.parse(raw.toString());
          if (!session) {
            const hasValidCapabilities = message.type === 'auth' &&
              (message.capabilities === undefined || validCapabilities(message.capabilities));
            const device = message.type === 'auth' && isUuid(message.roomId) && isUuid(message.deviceId) && hasValidCapabilities
              ? store.authenticatedDevice(message.roomId, message.accessToken, message.deviceId)
              : null;
            if (!device) {
              socket.close(4401, 'Authentication failed');
              return;
            }
            if (message.callIdentity !== undefined) {
              if (!callIdentityMatchesDevice(message.callIdentity, message.roomId, device) ||
                  !(await verifyEnvelopeSignature(message.callIdentity, device.signingKey))) {
                socket.close(4401, 'Invalid call identity');
                return;
              }
              // Signature verification yields: a device may be revoked/replaced
              // or its transport closed before its attestation is registered.
              const current = store.authenticatedDevice(message.roomId, message.accessToken, message.deviceId);
              if (socket.readyState !== WebSocket.OPEN || !current ||
                  !callIdentityMatchesDevice(message.callIdentity, message.roomId, current)) {
                socket.close(4401, 'Authentication failed');
                return;
              }
            }
            clearTimeout(authTimeout);
            const offeredCapabilities = Array.isArray(message.capabilities) ? message.capabilities : null;
            const capabilitiesChanged = offeredCapabilities !== null &&
              JSON.stringify(device.capabilities ?? []) !== JSON.stringify([...new Set(offeredCapabilities)]);
            if (capabilitiesChanged) store.updateMemberCapabilities(message.roomId, device.deviceId, offeredCapabilities);
            session = { roomId: message.roomId, deviceId: device.deviceId, role: device.role, view: 'away',
              ...(message.callIdentity ? { callIdentity: message.callIdentity } : {}) };
            if ((clientsByRoom.get(session.roomId)?.size ?? 0) >= maxConnectionsPerRoom) {
              socket.close(4429, 'Room connection limit exceeded');
              return;
            }
            registerSocket(session, socket);
            // Keep an in-flight call alive across a short WebSocket transport
            // flap; the authenticated device identity is the rebind key.
            const state = store.roomState(session.roomId);
            send(socket, { type: 'ready', state: publicState(state) });
            callService.rebind(socket, session);
            send(socket, {
              type: 'sync',
              messages: store.messagesAfter(
                session.roomId,
                Number.isSafeInteger(message.afterSeq) && message.afterSeq >= 0 ? message.afterSeq : 0,
                500,
                session.deviceId,
              ),
            });
            send(socket, {
              type: 'receiptSync',
              receipts: store.receiptsAfter(
                session.roomId,
                Number.isSafeInteger(message.afterReceiptSeq) && message.afterReceiptSeq >= 0 ? message.afterReceiptSeq : 0,
                500,
                session.deviceId,
              ),
            });
            send(socket, presenceFrame(session.roomId));
            if (capabilitiesChanged) broadcast(session.roomId, { type: 'membership', state: publicState(state) });
            return;
          }

          if (store.getMember(session.roomId, session.deviceId)?.status !== 'active' || store.deviceRecoveryPending(session.roomId, session.deviceId)) {
            socket.close(4403, 'Device no longer active');
            return;
          }

          if (message.type === 'call') {
            await callService.handle(socket, session, message);
            return;
          }

          if (message.type === 'ping') {
            send(socket, { type: 'pong', at: Date.now() });
            return;
          }

          if (message.type === 'presence') {
            if (!validPresenceFrame(message)) {
              send(socket, { type: 'error', code: 'INVALID_PRESENCE', message: '聊天页面状态格式不正确' });
              return;
            }
            if (session.view !== message.view) {
              session.view = message.view;
              broadcastPresence(session.roomId);
            }
            return;
          }

          if (message.type === 'sync') {
            send(socket, {
              type: 'sync',
              messages: store.messagesAfter(
                session.roomId,
                Number.isSafeInteger(message.afterSeq) && message.afterSeq >= 0 ? message.afterSeq : 0,
                500,
                session.deviceId,
              ),
            });
            return;
          }

          if (message.type === 'receiptSync') {
            send(socket, {
              type: 'receiptSync',
              receipts: store.receiptsAfter(
                session.roomId,
                Number.isSafeInteger(message.afterReceiptSeq) && message.afterReceiptSeq >= 0 ? message.afterReceiptSeq : 0,
                500,
                session.deviceId,
              ),
            });
            return;
          }

          if (message.type === 'receipt') {
            if (!validateReceiptShape(message.receipt, session.roomId) || message.receipt.receiverId !== session.deviceId) {
              send(socket, { type: 'error', code: 'INVALID_RECEIPT', message: '送达回执格式不正确' });
              return;
            }
            const receiver = store.getMember(session.roomId, message.receipt.receiverId);
            if (!receiver || !(await verifyReceiptSignature(message.receipt, receiver.signingKey))) {
              send(socket, { type: 'error', code: 'INVALID_RECEIPT_SIGNATURE', message: '送达回执签名验证失败' });
              return;
            }
            const storedReceipt = store.insertReceipt(session.roomId, message.receipt);
            send(socket, {
              type: 'receiptAck',
              clientMsgId: storedReceipt.receipt.clientMsgId,
              receiptSeq: storedReceipt.receiptSeq,
            });
            if (!storedReceipt.duplicate) {
              const frame = {
                type: 'receipt',
                receiptSeq: storedReceipt.receiptSeq,
                receipt: storedReceipt.receipt,
                acceptedAt: storedReceipt.acceptedAt,
              };
              broadcast(session.roomId, frame, (member) =>
                storedReceipt.receipt.seq <= (member.joinSeq ?? 0)
                  ? {
                      type: 'receipt',
                      receiptSeq: storedReceipt.receiptSeq,
                      skipped: true,
                      acceptedAt: storedReceipt.acceptedAt,
                    }
                  : frame);
            }
            return;
          }

          if (message.type !== 'send' || !validateEnvelopeShape(message.envelope, session.roomId) ||
            (message.countUnread !== undefined && typeof message.countUnread !== 'boolean')) {
            send(socket, { type: 'error', code: 'INVALID_MESSAGE', message: '消息格式不正确' });
            return;
          }
          const sender = store.getMember(session.roomId, message.envelope.senderId);
          const memberIds = store.roomState(session.roomId).members
            .filter((member) => member.status === 'active')
            .map((member) => member.deviceId)
            .sort();
          const recipientIds = message.envelope.v === 1
            ? message.envelope.recipients.map((recipient) => recipient.deviceId).sort()
            : memberIds;
          if (JSON.stringify(memberIds) !== JSON.stringify(recipientIds)) {
            send(socket, { type: 'error', code: 'INVALID_RECIPIENTS', message: '消息收件人与会话成员不一致' });
            return;
          }
          if (!sender || sender.status !== 'active' || sender.deviceId !== session.deviceId || !(await verifyEnvelopeSignature(message.envelope, sender.signingKey))) {
            send(socket, { type: 'error', code: 'INVALID_SIGNATURE', message: '消息签名验证失败' });
            return;
          }
          // A reconnect may replay an envelope that the server accepted before
          // the sender durably removed its local outbox row. A later membership
          // event makes that original MLS epoch stale, but an exact stored
          // duplicate is already committed work and must be acknowledged before
          // evaluating the current epoch. The same logical ID with different
          // authenticated bytes remains a hard conflict.
          const existingMessage = store.getMessageByClientId(session.roomId, message.envelope.clientMsgId);
          if (existingMessage) {
            if (existingMessage.senderId !== message.envelope.senderId ||
              canonicalStringify(existingMessage.envelope) !== canonicalStringify(message.envelope)) {
              send(socket, {
                type: 'error',
                code: 'MESSAGE_CONFLICT',
                clientMsgId: message.envelope.clientMsgId,
                message: '消息标识与已存消息冲突',
              });
              return;
            }
            send(socket, { type: 'ack', clientMsgId: message.envelope.clientMsgId, seq: existingMessage.seq });
            return;
          }
          if (message.envelope.v === 2) {
            const state = store.roomState(session.roomId);
            const messageEpoch = mlsPrivateMessageEpoch(message.envelope.ciphertext);
            if (messageEpoch === null) {
              send(socket, {
                type: 'error',
                code: 'INVALID_MESSAGE',
                clientMsgId: message.envelope.clientMsgId,
                message: 'MLS 密文格式不正确',
              });
              return;
            }
            if (messageEpoch !== state.nextMlsEventSeq + 1) {
              send(socket, { type: 'membership', state: publicState(state) });
              send(socket, {
                type: 'error',
                code: 'MLS_EPOCH_STALE',
                clientMsgId: message.envelope.clientMsgId,
                message: '加密设备状态已更新，消息正在使用新密钥重新加密',
              });
              return;
            }
          }
          // This authenticated transport hint conveys countability only; it is
          // never used to validate or interpret the end-to-end encrypted payload.
          const stored = store.insertMessage(session.roomId, message.envelope, message.countUnread ?? true);
          send(socket, { type: 'ack', clientMsgId: message.envelope.clientMsgId, seq: stored.seq });
          if (!stored.duplicate) {
            broadcast(session.roomId, {
              type: 'message',
              seq: stored.seq,
              envelope: stored.envelope,
              acceptedAt: stored.acceptedAt,
            });
            void notifyOtherDevices(session.roomId, message.envelope.senderId);
          }
        } catch (error) {
          const [, message, code] = normalizeError(error);
          send(socket, { type: 'error', code, message });
        }
      });
    });

    socket.on('close', () => clearTimeout(authTimeout));
    socket.on('error', () => clearTimeout(authTimeout));
  });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, resolve);
  });
  const webSocketHeartbeatTimer = setInterval(() => {
    for (const socket of webSocketServer.clients) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, webSocketHeartbeatMs);
  webSocketHeartbeatTimer.unref?.();
  const address = httpServer.address();
  const resolvedPort = typeof address === 'object' && address ? address.port : port;
  if (!options.quiet) console.log(`Quiet Room listening on http://${host}:${resolvedPort}`);

  const cleanupTimer = setInterval(() => {
    void store.cleanupDeletedRooms().catch(() => console.error('Deleted room file cleanup pending'));
    const cutoff = new Date(Date.now() - incompleteBlobTtlMs).toISOString();
    try {
      store.cleanupExpiredDeviceLinks();
      store.cleanupExpiredRecoveryRequests();
    } catch (error) {
      console.error('Expired device-link cleanup failed:', error instanceof Error ? error.message : 'unknown');
    }
    void store.cleanupExpiredBlobs(cutoff).catch((error) => {
      console.error('Incomplete blob cleanup failed:', error instanceof Error ? error.message : 'unknown');
    });
    const orphanCutoff = new Date(Date.now() - orphanRoomTtlMs).toISOString();
    try {
      store.cleanupOrphanRooms(orphanCutoff);
    } catch (error) {
      console.error('Orphan room cleanup failed:', error instanceof Error ? error.message : 'unknown');
    }
  }, Math.min(incompleteBlobTtlMs, 60 * 60 * 1000));
  cleanupTimer.unref?.();

  return {
    host,
    port: resolvedPort,
    store,
    close: async () => {
      clearInterval(cleanupTimer);
      clearInterval(webSocketHeartbeatTimer);
      callService.close();
      for (const clients of clientsByRoom.values()) {
        for (const socket of clients) socket.close(1001, 'Server shutting down');
      }
      await new Promise((resolve) => webSocketServer.close(resolve));
      await new Promise((resolve) => httpServer.close(resolve));
      await memes.close();
      store.close();
    },
  };
}

function canonicalPair(values) {
  return values.length === 2 ? `${values[0]}:${values[1]}` : '';
}

const directRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (directRun) {
  startServer()
    .then((instance) => {
      let stopping = false;
      const stop = async () => {
        if (stopping) return;
        stopping = true;
        await instance.close();
      };
      process.once('SIGTERM', () => void stop());
      process.once('SIGINT', () => void stop());
    })
    .catch((error) => {
      console.error('Failed to start Quiet Room:', error);
      process.exitCode = 1;
    });
}
