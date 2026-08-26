#!/usr/bin/env bash

# Load one verified Canvas image and start the inactive Artwork color.
set -euo pipefail

die() { printf 'load-canvas-candidate: %s\n' "$*" >&2; exit 1; }
need() { [ -n "${2:-}" ] || die "missing value for $1"; }
valid_port() { [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -ge 1024 ] && [ "$1" -le 65535 ]; }
valid_name() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]]; }
valid_path() { [[ "$1" = /* && "$1" != *$'\n'* && "$1" != *$'\r'* && "$1" != *"'"* ]]; }

field() {
    local key="$1" file="$2" value
    value="$(awk -F= -v key="$key" '$1 == key { value=substr($0, length(key)+2) } END { print value }' "$file")"
    [ -n "$value" ] || die "manifest field is missing: $key"
    printf '%s' "$value"
}

usage() {
    cat <<'EOF'
Usage:
  load-canvas-candidate.sh --manifest PATH --container NAME --port PORT \
    --network NAME --health-url URL --base-path PATH --docs-url URL \
    --uploads-public-base URL

The manifest and archive must already be present on the production host. The
active Blue container and Nginx are untouched. The previous inactive color is
renamed to a stopped rollback container before the candidate starts.
EOF
}

main() {
    local manifest="" container="" port="" network="" health_url="" base_path="" docs_url="" uploads_base=""
    local script_dir manifest_script image_tag image_id archive archive_sha inspect_output rollback_name old_container=0
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --manifest) need "$1" "${2:-}"; manifest="$2"; shift 2 ;;
            --container) need "$1" "${2:-}"; container="$2"; shift 2 ;;
            --port) need "$1" "${2:-}"; port="$2"; shift 2 ;;
            --network) need "$1" "${2:-}"; network="$2"; shift 2 ;;
            --health-url) need "$1" "${2:-}"; health_url="$2"; shift 2 ;;
            --base-path) need "$1" "${2:-}"; base_path="$2"; shift 2 ;;
            --docs-url) need "$1" "${2:-}"; docs_url="$2"; shift 2 ;;
            --uploads-public-base) need "$1" "${2:-}"; uploads_base="$2"; shift 2 ;;
            -h|--help) usage; return 0 ;;
            *) die "unknown option: $1" ;;
        esac
    done
    [ "${PRODUCTION_RELEASE_AUTHORIZED:-}" = yes ] || die 'PRODUCTION_RELEASE_AUTHORIZED=yes is required'
    valid_path "$manifest" || die 'manifest path is invalid'
    valid_name "$container" || die 'container name is invalid'
    valid_name "$network" || die 'network name is invalid'
    valid_port "$port" || die 'candidate port is invalid'
    [ -f "$manifest" ] || die 'manifest is missing'
    [[ "$health_url" = http://127.0.0.1:"$port"/* ]] || die 'health URL must target the candidate loopback port'
    [[ "$base_path" = /*/ ]] || die 'base path must be an absolute subpath'
    [[ "$docs_url" = https://artworkers.online/* ]] || die 'docs URL must stay on the selected domain'
    [[ "$uploads_base" = https://artworkers.online/* ]] || die 'uploads base must stay on the selected domain'

    script_dir="$(cd "$(dirname "$0")" && pwd -P)"
    manifest_script="$script_dir/canvas-artifact-manifest.sh"
    [ -f "$manifest_script" ] || die 'canvas-artifact-manifest.sh is not installed beside the transaction'
    bash "$manifest_script" assert --manifest "$manifest" >/dev/null
    image_tag="$(field image_tag "$manifest")"
    image_id="$(field image_id "$manifest")"
    archive="$(field archive "$manifest")"
    archive_sha="$(field archive_sha256 "$manifest")"
    [ -f "$archive" ] || die 'artifact archive is missing'
    [ "$(sha256sum "$archive" | awk '{print $1}')" = "$archive_sha" ] || die 'artifact archive SHA-256 drift'

    docker load < "$archive" >/dev/null
    inspect_output="$(docker image inspect "$image_tag" --format 'id={{.Id}} os={{.Os}} arch={{.Architecture}}')"
    [ "$inspect_output" = "id=$image_id os=linux arch=amd64" ] || die "loaded image identity mismatch: $inspect_output"

    rollback_name="${container}-predeploy-$(date -u +%Y%m%d%H%M%S)"
    if docker inspect "$container" >/dev/null 2>&1; then
        old_container=1
        docker inspect "$container" >/dev/null
        docker stop "$container" >/dev/null
        docker rename "$container" "$rollback_name"
    fi

    rollback() {
        local status=$?
        if [ "$status" -ne 0 ]; then
            docker rm -f "$container" >/dev/null 2>&1 || true
            if [ "$old_container" -eq 1 ] && docker inspect "$rollback_name" >/dev/null 2>&1; then
                docker rename "$rollback_name" "$container" >/dev/null
                docker start "$container" >/dev/null
            fi
        fi
        exit "$status"
    }
    trap rollback EXIT

    docker run --detach --name "$container" --network "$network" --restart unless-stopped \
        --publish "127.0.0.1:$port:3000" \
        --env "NEXT_BASE_PATH=${base_path%/}" \
        --env "NEXT_PUBLIC_DOC_URL=$docs_url" \
        --env "UPLOAD_PUBLIC_BASE=$uploads_base" \
        "$image_tag" >/dev/null

    for attempt in $(seq 1 60); do
        [ "$(docker inspect -f '{{.State.Running}}' "$container")" = true ] || die 'candidate container is not running'
        status="$(curl --silent --show-error --max-time 5 -o /dev/null -w '%{http_code}' "$health_url" || true)"
        if [ "$status" = 200 ]; then break; fi
        [ "$attempt" -lt 60 ] || die "candidate health returned HTTP $status"
        sleep 1
    done
    [ "$(docker port "$container" 3000/tcp)" = "127.0.0.1:$port" ] || die 'candidate port mapping mismatch'
    trap - EXIT
    printf 'image_tag=%s\nimage_id=%s\narchive=%s\narchive_sha256=%s\ncandidate=%s\ncandidate_port=%s\nrollback_container=%s\nhealth_url=%s\nstatus=healthy\n' \
        "$image_tag" "$image_id" "$archive" "$archive_sha" "$container" "$port" "${rollback_name:-none}" "$health_url"
}

main "$@"
