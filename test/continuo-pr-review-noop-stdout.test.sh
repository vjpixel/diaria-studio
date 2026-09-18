#!/usr/bin/env bash
# Regression for #8329: the no-eligible-PR path must reach the cron delivery
# stream instead of exiting while stdout is still redirected to the log.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../hermes/scripts/continuo-pr-review.sh"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

{
  printf '%s\n' 'exec 3>&1' 'exec 1>&2' 'PR_NUMBERS=""'
  sed -n '/^if \[ -z "\$PR_NUMBERS" \]; then/,/^fi$/p' "$SCRIPT"
} > "$WORKDIR/runnable.sh"

bash "$WORKDIR/runnable.sh" > "$WORKDIR/stdout.txt" 2> "$WORKDIR/stderr.txt"

EXPECTED='[continuo-pr-review] nenhuma PR elegível aberta (exceto bot/*) — noop'
if ! grep -Fxq "$EXPECTED" "$WORKDIR/stdout.txt"; then
  printf 'FAIL: noop não chegou ao stdout de entrega\n' >&2
  printf 'stdout: %s\n' "$(<"$WORKDIR/stdout.txt")" >&2
  exit 1
fi

if [ -s "$WORKDIR/stderr.txt" ]; then
  printf 'FAIL: noop vazou para stderr\n' >&2
  printf 'stderr: %s\n' "$(<"$WORKDIR/stderr.txt")" >&2
  exit 1
fi

printf 'ok: noop entregue em stdout\n'
