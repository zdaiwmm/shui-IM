import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startServer } from '../server/index.mjs';
import { randomBase64Url } from '../src/lib/base64';
import {
  bundleFingerprint,
  createDeliveryReceipt,
  createJoinProof,
  encryptMessage,
  generateIdentity,
} from '../src/lib/crypto';
import type { RoomMember, Vault } from '../src/lib/types';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((operation) => operation()));
});

class FrameClient {
  readonly socket: WebSocket;
  private frames: any[] = [];
  private waiters: Array<{ predicate: (frame: any) => boolean; resolve: (frame: any) => void }> = [];

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      const index = this.waiters.findIndex((waiter) => waiter.predicate(frame));
      if (index >= 0) this.waiters.splice(index, 1)[0]!.resolve(frame);
      else this.frames.push(frame);
    });
  }

  static async connect(url: string): Promise<FrameClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return new FrameClient(socket);
  }

  send(frame: unknown): void {
    this.socket.send(JSON.stringify(frame));
  }

  waitFor(predicate: (frame: any) => boolean): Promise<any> {
    const index = this.frames.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.frames.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        const pending = this.waiters.indexOf(waiter);
        if (pending >= 0) this.waiters.splice(pending, 1);
        reject(new Error('Timed out waiting for WebSocket frame'));
      }, 3000);
    });
  }

  close(): void {
    this.socket.close();
  }
}

async function request(url: string, options: RequestInit = {}) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  return body;
}

