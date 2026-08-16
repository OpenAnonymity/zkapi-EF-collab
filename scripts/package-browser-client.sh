#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dist_root="${1:-$repo_root/dist/browser}"

required_files=(
  "$repo_root/funding-page/index.html"
  "$repo_root/funding-page/wasm/zkapi_browser.js"
  "$repo_root/funding-page/wasm/zkapi_browser_bg.wasm"
  "$repo_root/protocol/setup/v2/request.pk"
  "$repo_root/protocol/setup/v2/withdrawal.pk"
)

for required_file in "${required_files[@]}"; do
  if [[ ! -f "$required_file" ]]; then
    echo "Required browser asset is missing: $required_file" >&2
    exit 1
  fi
done

mkdir -p "$dist_root/funding/proofs"
cp -R "$repo_root/funding-page/." "$dist_root/funding/"
cp "$repo_root/protocol/setup/v2/request.pk" "$dist_root/funding/proofs/request.pk"
cp "$repo_root/protocol/setup/v2/withdrawal.pk" "$dist_root/funding/proofs/withdrawal.pk"

echo "Browser client packaged at $dist_root/funding/"
