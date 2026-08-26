#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROBE="$SCRIPT_DIR/uploads-probe.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/uploads-probe.XXXXXX")"
STATE="$TEST_ROOT/state"
FAKE_CURL="$TEST_ROOT/curl"
mkdir -p "$STATE"
trap 'rm -rf "$TEST_ROOT"' EXIT

fail() {
    printf 'uploads-probe test failed: %s\n' "$1" >&2
    exit 1
}

printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' \
    'method=GET' 'output=/dev/null' 'upload_file=' 'url=' \
    'while [ "$#" -gt 0 ]; do' \
    '    case "$1" in' \
    '        --request) method="$2"; shift 2 ;;' \
    '        --output) output="$2"; shift 2 ;;' \
    '        --upload-file) upload_file="$2"; shift 2 ;;' \
    '        --write-out) shift 2 ;;' \
    '        --silent|--show-error|--location) shift ;;' \
    '        http://*|https://*) url="$1"; shift ;;' \
    '        DELETE) printf "unexpected duplicate DELETE argument\\n" >&2; exit 64 ;;' \
    '        *) shift ;;' \
    '    esac' \
    'done' \
    'object="$FAKE_CURL_STATE/object"' \
    'case "$method" in' \
    '    PUT) cp "$upload_file" "$object"; printf 204 ;;' \
    '    GET)' \
    '        if [ "${FAKE_CURL_FAIL_GET:-0}" = 1 ]; then printf 500; exit 0; fi' \
    '        if [ -f "$object" ]; then cp "$object" "$output"; printf 200; else printf 404; fi' \
    '        ;;' \
    '    DELETE) rm -f "$object"; printf 204 ;;' \
    '    *) printf 405 ;;' \
    'esac' > "$FAKE_CURL"
chmod +x "$FAKE_CURL"

payload="$TEST_ROOT/payload.bin"
printf 'probe-payload' > "$payload"
export FAKE_CURL_STATE="$STATE"
PATH="$TEST_ROOT:$PATH" "$PROBE" probe \
    --put-url https://gptch.cloud/canvas-uploads/test \
    --get-url https://gptch.cloud/canvas-uploads/test \
    --delete-url https://gptch.cloud/canvas-uploads/test \
    --payload "$payload" > "$TEST_ROOT/pass.out"
grep -Fx 'result=pass' "$TEST_ROOT/pass.out" >/dev/null || fail "probe pass"
test ! -e "$STATE/object" || fail "object remains after pass"

export FAKE_CURL_FAIL_GET=1
if PATH="$TEST_ROOT:$PATH" "$PROBE" probe \
    --put-url https://gptch.cloud/canvas-uploads/test \
    --get-url https://gptch.cloud/canvas-uploads/test \
    --delete-url https://gptch.cloud/canvas-uploads/test \
    --payload "$payload" > "$TEST_ROOT/fail.out" 2>&1; then
    fail "probe should fail on GET"
fi
test ! -e "$STATE/object" || fail "failure cleanup did not delete object"
grep -F 'cleanup_delete_status=204' "$TEST_ROOT/fail.out" >/dev/null || fail "failure cleanup status"

printf 'uploads probe tests passed\n'