describe('HTTP and WebSocket integration', () => {
  it('pairs exactly two devices, verifies signed ciphertext, and commits a total order', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'quiet-room-server-'));
    const server = await startServer({ port: 0, host: '127.0.0.1', dataDir, quiet: true });
    cleanup.push(async () => {
      await server.close();
      await rm(dataDir, { recursive: true, force: true });
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const wsUrl = `ws://127.0.0.1:${server.port}/ws`;
    const shell = await fetch(`${baseUrl}/`);
    expect(shell.status).toBe(200);
    expect(shell.headers.get('content-security-policy')).toContain(`ws://127.0.0.1:${server.port}`);
    await expect(request(`${baseUrl}/api/health`)).resolves.toMatchObject({ ok: true, database: true, storage: true });
    const accessToken = randomBase64Url(32);
    const pairingSecret = randomBase64Url(32);
    const [creatorIdentity, joinerIdentity] = await Promise.all([generateIdentity(), generateIdentity()]);
    const room = await request(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creatorBundle: creatorIdentity.publicBundle, accessToken }),
    });
    const proof = await createJoinProof(pairingSecret, joinerIdentity.publicBundle);
    const joined = await request(`${baseUrl}/api/rooms/${room.roomId}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ bundle: joinerIdentity.publicBundle, proof }),
    });
    expect(joined.members).toHaveLength(2);
    const joinedAgain = await request(`${baseUrl}/api/rooms/${room.roomId}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ bundle: joinerIdentity.publicBundle, proof }),
    });
    expect(joinedAgain.members).toHaveLength(2);

    const creatorMember: RoomMember = joined.members.find((member: RoomMember) => member.role === 'creator');
    const joinerMember: RoomMember = joined.members.find((member: RoomMember) => member.role === 'joiner');
    const common = {
      v: 1 as const,
      roomId: room.roomId,
      accessToken,
      pairingSecret,
      creatorFingerprint: await bundleFingerprint(creatorIdentity.publicBundle),
      members: [creatorMember, joinerMember],
      lastSeq: 0,
      createdAt: new Date().toISOString(),
    };
    const creatorVault: Vault = { ...common, role: 'creator', identity: creatorIdentity };
    const joinerVault: Vault = { ...common, role: 'joiner', identity: joinerIdentity };
    const creatorClient = await FrameClient.connect(wsUrl);
    const joinerClient = await FrameClient.connect(wsUrl);
    cleanup.unshift(async () => {
      creatorClient.close();
      joinerClient.close();
    });
    creatorClient.send({ type: 'auth', roomId: room.roomId, accessToken, afterSeq: 0, afterReceiptSeq: 0 });
    joinerClient.send({ type: 'auth', roomId: room.roomId, accessToken, afterSeq: 0, afterReceiptSeq: 0 });
    await Promise.all([
      creatorClient.waitFor((frame) => frame.type === 'ready'),
      joinerClient.waitFor((frame) => frame.type === 'ready'),
    ]);

    const secretText = 'SERVER_MUST_NEVER_SEE_THIS_PLAINTEXT';
    const firstEnvelope = await encryptMessage(creatorVault, {
      v: 1,
      kind: 'text',
      text: secretText,
      sentAt: new Date().toISOString(),
    });
    creatorClient.send({ type: 'send', envelope: firstEnvelope });
    const [firstAck, firstDelivery] = await Promise.all([
      creatorClient.waitFor((frame) => frame.type === 'ack' && frame.clientMsgId === firstEnvelope.clientMsgId),
      joinerClient.waitFor((frame) => frame.type === 'message' && frame.envelope.clientMsgId === firstEnvelope.clientMsgId),
    ]);
    expect(firstAck.seq).toBe(1);
    expect(firstDelivery.seq).toBe(1);

    const receipt = await createDeliveryReceipt(joinerVault, firstDelivery);
    joinerClient.send({ type: 'receipt', receipt });
    const [receiptAck, deliveredReceipt] = await Promise.all([
      joinerClient.waitFor((frame) => frame.type === 'receiptAck' && frame.clientMsgId === firstEnvelope.clientMsgId),
      creatorClient.waitFor((frame) => frame.type === 'receipt' && frame.receipt.clientMsgId === firstEnvelope.clientMsgId),
    ]);
    expect(receiptAck.receiptSeq).toBe(1);
    expect(deliveredReceipt.receiptSeq).toBe(1);
    joinerClient.send({ type: 'receipt', receipt });
    const duplicateReceiptAck = await joinerClient.waitFor(
      (frame) => frame.type === 'receiptAck' && frame.clientMsgId === firstEnvelope.clientMsgId,
    );
    expect(duplicateReceiptAck.receiptSeq).toBe(1);

    creatorClient.send({ type: 'send', envelope: firstEnvelope });
    const duplicateAck = await creatorClient.waitFor((frame) => frame.type === 'ack' && frame.clientMsgId === firstEnvelope.clientMsgId);
    expect(duplicateAck.seq).toBe(1);

    const secondEnvelope = await encryptMessage(joinerVault, {
      v: 1,
      kind: 'text',
      text: 'reply',
      sentAt: new Date().toISOString(),
    });
    joinerClient.send({ type: 'send', envelope: secondEnvelope });
    const secondDelivery = await creatorClient.waitFor((frame) => frame.type === 'message' && frame.envelope.clientMsgId === secondEnvelope.clientMsgId);
    expect(secondDelivery.seq).toBe(2);

    const thirdEnvelope = await encryptMessage(joinerVault, {
      v: 1,
      kind: 'text',
      text: 'third',
      sentAt: new Date().toISOString(),
    });
    const fourthEnvelope = await encryptMessage(joinerVault, {
      v: 1,
      kind: 'text',
      text: 'fourth',
      sentAt: new Date().toISOString(),
    });
    joinerClient.send({ type: 'send', envelope: thirdEnvelope });
    joinerClient.send({ type: 'send', envelope: fourthEnvelope });
    const thirdDelivery = await creatorClient.waitFor((frame) => frame.type === 'message' && frame.envelope.clientMsgId === thirdEnvelope.clientMsgId);
    const fourthDelivery = await creatorClient.waitFor((frame) => frame.type === 'message' && frame.envelope.clientMsgId === fourthEnvelope.clientMsgId);
    expect([thirdDelivery.seq, fourthDelivery.seq]).toEqual([3, 4]);

    const reconnectClient = await FrameClient.connect(wsUrl);
    cleanup.unshift(async () => reconnectClient.close());
    reconnectClient.send({
      type: 'auth',
      roomId: room.roomId,
      accessToken,
      afterSeq: 1,
      afterReceiptSeq: 0,
    });
    const [resumedMessages, resumedReceipts] = await Promise.all([
      reconnectClient.waitFor((frame) => frame.type === 'sync'),
      reconnectClient.waitFor((frame) => frame.type === 'receiptSync'),
    ]);
    expect(resumedMessages.messages.map((message: { seq: number }) => message.seq)).toEqual([2, 3, 4]);
    expect(resumedReceipts.receipts).toHaveLength(1);
    expect(new Set(resumedMessages.messages.map((message: { envelope: { clientMsgId: string } }) => message.envelope.clientMsgId)).size).toBe(3);

    const database = await readFile(path.join(dataDir, 'quiet-room.sqlite'));
    const wal = await readFile(path.join(dataDir, 'quiet-room.sqlite-wal')).catch(() => Buffer.alloc(0));
    const persisted = Buffer.concat([database, wal]);
    expect(persisted.includes(Buffer.from(secretText))).toBe(false);
    expect(persisted.includes(Buffer.from(accessToken))).toBe(false);
  });
});
