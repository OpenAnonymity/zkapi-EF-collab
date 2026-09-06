#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dist_root="${1:-$repo_root/dist/browser}"

node "$repo_root/scripts/compose-browser-client.mjs" --out-dir "$dist_root" --network sepolia
