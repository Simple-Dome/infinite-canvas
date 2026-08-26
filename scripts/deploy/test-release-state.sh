#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
STATE_SCRIPT="$SCRIPT_DIR/release-state.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/cherry-image-release-state.XXXXXX")"
MANIFEST="$TEST_ROOT/process.md"

cleanup() { rm -rf "$TEST_ROOT"; }
trap cleanup EXIT
fail() { printf 'release-state test failed: %s\n' "$1" >&2; exit 1; }

expect_failure() {
    local expected="$1" output status
    shift
    set +e
    output="$($@ 2>&1)"
    status=$?
    set -e
    [ "$status" -ne 0 ] || fail "command unexpectedly succeeded: $*"
    printf '%s\n' "$output" | grep -Fq -- "$expected" || fail "failure did not include '$expected': $output"
}

printf '# Test Manifest\n' >"$MANIFEST"

bash "$STATE_SCRIPT" init --manifest "$MANIFEST" --phase source-prepared --evidence source-pair:parent:canvas >/dev/null
grep -Fx -- '- Current Phase: source-prepared' "$MANIFEST" >/dev/null || fail 'initial phase'
grep -Fx -- '- Phase Status: active' "$MANIFEST" >/dev/null || fail 'initial phase status'

expect_failure 'invalid phase transition: source-prepared -> artifacts-built' bash "$STATE_SCRIPT" transition --manifest "$MANIFEST" --to artifacts-built --evidence artifact:sha256
bash "$STATE_SCRIPT" transition --manifest "$MANIFEST" --to composite-prepared --evidence archive-sha256:abc >/dev/null
expect_failure 'expected phase source-prepared, found composite-prepared' bash "$STATE_SCRIPT" assert --manifest "$MANIFEST" --phase source-prepared

bash "$STATE_SCRIPT" block --manifest "$MANIFEST" --evidence missing-live-evidence >/dev/null
expect_failure 'state is blocked at phase composite-prepared' bash "$STATE_SCRIPT" transition --manifest "$MANIFEST" --to local-preparation-verified --evidence prepared-pair:parent:canvas
bash "$STATE_SCRIPT" unblock --manifest "$MANIFEST" --evidence discovery-repaired >/dev/null
bash "$STATE_SCRIPT" transition --manifest "$MANIFEST" --to local-preparation-verified --evidence prepared-pair:parent:canvas >/dev/null
bash "$STATE_SCRIPT" transition --manifest "$MANIFEST" --to local-preparation-verified --evidence ignored --idempotent >/dev/null

for phase in live-discovery-recorded build-host-preflight artifacts-built production-authorized production-loaded-verified candidates-healthy cutover-complete public-accepted closed; do
    bash "$STATE_SCRIPT" transition --manifest "$MANIFEST" --to "$phase" --evidence "test:$phase" >/dev/null
done
bash "$STATE_SCRIPT" assert --manifest "$MANIFEST" --phase closed --status complete >/dev/null
expect_failure 'state is complete at phase closed' bash "$STATE_SCRIPT" transition --manifest "$MANIFEST" --to closed --evidence test:closed
test -z "$(find "$TEST_ROOT" -name '.release-state.*' -print -quit)" || fail 'atomic state temporary file remains'

printf 'image release-state tests passed\n'
