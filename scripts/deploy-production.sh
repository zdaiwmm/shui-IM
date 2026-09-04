#!/usr/bin/env bash
set -Eeuo pipefail

readonly ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Stable entry point for https://ai.shui.click. Keep the privileged helper separate.
exec node "$ROOT_DIR/scripts/release.mjs" "$@"
