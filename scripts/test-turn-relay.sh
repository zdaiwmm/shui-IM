#!/usr/bin/env bash
# Isolated Linux/CI lab only. RFC 5737 address lets the real production peer ACL
# remain intact; it never runs against a production hostname or an existing TURN.
set -Eeuo pipefail
[[ "${CI:-}" == true && "$(uname -s)" == Linux ]] || { echo 'TURN relay lab requires an isolated Linux CI runner.' >&2; exit 64; }
lab_dir="$(mktemp -d)"
export COTURN_IMAGE=coturn/coturn@sha256:bbefd3e1fdfdc0d58770fe01b581fd8b00d9f3a5580d00acb77cf719a6bc78e3
export QUIET_ROOM_IMAGE=quiet-room-unused-test
export TURN_PUBLIC_IP=192.0.2.1 TURN_REALM=quiet-room-test TURN_TLS_ENABLED=false TURN_TLS_DIR="$lab_dir/certs"
export TURN_MIN_PORT=49160 TURN_MAX_PORT=49200
export TURN_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
mkdir "$TURN_TLS_DIR"
cp deploy/turnserver.conf "$lab_dir/turnserver.conf"
printf '\nlistening-ip=192.0.2.1\nrelay-ip=192.0.2.1\n' >> "$lab_dir/turnserver.conf"
cat > "$lab_dir/compose.lab.yaml" <<YAML
services:
  quiet-room-turn:
    volumes:
      - $lab_dir/turnserver.conf:/etc/coturn/quiet-room.conf:ro
YAML
compose=(docker compose --project-name quiet-room-relay-test --file compose.yaml --file compose.calls.yaml --file "$lab_dir/compose.lab.yaml" --profile calls)
cleanup() { "${compose[@]}" down --remove-orphans >/dev/null 2>&1 || true; sudo ip address del 192.0.2.1/32 dev lo >/dev/null 2>&1 || true; rm -rf "$lab_dir"; }
trap cleanup EXIT
sudo ip address add 192.0.2.1/32 dev lo
"${compose[@]}" up --detach --no-deps quiet-room-turn
if ! node --input-type=module <<'JS'
import net from 'node:net';
for (let i = 0; ; i++) {
  const ready = await new Promise(resolve => {
    const socket = net.connect(3478, '192.0.2.1'); socket.setTimeout(500);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false)); socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
  if (ready) break;
  if (i >= 30) throw new Error('Isolated TURN listener did not start');
  await new Promise(resolve => setTimeout(resolve, 250));
}
JS
then
  "${compose[@]}" logs --no-color quiet-room-turn >&2 || true
  exit 1
fi
for transport in udp tcp; do
  export TURN_URLS="turn:192.0.2.1:3478?transport=$transport"
  export QUIET_ROOM_CALL_TEST_CONFIG="$lab_dir/ice.json"
  node --input-type=module <<'JS'
import { writeFileSync } from 'node:fs';
import { callIceConfiguration } from './server/calls.mjs';
writeFileSync(process.env.QUIET_ROOM_CALL_TEST_CONFIG, JSON.stringify(callIceConfiguration({ callRelayOnly: true })), { mode: 0o600 });
JS
  node tests/call-native.e2e.mjs
  printf 'PASS authenticated TURN %s encrypted audio/video, bidirectional media, and ICE restart\n' "$transport"
done
