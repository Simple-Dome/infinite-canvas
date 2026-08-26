#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
HELPER="$SCRIPT_DIR/remote-release-helper.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/remote-release-helper.XXXXXX")"
REMOTE_ROOT="$TEST_ROOT/remote"
FAKE_SSH="$TEST_ROOT/fake-ssh"
mkdir -p "$REMOTE_ROOT"
trap 'rm -rf "$TEST_ROOT"' EXIT

fail() {
    printf 'remote-release-helper test failed: %s\n' "$1" >&2
    exit 1
}

printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'printf "%s\\n" "$*" >> "$FAKE_SSH_LOG"' 'if [ "${1:-}" = -n ]; then shift; fi' '[ "$#" -ge 2 ] || exit 2' 'shift' 'bash -c "$*"' > "$FAKE_SSH"
chmod +x "$FAKE_SSH"

payload="$TEST_ROOT/payload.bin"
printf '0123456789abcdefghijklmnopqrstuvwxyz' > "$payload"
archive_sha="$(sha256sum "$payload" | awk '{print $1}')"

export FAKE_SSH_LOG="$TEST_ROOT/ssh.log"
SSH_BIN="$FAKE_SSH" "$HELPER" transfer-archive \
    --remote test@local --remote-dir "$REMOTE_ROOT/release" \
    --archive "$payload" --chunk-bytes 7 > "$TEST_ROOT/transfer.out"
grep -Fx "archive_sha256=$archive_sha" "$TEST_ROOT/transfer.out" >/dev/null || fail "archive checksum"
cmp "$payload" "$REMOTE_ROOT/release/payload.bin" || fail "archive content"
test -z "$(find "$REMOTE_ROOT/release" -name '*.partial' -print -quit)" || fail "partial file remains"
test -z "$(find "$REMOTE_ROOT/release" -name 'payload.bin.chunk-*' -print -quit)" || fail "chunk file remains"
grep -q '^-n test@local ' "$FAKE_SSH_LOG" || fail "control SSH did not use -n"
grep -q '^test@local umask 077; base64 --decode' "$FAKE_SSH_LOG" || fail "data SSH is missing"

SSH_BIN="$FAKE_SSH" "$HELPER" transfer-archive \
    --remote test@local --remote-dir "$REMOTE_ROOT/release" \
    --archive "$payload" --chunk-bytes 7 > "$TEST_ROOT/retransfer.out"
grep -Fx 'status=already-verified' "$TEST_ROOT/retransfer.out" >/dev/null || fail "idempotent archive transfer"

printf 'stale' > "$REMOTE_ROOT/release/stale.partial"
if SSH_BIN="$FAKE_SSH" "$HELPER" transfer-archive \
    --remote test@local --remote-dir "$REMOTE_ROOT/release" \
    --archive "$payload" --chunk-bytes 7 > "$TEST_ROOT/partial.out" 2>&1; then
    fail "stale partial should fail closed"
fi
grep -F 'partial_present' "$TEST_ROOT/partial.out" >/dev/null || fail "partial failure reason"
rm -f "$REMOTE_ROOT/release/stale.partial"

transaction="$TEST_ROOT/transaction.sh"
printf '%s\n' '#!/usr/bin/env bash' 'set -eu' "printf '%s:%s' \"\$1\" \"\$TEST_TRANSACTION_VALUE\" > '$REMOTE_ROOT/transaction.result'" > "$transaction"
chmod +x "$transaction"
SSH_BIN="$FAKE_SSH" "$HELPER" run-transaction \
    --remote test@local --script "$transaction" \
    --remote-script "$REMOTE_ROOT/scripts/transaction.sh" --arg 'transaction ran' --env TEST_TRANSACTION_VALUE=env-value > "$TEST_ROOT/transaction.out"
grep -Fx 'transaction ran:env-value' "$REMOTE_ROOT/transaction.result" >/dev/null || fail "transaction execution, argument quoting, or env passing"
test -z "$(find "$REMOTE_ROOT" -name '*.partial' -print -quit)" || fail "transaction partial remains"

installed="$TEST_ROOT/installed.sh"
printf '%s\n' '#!/usr/bin/env bash' 'set -eu' "printf installed > '$REMOTE_ROOT/installed.result'" > "$installed"
chmod +x "$installed"
SSH_BIN="$FAKE_SSH" "$HELPER" install-script \
    --remote test@local --script "$installed" \
    --remote-script "$REMOTE_ROOT/scripts/installed.sh" > "$TEST_ROOT/install.out"
test -f "$REMOTE_ROOT/scripts/installed.sh" || fail "install-script did not publish script"
test ! -e "$REMOTE_ROOT/installed.result" || fail "install-script executed a script"
test -z "$(find "$REMOTE_ROOT" -name '*.partial' -print -quit)" || fail "install-script partial remains"

printf 'remote release helper tests passed\n'
