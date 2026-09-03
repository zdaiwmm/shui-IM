#!/usr/bin/env bash
set -Eeuo pipefail

readonly ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly SERVER_HOST="${QUIET_ROOM_SERVER_HOST:?Set QUIET_ROOM_SERVER_HOST before deploying}"
readonly SERVER_USER="${QUIET_ROOM_SERVER_USER:?Set QUIET_ROOM_SERVER_USER before deploying}"
readonly SERVER_KEY="${QUIET_ROOM_SERVER_KEY:?Set QUIET_ROOM_SERVER_KEY before deploying}"
readonly GITHUB_KEY="${QUIET_ROOM_GITHUB_KEY:?Set QUIET_ROOM_GITHUB_KEY before deploying}"

cd "$ROOT_DIR"

[[ "$(git branch --show-current)" == main ]] || {
  printf 'Production may only be deployed from the main branch.\n' >&2
  exit 65
}

git diff --quiet && git diff --cached --quiet || {
  printf 'Commit or discard local changes before deploying.\n' >&2
  exit 65
}

GIT_SSH_COMMAND="ssh -o BatchMode=yes -o IdentitiesOnly=yes -i $GITHUB_KEY" git fetch origin main

local_sha="$(git rev-parse HEAD)"
remote_sha="$(git rev-parse origin/main)"
[[ "$local_sha" == "$remote_sha" ]] || {
  printf 'Local main and origin/main differ. Push or pull before deploying.\n' >&2
  exit 65
}

printf 'About to deploy %s to https://chat.mijiu.cloud\n' "$local_sha"
read -r -p 'Type DEPLOY to continue: ' confirmation
[[ "$confirmation" == DEPLOY ]] || {
  printf 'Deployment cancelled.\n'
  exit 0
}

ssh \
  -o BatchMode=yes \
  -o IdentitiesOnly=yes \
  -i "$SERVER_KEY" \
  "$SERVER_USER@$SERVER_HOST" \
  sudo -n /usr/local/sbin/quiet-room-deploy "$local_sha"
