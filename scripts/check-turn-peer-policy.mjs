// Isolated CI TURN listener only. CREATE_PERMISSION sends no packets to peers.
// Test public addresses outside the lab whitelist so it cannot hide a deny-all.
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import { callIceConfiguration } from '../server/calls.mjs';

assert(process.env.CI === 'true' && process.platform === 'linux', 'TURN policy check requires the isolated Linux CI lab');
assert(process.env.TURN_REALM === 'quiet-room-test', 'Unexpected TURN lab realm');
const host = process.env.TURN_PUBLIC_IP;
assert(/^\d{1,3}(\.\d{1,3}){3}$/.test(host ?? ''), 'TURN lab IPv4 required');
const { username, credential } = callIceConfiguration({ turnUrls: `turn:${host}:3478`, callRelayOnly: true }).iceServers.find(server => server.username);
const socket = dgram.createSocket('udp4');

function attribute(type, value) {
  const result = Buffer.alloc(4 + Math.ceil(value.length / 4) * 4);
  result.writeUInt16BE(type); result.writeUInt16BE(value.length, 2); value.copy(result, 4);
  return result;
}
function attributes(message) {
  const result = new Map();
  for (let offset = 20; offset + 4 <= message.length;) {
    const length = message.readUInt16BE(offset + 2);
    assert(offset + 4 + length <= message.length, 'Truncated STUN attribute');
    result.set(message.readUInt16BE(offset), message.subarray(offset + 4, offset + 4 + length));
    offset += 4 + Math.ceil(length / 4) * 4;
  }
  return result;
}
function message(type, values, key) {
  const header = Buffer.alloc(20);
  header.writeUInt16BE(type); header.writeUInt32BE(0x2112a442, 4); randomBytes(12).copy(header, 8);
  let packet = Buffer.concat([header, ...values]);
  packet.writeUInt16BE(packet.length - 20 + (key ? 24 : 0), 2);
  if (key) packet = Buffer.concat([packet, attribute(8, createHmac('sha1', key).update(packet).digest())]);
  return packet;
}
function request(packet) {
  return new Promise((resolve, reject) => {
    const finish = (error, response) => { clearTimeout(timer); socket.off('message', receive); error ? reject(error) : resolve(response); };
    const receive = response => {
      if (response.length >= 20 && response.subarray(8, 20).equals(packet.subarray(8, 20))) finish(null, response);
    };
    const timer = setTimeout(() => finish(new Error('TURN policy request timed out')), 3000);
    socket.on('message', receive);
    socket.send(packet, 3478, host, error => { if (error) finish(error); });
  });
}
let auth, key, allocated = false;
try {
  const transport = attribute(0x19, Buffer.from([17, 0, 0, 0]));
  const challenge = attributes(await request(message(3, [transport])));
  assert(challenge.has(0x14) && challenge.has(0x15), 'Missing TURN authentication challenge');
  const realm = challenge.get(0x14);
  key = createHash('md5').update(`${username}:${realm.toString()}:${credential}`).digest();
  auth = [attribute(6, Buffer.from(username)), attribute(0x14, realm), attribute(0x15, challenge.get(0x15))];
  assert.equal((await request(message(3, [transport, ...auth], key))).readUInt16BE(0), 0x103, 'Authenticated TURN allocation failed');
  allocated = true;
  const cases = [['203.0.113.1', true], ['198.51.100.1', true], ['0.0.0.0', false], ['127.0.0.1', false],
    ['169.254.169.254', false], ['10.255.255.254', false], ['172.16.0.1', false], ['192.168.1.1', false], ['100.64.0.1', false]];
  for (const [peer, allowed] of cases) {
    assert(peer !== host, 'Policy probe must be outside the lab whitelist');
    const address = Buffer.from([0, 1, 0, 0, ...peer.split('.').map((part, index) => Number(part) ^ [0x21, 0x12, 0xa4, 0x42][index])]);
    address.writeUInt16BE(49160 ^ 0x2112, 2);
    const response = await request(message(8, [attribute(0x12, address), ...auth], key));
    if (allowed) assert.equal(response.readUInt16BE(0), 0x108, `Public TURN peer denied: ${peer}`);
    else {
      const error = attributes(response).get(9);
      assert.equal(response.readUInt16BE(0), 0x118, `Forbidden TURN peer accepted: ${peer}`);
      assert(error && (error[2] & 7) * 100 + error[3] === 403, `Expected peer denial: ${peer}`);
    }
  }
  console.log(`PASS TURN peer policy: ${cases.length} public/forbidden addresses outside the lab whitelist`);
} finally {
  try { if (allocated) await request(message(4, [attribute(0x0d, Buffer.alloc(4)), ...auth], key)); }
  finally { socket.close(); }
}
