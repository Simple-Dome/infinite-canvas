#!/usr/bin/env bash

# Build one immutable Canvas image on the designated build host.
set -euo pipefail

die() { printf 'build-canvas-artifact: %s\n' "$*" >&2; exit 1; }
need() { [ -n "${2:-}" ] || die "missing value for $1"; }
valid_sha() { [[ "$1" =~ ^[0-9a-f]{64}$ ]]; }
valid_commit() { [[ "$1" =~ ^[0-9a-f]{40}$ ]]; }
valid_image_id() { [[ "$1" =~ ^sha256:[0-9a-f]{64}$ ]]; }
valid_tag() { [[ "$1" =~ ^[A-Za-z0-9._/:@-]+$ ]]; }
valid_abs_path() { [[ "$1" = /* && "$1" != *$'\n'* && "$1" != *$'\r'* && "$1" != *"'"* ]]; }

sha256_file() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    else
        shasum -a 256 "$1" | awk '{print $1}'
    fi
}

usage() {
    cat <<'EOF'
Usage:
  build-canvas-artifact.sh --source-archive PATH --source-sha SHA \
    --source-archive-sha256 SHA --image-tag TAG --archive-output PATH \
    --vite-base PATH --vite-fixed-api-base-url URL --vite-docs-url URL

The source archive must already have been transferred and verified on the
build host. The image is built and loaded locally with linux/amd64, then saved
to an atomically published release-*.image.tar archive.
EOF
}

main() {
    local source_archive="" source_sha="" source_archive_sha="" image_tag="" archive_output=""
    local vite_base="" fixed_api="" docs_url="" context actual archive_sha image_id inspect_output
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --source-archive) need "$1" "${2:-}"; source_archive="$2"; shift 2 ;;
            --source-sha) need "$1" "${2:-}"; source_sha="$2"; shift 2 ;;
            --source-archive-sha256) need "$1" "${2:-}"; source_archive_sha="$2"; shift 2 ;;
            --image-tag) need "$1" "${2:-}"; image_tag="$2"; shift 2 ;;
            --archive-output) need "$1" "${2:-}"; archive_output="$2"; shift 2 ;;
            --vite-base) need "$1" "${2:-}"; vite_base="$2"; shift 2 ;;
            --vite-fixed-api-base-url) need "$1" "${2:-}"; fixed_api="$2"; shift 2 ;;
            --vite-docs-url) need "$1" "${2:-}"; docs_url="$2"; shift 2 ;;
            -h|--help) usage; return 0 ;;
            *) die "unknown option: $1" ;;
        esac
    done
    valid_commit "$source_sha" || die 'source SHA must be a 40-character commit'
    valid_sha "$source_archive_sha" || die 'source archive SHA-256 is invalid'
    valid_tag "$image_tag" || die 'image tag is invalid'
    valid_abs_path "$source_archive" || die 'source archive path must be absolute and safe'
    valid_abs_path "$archive_output" || die 'archive output path must be absolute and safe'
    [ -f "$source_archive" ] || die 'source archive is missing'
    [ "$(sha256_file "$source_archive")" = "$source_archive_sha" ] || die 'source archive identity drift'
    [[ "$vite_base" = /*/ ]] || die 'VITE_BASE must be an absolute subpath'
    [[ "$fixed_api" = https://* ]] || die 'VITE_FIXED_API_BASE_URL must be HTTPS'
    [[ "$docs_url" = https://* ]] || die 'VITE_DOCS_URL must be HTTPS'
    context="$(dirname "$source_archive")/source-context-$source_sha"
    [ ! -e "$context" ] || die "source context already exists: $context"
    mkdir -p "$context" "$(dirname "$archive_output")"
    tar -xf "$source_archive" -C "$context"
    [ -f "$context/Dockerfile" ] || die 'source archive has no Dockerfile'
    [ -f "$context/web/package.json" ] || die 'source archive has no Canvas web package'
    docker buildx build --platform linux/amd64 --load \
        --file "$context/Dockerfile" \
        --tag "$image_tag" \
        --build-arg "VITE_BASE=$vite_base" \
        --build-arg "VITE_FIXED_API_BASE_URL=$fixed_api" \
        --build-arg "VITE_DOCS_URL=$docs_url" \
        "$context"
    inspect_output="$(docker image inspect "$image_tag" --format 'id={{.Id}} os={{.Os}} arch={{.Architecture}}')"
    case "$inspect_output" in
        id=sha256:*\ os=linux\ arch=amd64) ;;
        *) die "built image is not linux/amd64: $inspect_output" ;;
    esac
    image_id="${inspect_output#id=}"; image_id="${image_id%% os=*}"
    valid_image_id "$image_id" || die 'docker image identity is invalid'
    [ ! -e "$archive_output" ] || die "archive output already exists: $archive_output"
    docker save "$image_tag" > "$archive_output.partial"
    archive_sha="$(sha256_file "$archive_output.partial")"
    mv "$archive_output.partial" "$archive_output"
    printf 'source_sha=%s\nsource_archive_sha256=%s\nimage_tag=%s\nimage_id=%s\nplatform=linux/amd64\narchive=%s\narchive_sha256=%s\nstatus=verified\n' \
        "$source_sha" "$source_archive_sha" "$image_tag" "$image_id" "$archive_output" "$archive_sha"
}

main "$@"
