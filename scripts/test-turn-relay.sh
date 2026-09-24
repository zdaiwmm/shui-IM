#!/usr/bin/env bash
# Isolated Linux/CI lab only. The relay address is this host's own IPv4, never a
# production hostname. allowed-peer-ip lets the two browsers hairpin without
# weakening the production peer denials.
set -Eeuo pipefail
[[ "${CI:-}" == true && "$(uname -s)" == Linux ]] || { echo 'TURN relay lab requires an isolated Linux CI runner.' >&2; exit 64; }
lab_dir="$(mktemp -d)"
export COTURN_IMAGE=coturn/coturn@sha256:bbefd3e1fdfdc0d58770fe01b581fd8b00d9f3a5580d00acb77cf719a6bc78e3
export QUIET_ROOM_IMAGE=quiet-room-unused-test
lab_ip="$(ip -4 route get 1.1.1.1 | sed -n 's/.* src \([0-9.]*\).*/\1/p')"
[[ "$lab_ip" =~ ^[0-9]+(\.[0-9]+){3}$ ]] || { echo "TURN lab could not find a host IPv4 address" >&2; exit 1; }
export TURN_PUBLIC_IP="$lab_ip" TURN_REALM=quiet-room-test TURN_TLS_ENABLED=false TURN_TLS_DIR="$lab_dir/certs"
export TURN_MIN_PORT=49160 TURN_MAX_PORT=49200
export TURN_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
mkdir "$TURN_TLS_DIR"
cp deploy/turnserver.conf "$lab_dir/turnserver.conf"
sed -i.bak '/^no-stdout-log$/d;/^log-file=/d' "$lab_dir/turnserver.conf"
if [[ "$lab_ip" == 10.* ]]; then
  sed -i.bak '/^denied-peer-ip=10\.0\.0\.0-10\.255\.255\.255$/d' "$lab_dir/turnserver.conf"
fi
printf '\nlistening-ip=%s\nrelay-ip=%s\nallowed-peer-ip=%s\nverbose\nlog-file=stdout\n' "$lab_ip" "$lab_ip" "$lab_ip" >> "$lab_dir/turnserver.conf"
cat > "$lab_dir/compose.lab.yaml" <<YAML
services:
  quiet-room-turn:
    volumes:
      - $lab_dir/turnserver.conf:/etc/coturn/quiet-room.conf:ro
YAML
compose=(docker compose --project-name quiet-room-relay-test --file compose.yaml --file compose.calls.yaml --file "$lab_dir/compose.lab.yaml" --profile calls)
cleanup() { "${compose[@]}" down --remove-orphans >/dev/null 2>&1 || true; rm -rf "$lab_dir"; }
trap cleanup EXIT
"${compose[@]}" up --detach --no-deps quiet-room-turn
if ! node --input-type=module <<'JS'
import dgram from 'node:dgram';
import net from 'node:net';
for (let i = 0; ; i++) {
  const ready = await new Promise(resolve => {
    const socket = net.connect(3478, process.env.TURN_PUBLIC_IP); socket.setTimeout(500);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false)); socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
  if (ready) break;
  if (i >= 30) throw new Error('Isolated TURN listener did not start');
  await new Promise(resolve => setTimeout(resolve, 250));
}
const stun = Buffer.alloc(20);
stun.writeUInt16BE(0x0001, 0);
stun.writeUInt32BE(0x2112A442, 4);
const udp = await new Promise((resolve, reject) => {
  const socket = dgram.createSocket('udp4');
  const timer = setTimeout(() => { socket.close(); reject(new Error('Isolated TURN UDP listener did not answer STUN')); }, 2000);
  socket.once('message', () => { clearTimeout(timer); socket.close(); resolve(true); });
  socket.send(stun, 3478, process.env.TURN_PUBLIC_IP);
});
if (!udp) throw new Error('Isolated TURN UDP listener did not answer STUN');
JS
then
  "${compose[@]}" logs --no-color quiet-room-turn >&2 || true
  exit 1
fi
for transport in udp tcp; do
  export TURN_URLS="turn:${lab_ip}:3478?transport=$transport"
  export QUIET_ROOM_CALL_TEST_CONFIG="$lab_dir/ice.json"
  node --input-type=module <<'JS'
import { writeFileSync } from 'node:fs';
import { callIceConfiguration } from './server/calls.mjs';
writeFileSync(process.env.QUIET_ROOM_CALL_TEST_CONFIG, JSON.stringify(callIceConfiguration({ callRelayOnly: true })), { mode: 0o600 });
JS
  if ! node tests/call-native.e2e.mjs; then
    "${compose[@]}" logs --no-color quiet-room-turn >&2 || true
    exit 1
  fi
  printf 'PASS authenticated TURN %s encrypted audio/video, bidirectional media, and ICE restart\n' "$transport"
done
