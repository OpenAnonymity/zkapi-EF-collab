#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dist_root="${1:-$repo_root/dist/browser-mainnet}"

"$repo_root/scripts/package-browser-client.sh" "$dist_root"
cp "$repo_root/funding-page/browser-config.mainnet.json" "$dist_root/funding/browser-config.json"

echo "Mainnet browser client packaged at $dist_root/funding/"
