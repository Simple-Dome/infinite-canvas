#!/usr/bin/env bash

# A domain build produces one Canvas image whose source and archive are immutable.
set -euo pipefail

die() { printf 'canvas-artifact-manifest: %s\n' "$*" >&2; exit 1; }
need() { [ -n "${2:-}" ] || die "missing value for $1"; }
valid_commit() { [[ "$1" =~ ^[0-9a-f]{40}$ ]]; }
valid_digest() { [[ "$1" =~ ^[0-9a-f]{64}$ ]]; }
valid_image() { [[ "$1" =~ ^sha256:[0-9a-f]{64}$ ]]; }
valid_task() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; }
valid_domain() { [[ "$1" =~ ^[a-z0-9][a-z0-9.-]*[a-z0-9]$ ]]; }
valid_archive() { [[ "$1" =~ ^/[A-Za-z0-9._/-]*/release-[A-Za-z0-9._-]+\.image\.tar$ ]]; }
value() { awk -F= -v key="$1" '$1 == key { result=substr($0, length(key) + 2) } END { print result }' "$2"; }
field() { local v; v="$(value "$1" "$2")"; [ -n "$v" ] || die "missing manifest field: $1"; printf '%s' "$v"; }
sha256_file() {
    if command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    else
        sha256sum "$1" | awk '{print $1}'
    fi
}

write() {
    local output="" task_id="" domain="" source_sha="" tag="" image_id="" archive="" archive_sha=""
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --output|--task-id|--domain|--source-sha|--image-tag|--image-id|--archive|--archive-sha256)
                need "$1" "${2:-}"
                case "$1" in
                    --output) output="$2" ;; --task-id) task_id="$2" ;; --domain) domain="$2" ;;
                    --source-sha) source_sha="$2" ;; --image-tag) tag="$2" ;; --image-id) image_id="$2" ;;
                    --archive) archive="$2" ;; --archive-sha256) archive_sha="$2" ;;
                esac
                shift 2 ;;
            *) die "unknown option: $1" ;;
        esac
    done
    valid_task "$task_id" || die 'invalid task id'
    valid_domain "$domain" || die 'invalid domain'
    valid_commit "$source_sha" || die 'invalid source SHA'
    valid_image "$image_id" || die 'invalid image ID'
    valid_digest "$archive_sha" || die 'invalid archive SHA-256'
    valid_archive "$archive" || die 'invalid archive path'
    [[ "$tag" =~ ^[A-Za-z0-9._/:@-]+$ ]] || die 'invalid image tag'
    mkdir -p "$(dirname "$output")"
    umask 077
    cat > "$output" <<EOF
manifest_version=1
task_id=$task_id
domain=$domain
source_sha=$source_sha
identity=$domain|$task_id|$source_sha
image_tag=$tag
image_id=$image_id
image_lock=production-image-${image_id#sha256:}
archive=$archive
archive_sha256=$archive_sha
build_lock=build-artifact:canvas:$domain:$source_sha
docker_load_lock=production-docker-load-global
domain_lock=production-domain-$domain
nginx_lock=production-nginx-global
EOF
    assert "$output"
    printf 'manifest=%s\nidentity=%s\nstatus=verified\n' "$output" "$domain|$task_id|$source_sha"
}

assert() {
    local manifest="$1" task_id domain source_sha image_id
    [ -f "$manifest" ] || die 'manifest does not exist'
    [ "$(field manifest_version "$manifest")" = 1 ] || die 'unsupported manifest version'
    task_id="$(field task_id "$manifest")"
    domain="$(field domain "$manifest")"
    source_sha="$(field source_sha "$manifest")"
    image_id="$(field image_id "$manifest")"
    valid_task "$task_id" || die 'invalid task id'
    valid_domain "$domain" || die 'invalid domain'
    valid_commit "$source_sha" || die 'invalid source SHA'
    valid_image "$image_id" || die 'invalid image ID'
    [ "$(field identity "$manifest")" = "$domain|$task_id|$source_sha" ] || die 'artifact identity drift'
    [ "$(field image_lock "$manifest")" = "production-image-${image_id#sha256:}" ] || die 'image lock identity drift'
    [ "$(field build_lock "$manifest")" = "build-artifact:canvas:$domain:$source_sha" ] || die 'build lock identity drift'
    [ "$(field docker_load_lock "$manifest")" = production-docker-load-global ] || die 'Docker load lock identity drift'
    [ "$(field domain_lock "$manifest")" = "production-domain-$domain" ] || die 'domain lock identity drift'
    [ "$(field nginx_lock "$manifest")" = production-nginx-global ] || die 'Nginx lock identity drift'
    local archive archive_sha actual_sha
    archive="$(field archive "$manifest")"
    archive_sha="$(field archive_sha256 "$manifest")"
    valid_archive "$archive" || die 'invalid archive path'
    valid_digest "$archive_sha" || die 'invalid archive SHA-256'
    [ -f "$archive" ] || die 'artifact archive is missing'
    actual_sha="$(sha256_file "$archive")"
    [ "$actual_sha" = "$archive_sha" ] || die 'artifact archive identity drift'
    printf 'identity=%s\nlocks=verified\nstatus=verified\n' "$(field identity "$manifest")"
}

case "${1:-}" in
    write) shift; write "$@" ;;
    assert)
        shift
        [ "${1:-}" = --manifest ] || die 'usage: canvas-artifact-manifest.sh assert --manifest PATH'
        assert "${2:-}" ;;
    *) die 'usage: canvas-artifact-manifest.sh write ... | assert --manifest PATH' ;;
esac
