#!/usr/bin/env bash

set -euo pipefail

DEFAULT_CHUNK_BYTES=3145728
SSH_BIN="${SSH_BIN:-ssh}"
TRANSFER_CHUNK_DIR=""

die() {
    printf 'remote-release-helper: %s\n' "$*" >&2
    exit 1
}

usage() {
    cat <<'EOF'
Usage:
  scripts/deploy/remote-release-helper.sh transfer-archive \
    --remote <user@host> --remote-dir <absolute-path> --archive <path> \
    [--chunk-bytes <bytes>]
  scripts/deploy/remote-release-helper.sh run-transaction \
    --remote <user@host> --script <path> --remote-script <absolute-path>

The helper uses one data-only SSH stream per chunk or script. All control
commands use ssh -n, so a control command can never consume the next payload.
Remote .partial files are fail-closed: remove them only after investigating the
failed transfer, then retry the exact release directory.
EOF
}

require_value() {
    [ -n "${2:-}" ] || die "missing value for $1"
}

validate_remote_path() {
    local value="$1"
    [[ "$value" == /* ]] || die "remote path must be absolute: $value"
    [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "remote path contains a newline"
    [[ "$value" != *"'"* ]] || die "remote path cannot contain a single quote"
}

validate_archive_path() {
    [ -f "$1" ] || die "archive/script does not exist: $1"
    [ -r "$1" ] || die "archive/script is not readable: $1"
}

shell_quote() {
    local value="$1"
    value="${value//\'/\'\\\'\'}"
    printf "'%s'" "$value"
}

sha256_file() {
    local path="$1"
    if command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$path" | awk '{print $1}'
    else
        sha256sum "$path" | awk '{print $1}'
    fi
}

base64_encode() {
    local path="$1"
    if [ "$(uname -s)" = Darwin ]; then
        base64 -i "$path"
    else
        base64 "$path"
    fi
}

remote_exec() {
    local remote="$1"
    local command="$2"
    "$SSH_BIN" -n "$remote" "$command"
}

remote_data() {
    local remote="$1"
    local command="$2"
    "$SSH_BIN" "$remote" "$command"
}

make_chunks() {
    local archive="$1"
    local chunk_dir="$2"
    local chunk_bytes="$3"
    local index=0 chunk size

    while :; do
        chunk="$chunk_dir/chunk-$(printf '%08d' "$index")"
        dd if="$archive" of="$chunk" bs="$chunk_bytes" count=1 skip="$index" 2>/dev/null || die "failed to read archive chunk $index"
        size="$(wc -c < "$chunk" | tr -d '[:space:]')"
        if [ "$size" = 0 ]; then
            rm -f "$chunk"
            break
        fi
        index=$((index + 1))
    done

    [ "$index" -gt 0 ] || die "archive is empty"
}

transfer_archive() {
    local remote="$1"
    local remote_dir="$2"
    local archive="$3"
    local chunk_bytes="$4"
    local archive_name archive_size archive_sha chunk_dir manifest state
    local chunk chunk_name chunk_size chunk_sha destination partial prefix_q
    local remote_archive
    local index=0

    validate_remote_path "$remote_dir"
    validate_archive_path "$archive"
    [[ "$chunk_bytes" =~ ^[0-9]+$ && "$chunk_bytes" -gt 0 ]] || die "chunk bytes must be a positive integer"

    archive_name="$(basename "$archive")"
    [[ "$archive_name" != *"'"* && "$archive_name" != *$'\n'* ]] || die "archive name contains unsupported characters"
    archive_size="$(wc -c < "$archive" | tr -d '[:space:]')"
    archive_sha="$(sha256_file "$archive")"
    remote_archive="$remote_dir/$archive_name"
    manifest="$archive.transfer.tsv"
    chunk_dir="$(mktemp -d "${TMPDIR:-/tmp}/remote-release-chunks.XXXXXX")"

    TRANSFER_CHUNK_DIR="$chunk_dir"
    trap 'if [ -n "${TRANSFER_CHUNK_DIR:-}" ]; then rm -rf -- "$TRANSFER_CHUNK_DIR"; fi' EXIT

    make_chunks "$archive" "$chunk_dir" "$chunk_bytes"
    : > "$manifest"

    state="$(remote_exec "$remote" "set -eu; stage=$(shell_quote "$remote_dir"); archive=$(shell_quote "$remote_archive"); mkdir -p \"\$stage\"; if find \"\$stage\" -maxdepth 1 -type f -name '*.partial' -print -quit | grep -q .; then printf 'partial_present\\n' >&2; exit 75; fi; if [ -e \"\$archive\" ]; then [ -f \"\$archive\" ] || exit 75; size=\$(wc -c < \"\$archive\" | tr -d '[:space:]'); sha=\$(sha256sum \"\$archive\" | awk '{print \$1}'); [ \"\$size\" = $(shell_quote "$archive_size") ] && [ \"\$sha\" = $(shell_quote "$archive_sha") ] || exit 75; printf 'archive_verified'; else printf 'archive_missing'; fi")"
    if [ "$state" = archive_verified ]; then
        printf 'archive=%s\narchive_sha256=%s\nstatus=already-verified\n' "$archive" "$archive_sha"
        return 0
    fi
    [ "$state" = archive_missing ] || die "unexpected remote preflight result: $state"

    for chunk in "$chunk_dir"/chunk-*; do
        chunk_name="$(basename "$chunk")"
        chunk_size="$(wc -c < "$chunk" | tr -d '[:space:]')"
        chunk_sha="$(sha256_file "$chunk")"
        printf '%s\t%s\t%s\n' "$chunk_name" "$chunk_size" "$chunk_sha" >> "$manifest"
        destination="$remote_dir/$archive_name.$chunk_name"
        partial="$destination.partial"

        state="$(remote_exec "$remote" "set -eu; destination=$(shell_quote "$destination"); partial=$(shell_quote "$partial"); if [ -e \"\$partial\" ]; then exit 75; fi; if [ -f \"\$destination\" ]; then size=\$(wc -c < \"\$destination\" | tr -d '[:space:]'); sha=\$(sha256sum \"\$destination\" | awk '{print \$1}'); [ \"\$size\" = $(shell_quote "$chunk_size") ] && [ \"\$sha\" = $(shell_quote "$chunk_sha") ] || exit 75; printf 'chunk_verified'; else printf 'chunk_missing'; fi")"
        case "$state" in
            chunk_verified)
                printf 'chunk=%s status=already-verified\n' "$chunk_name"
                ;;
            chunk_missing)
                base64_encode "$chunk" | remote_data "$remote" "umask 077; base64 --decode > $(shell_quote "$partial")"
                remote_exec "$remote" "set -eu; destination=$(shell_quote "$destination"); partial=$(shell_quote "$partial"); size=\$(wc -c < \"\$partial\" | tr -d '[:space:]'); sha=\$(sha256sum \"\$partial\" | awk '{print \$1}'); [ \"\$size\" = $(shell_quote "$chunk_size") ] && [ \"\$sha\" = $(shell_quote "$chunk_sha") ] || exit 75; mv \"\$partial\" \"\$destination\""
                printf 'chunk=%s status=transferred size=%s sha256=%s\n' "$chunk_name" "$chunk_size" "$chunk_sha"
                ;;
            *)
                die "unexpected remote chunk state for $chunk_name: $state"
                ;;
        esac
        index=$((index + 1))
    done

    prefix_q="$(shell_quote "$remote_dir/$archive_name.chunk-")"
    remote_exec "$remote" "set -eu; archive=$(shell_quote "$remote_archive"); partial=\"\$archive.partial\"; cat ${prefix_q}* > \"\$partial\"; size=\$(wc -c < \"\$partial\" | tr -d '[:space:]'); sha=\$(sha256sum \"\$partial\" | awk '{print \$1}'); [ \"\$size\" = $(shell_quote "$archive_size") ] && [ \"\$sha\" = $(shell_quote "$archive_sha") ] || exit 75; mv \"\$partial\" \"\$archive\"; rm -f ${prefix_q}*"
    printf 'archive=%s\narchive_sha256=%s\nchunks=%s\nmanifest=%s\nstatus=transferred-and-verified\n' "$archive" "$archive_sha" "$index" "$manifest"
    rm -rf "$chunk_dir"
    TRANSFER_CHUNK_DIR=""
}

run_transaction() {
    local remote="$1"
    local script="$2"
    local remote_script="$3"
    local script_size script_sha partial

    validate_remote_path "$remote_script"
    validate_archive_path "$script"
    script_size="$(wc -c < "$script" | tr -d '[:space:]')"
    script_sha="$(sha256_file "$script")"
    partial="$remote_script.partial"

    remote_exec "$remote" "set -eu; script=$(shell_quote "$remote_script"); partial=$(shell_quote "$partial"); if [ -e \"\$script\" ] || [ -e \"\$partial\" ]; then printf 'transaction-script-exists\\n' >&2; exit 75; fi; mkdir -p \"\$(dirname \"\$script\")\""
    base64_encode "$script" | remote_data "$remote" "umask 077; base64 --decode > $(shell_quote "$partial")"
    remote_exec "$remote" "set -eu; script=$(shell_quote "$remote_script"); partial=$(shell_quote "$partial"); size=\$(wc -c < \"\$partial\" | tr -d '[:space:]'); sha=\$(sha256sum \"\$partial\" | awk '{print \$1}'); [ \"\$size\" = $(shell_quote "$script_size") ] && [ \"\$sha\" = $(shell_quote "$script_sha") ] || exit 75; mv \"\$partial\" \"\$script\""
    remote_exec "$remote" "bash $(shell_quote "$remote_script")"
    printf 'remote_script=%s\nscript_sha256=%s\nstatus=executed\n' "$remote_script" "$script_sha"
}

main() {
    local command="${1:-}" remote="" remote_dir="" archive="" script="" remote_script="" chunk_bytes="$DEFAULT_CHUNK_BYTES"
    [ -n "$command" ] || { usage; exit 1; }
    shift
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --remote) require_value "$1" "${2:-}"; remote="$2"; shift 2 ;;
            --remote-dir) require_value "$1" "${2:-}"; remote_dir="$2"; shift 2 ;;
            --archive) require_value "$1" "${2:-}"; archive="$2"; shift 2 ;;
            --script) require_value "$1" "${2:-}"; script="$2"; shift 2 ;;
            --remote-script) require_value "$1" "${2:-}"; remote_script="$2"; shift 2 ;;
            --chunk-bytes) require_value "$1" "${2:-}"; chunk_bytes="$2"; shift 2 ;;
            -h|--help) usage; exit 0 ;;
            *) die "unknown argument: $1" ;;
        esac
    done

    case "$command" in
        transfer-archive)
            [ -n "$remote" ] && [ -n "$remote_dir" ] && [ -n "$archive" ] || die "transfer-archive requires --remote, --remote-dir, and --archive"
            transfer_archive "$remote" "$remote_dir" "$archive" "$chunk_bytes"
            ;;
        run-transaction)
            [ -n "$remote" ] && [ -n "$script" ] && [ -n "$remote_script" ] || die "run-transaction requires --remote, --script, and --remote-script"
            run_transaction "$remote" "$script" "$remote_script"
            ;;
        -h|--help) usage ;;
        *) die "unknown command: $command" ;;
    esac
}

main "$@"
