#!/usr/bin/env bash

set -euo pipefail

PROBE_UPLOADED=0
PROBE_DELETE_URL=""
PROBE_DOWNLOAD=""

die() {
    printf 'uploads-probe: %s\n' "$*" >&2
    exit 1
}

usage() {
    cat <<'EOF'
Usage:
  scripts/deploy/uploads-probe.sh probe \
    --put-url <signed-url> --get-url <signed-url> \
    --delete-url <signed-url> --payload <file>

The URLs are intentionally explicit so the probe never discovers credentials,
MinIO topology, or a different domain on its own. The probe performs:

  PUT -> GET -> SHA-256 match -> DELETE -> GET 404

The temporary download is removed on every exit. If PUT succeeds, DELETE is
attempted from a trap before the probe reports failure.
EOF
}

require_value() {
    [ -n "${2:-}" ] || die "missing value for $1"
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "required command is missing: $1"
}

validate_url() {
    local url="$1"
    [[ "$url" == http://* || "$url" == https://* ]] || die "URL must use http or https: $url"
    [[ "$url" != *$'\n'* && "$url" != *$'\r'* ]] || die "URL contains a newline"
}

status_is_2xx() {
    [[ "$1" =~ ^2[0-9][0-9]$ ]]
}

status_is_404() {
    [ "$1" = 404 ]
}

request_status() {
    local method="$1" url="$2" output="${3:-/dev/null}"
    if [ "$#" -ge 3 ]; then
        shift 3
    else
        shift 2
    fi
    curl --silent --show-error --request "$method" --output "$output" --write-out '%{http_code}' "$url" "$@"
}

sha256_file() {
    local value
    value="$(sha256sum "$1")"
    printf '%s' "${value%% *}"
}

probe() {
    local put_url="$1" get_url="$2" delete_url="$3" payload="$4"
    local expected_sha download put_status get_status delete_status final_status

    require_command curl
    require_command sha256sum
    require_command mktemp
    [ -f "$payload" ] || die "payload does not exist: $payload"
    [ -r "$payload" ] || die "payload is not readable: $payload"
    validate_url "$put_url"
    validate_url "$get_url"
    validate_url "$delete_url"

    expected_sha="$(sha256_file "$payload")"
    download="$(mktemp "${TMPDIR:-/tmp}/uploads-probe.XXXXXX")"
    PROBE_UPLOADED=0
    PROBE_DOWNLOAD="$download"
    PROBE_DELETE_URL="$delete_url"

    cleanup() {
        if [ "$PROBE_UPLOADED" -eq 1 ]; then
            delete_status="$(request_status DELETE "$PROBE_DELETE_URL")" || delete_status=000
            printf 'cleanup_delete_status=%s\n' "$delete_status" >&2
        fi
        rm -f "$PROBE_DOWNLOAD"
    }
    trap cleanup EXIT

    put_status="$(request_status PUT "$put_url" /dev/null --upload-file "$payload")"
    status_is_2xx "$put_status" || die "PUT returned HTTP $put_status"
    PROBE_UPLOADED=1
    printf 'put_status=%s\n' "$put_status"

    get_status="$(request_status GET "$get_url" "$download")"
    status_is_2xx "$get_status" || die "GET returned HTTP $get_status"
    [ "$(sha256_file "$download")" = "$expected_sha" ] || die "GET body SHA-256 does not match payload"
    printf 'get_status=%s\nsha256=%s\n' "$get_status" "$expected_sha"

    delete_status="$(request_status DELETE "$delete_url")"
    status_is_2xx "$delete_status" || die "DELETE returned HTTP $delete_status"
    PROBE_UPLOADED=0
    printf 'delete_status=%s\n' "$delete_status"

    final_status="$(request_status GET "$get_url" /dev/null)" || final_status=000
    status_is_404 "$final_status" || die "final GET returned HTTP $final_status, expected 404"
    printf 'final_get_status=%s\nresult=pass\n' "$final_status"
}

main() {
    local command="${1:-}" put_url="" get_url="" delete_url="" payload=""
    [ -n "$command" ] || { usage; exit 1; }
    shift
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --put-url) require_value "$1" "${2:-}"; put_url="$2"; shift 2 ;;
            --get-url) require_value "$1" "${2:-}"; get_url="$2"; shift 2 ;;
            --delete-url) require_value "$1" "${2:-}"; delete_url="$2"; shift 2 ;;
            --payload) require_value "$1" "${2:-}"; payload="$2"; shift 2 ;;
            -h|--help) usage; exit 0 ;;
            *) die "unknown argument: $1" ;;
        esac
    done

    case "$command" in
        probe)
            [ -n "$put_url" ] && [ -n "$get_url" ] && [ -n "$delete_url" ] && [ -n "$payload" ] || die "probe requires --put-url, --get-url, --delete-url, and --payload"
            probe "$put_url" "$get_url" "$delete_url" "$payload"
            ;;
        -h|--help) usage ;;
        *) die "unknown command: $command" ;;
    esac
}

main "$@"
