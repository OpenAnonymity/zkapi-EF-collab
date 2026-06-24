#!/usr/bin/env bash
# Concurrent load test for a running zkapi-clientd.
#
# Unlike scripts/e2e-demo.sh (functional) and .demo/hammer.sh (sequential), this
# fires many requests CONCURRENTLY against an already-running clientd and reports
# throughput, latency percentiles, and failure rate — the Week 9 concurrency
# check.
#
# Prereqs: a clientd with an active, funded note (e.g. run scripts/e2e-demo.sh
# first, or point CLIENTD_URL at your own stack). The wallet serializes mutating
# requests behind a lock, so this also exercises that the lock holds under load
# (no corruption / no double-spend) rather than measuring parallel throughput.
#
# Usage:
#   CLIENTD_URL=http://127.0.0.1:11434 TOTAL=100 CONCURRENCY=10 ./scripts/stress-test.sh
set -uo pipefail

CLIENTD_URL="${CLIENTD_URL:-http://127.0.0.1:11434}"
TOTAL="${TOTAL:-100}"
CONCURRENCY="${CONCURRENCY:-10}"
ENDPOINT="${ENDPOINT:-/v1/chat/completions}"
PAYLOAD="${PAYLOAD:-{\"model\":\"zkapi-echo\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}}"

OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

echo "stress: $TOTAL requests, concurrency $CONCURRENCY -> $CLIENTD_URL$ENDPOINT"

one_request() {
  local i="$1"
  local code time
  read -r code time < <(curl -s -o "$OUT/body.$i" -w '%{http_code} %{time_total}' \
    -H 'content-type: application/json' -X POST \
    --data "$PAYLOAD" "$CLIENTD_URL$ENDPOINT")
  echo "$code $time" >>"$OUT/results"
}
export -f one_request
export OUT CLIENTD_URL ENDPOINT PAYLOAD

START=$(date +%s.%N)
seq 1 "$TOTAL" | xargs -P "$CONCURRENCY" -I{} bash -c 'one_request "$@"' _ {}
END=$(date +%s.%N)

echo
echo "=== results ==="
awk -v start="$START" -v end="$END" '
  { codes[$1]++; lat[NR]=$2*1000; if ($1 ~ /^2/) ok++ }
  END {
    n = NR;
    if (n == 0) { print "no results"; exit 1 }
    for (i=1;i<=n;i++) for (j=i+1;j<=n;j++) if (lat[j]<lat[i]) { t=lat[i]; lat[i]=lat[j]; lat[j]=t }
    i50=int(0.50*n); if (i50<1) i50=1;
    i90=int(0.90*n); if (i90<1) i90=1;
    i99=int(0.99*n); if (i99<1) i99=1;
    wall = end - start; if (wall <= 0) wall = 0.0001;
    printf "requests    : %d\n", n;
    printf "successes   : %d (%.1f%%)\n", ok, (ok*100.0)/n;
    printf "wall time   : %.2fs\n", wall;
    printf "throughput  : %.1f req/s\n", n/wall;
    printf "latency p50 : %.0f ms\n", lat[i50];
    printf "latency p90 : %.0f ms\n", lat[i90];
    printf "latency p99 : %.0f ms\n", lat[i99];
    printf "status codes:";
    for (c in codes) printf " %s=%d", c, codes[c];
    printf "\n";
  }
' "$OUT/results"
