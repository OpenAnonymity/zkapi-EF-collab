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

"$repo_root/scripts/package-browser-client.sh" "$dist_root"
node - "$dist_root/funding/browser-config.json" "$proposal" <<'NODE'
const fs = require('node:fs');
const [configPath, proposal] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
config.ux_proposal = proposal;
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
NODE

echo "Packaged the $proposal zkAPI UX proposal at $dist_root/funding/"
