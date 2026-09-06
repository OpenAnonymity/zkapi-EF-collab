#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
proposal="${1:-}"
dist_root="${2:-$repo_root/dist/browser-ux-$proposal}"

case "$proposal" in
  quiet|guided|activity|receipt|relay|ambient|capsule) ;;
  *)
    echo "Usage: $0 <quiet|guided|activity|receipt|relay|ambient|capsule> [output-directory]" >&2
    exit 1
    ;;
esac

node "$repo_root/scripts/compose-browser-client.mjs" --out-dir "$dist_root" --network sepolia --proposal "$proposal"
