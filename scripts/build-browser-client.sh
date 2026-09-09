#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
protocol_rust="$repo_root/protocol/rust"
wasm_target="$protocol_rust/target/wasm32-unknown-unknown/release/zkapi_browser.wasm"
wasm_output="$repo_root/sdk/wasm"
dist_root="${1:-$repo_root/dist/browser}"

wasm_bindgen_bin="${WASM_BINDGEN_BIN:-$(command -v wasm-bindgen || true)}"
if [[ -z "$wasm_bindgen_bin" ]]; then
  cargo_bin_dir="$(dirname "$(command -v cargo)")"
  [[ -x "$cargo_bin_dir/wasm-bindgen" ]] && wasm_bindgen_bin="$cargo_bin_dir/wasm-bindgen"
fi
if [[ -z "$wasm_bindgen_bin" ]]; then
  echo "wasm-bindgen is required: cargo install wasm-bindgen-cli --version 0.2.117 --locked" >&2
  exit 1
fi

rustup target add wasm32-unknown-unknown
cargo build \
  --manifest-path "$protocol_rust/Cargo.toml" \
  -p zkapi-browser \
  --target wasm32-unknown-unknown \
  --release

mkdir -p "$wasm_output"
"$wasm_bindgen_bin" "$wasm_target" \
  --target web \
  --out-dir "$wasm_output" \
  --out-name zkapi_browser \
  --omit-default-module-path

node "$repo_root/scripts/sync-sdk-assets.mjs"
node "$repo_root/scripts/build-sdk.mjs" --out-dir "$dist_root"

echo "Browser SDK assets built at $dist_root"
echo "The host application owns the chat UI and deployment."
