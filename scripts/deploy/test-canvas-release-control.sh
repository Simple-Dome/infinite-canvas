#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
CONTROL="$SCRIPT_DIR/canvas-release-control.sh"
MANIFEST_SCRIPT="$SCRIPT_DIR/canvas-artifact-manifest.sh"
PROFILE="$REPO_ROOT/deploy/canvas-profiles/artworkers.online.env.example"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/canvas-release-control.XXXXXX")"
STATE_ROOT="$TEST_ROOT/state"
ARTIFACT_ROOT="$TEST_ROOT/artifacts"
WORKTREE_ROOT="$TEST_ROOT/worktrees"
TASK_ID="canvas-control-test"
SOURCE_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
WORKTREE="$WORKTREE_ROOT/$TASK_ID"

cleanup() {
    if [ -d "$WORKTREE" ]; then
        git -C "$REPO_ROOT" worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
    fi
    rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

fail() {
    printf 'canvas-release-control test failed: %s\n' "$1" >&2
    exit 1
}

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

bash -n "$CONTROL" "$MANIFEST_SCRIPT"

bash "$CONTROL" prepare-worktree \
    --task-id "$TASK_ID" --profile "$PROFILE" --source-ref "$SOURCE_SHA" \
    --state-root "$STATE_ROOT" --artifact-root "$ARTIFACT_ROOT" --worktree-root "$WORKTREE_ROOT" >/dev/null

test -z "$(git -C "$WORKTREE" symbolic-ref -q HEAD || true)" || fail 'release worktree is attached'
test -z "$(git -C "$WORKTREE" status --porcelain --untracked-files=all)" || fail 'release worktree is dirty'
grep -Fx 'domain=artworkers.online' "$STATE_ROOT/$TASK_ID/canvas-source.env" >/dev/null || fail 'source profile domain'
bash "$CONTROL" assert-source --task-id "$TASK_ID" --profile "$PROFILE" \
    --state-root "$STATE_ROOT" --artifact-root "$ARTIFACT_ROOT" --repo-root "$WORKTREE" >/dev/null

NOW="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
EVIDENCE="$TEST_ROOT/live-topology.env"
printf '%s\n' \
    'domain=artworkers.online' \
    "observed_at=$NOW" \
    "controller_observed_at=$NOW" \
    'shell_bluegreen=ready' \
    'canvas_bluegreen=ready' \
    'uploads_bluegreen=ready' \
    'minio_isolation=ready' > "$EVIDENCE"

bash "$CONTROL" record-live-topology --task-id "$TASK_ID" --profile "$PROFILE" \
    --state-root "$STATE_ROOT" --artifact-root "$ARTIFACT_ROOT" --evidence-file "$EVIDENCE" >/dev/null
bash "$CONTROL" assert-live-ready --task-id "$TASK_ID" --profile "$PROFILE" \
    --state-root "$STATE_ROOT" --artifact-root "$ARTIFACT_ROOT" --max-age-seconds 60 >/dev/null
grep -Fx -- '- Current Phase: live-discovery-recorded' "$STATE_ROOT/$TASK_ID/process.md" >/dev/null || fail 'live topology phase'
test "$(rg -c '^## Release State$' "$STATE_ROOT/$TASK_ID/process.md")" = 1 || fail 'duplicate release state section'
test "$(rg -c '^## Live Topology$' "$STATE_ROOT/$TASK_ID/process.md")" = 1 || fail 'duplicate live topology section'

expect_failure 'refresh-live-topology is not allowed at release phase live-discovery-recorded' \
    bash "$CONTROL" refresh-live-topology --task-id "$TASK_ID" --profile "$PROFILE" \
    --state-root "$STATE_ROOT" --artifact-root "$ARTIFACT_ROOT" --evidence-file "$EVIDENCE"

ARCHIVE="$TEST_ROOT/release-artworkers-canvas.image.tar"
printf 'canvas-artifact' > "$ARCHIVE"
ARCHIVE_SHA="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
IMAGE_ID="sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
ARTIFACT_MANIFEST="$TEST_ROOT/manifest.env"
bash "$MANIFEST_SCRIPT" write --output "$ARTIFACT_MANIFEST" --task-id "$TASK_ID" \
    --domain artworkers.online --source-sha "$SOURCE_SHA" --image-tag artworkers.online/canvas:test \
    --image-id "$IMAGE_ID" --archive "$ARCHIVE" --archive-sha256 "$ARCHIVE_SHA" >/dev/null
bash "$MANIFEST_SCRIPT" assert --manifest "$ARTIFACT_MANIFEST" >/dev/null
printf 'tampered' >> "$ARCHIVE"
expect_failure 'artifact archive identity drift' bash "$MANIFEST_SCRIPT" assert --manifest "$ARTIFACT_MANIFEST"

printf 'canvas release-control tests passed\n'
