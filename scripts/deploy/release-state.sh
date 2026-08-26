#!/usr/bin/env bash

set -euo pipefail

MANIFEST=""
PHASE=""
TO_PHASE=""
STATUS=""
EVIDENCE=""
IDEMPOTENT=0

die() {
    printf 'release-state: %s\n' "$*" >&2
    exit 1
}

usage() {
    cat <<'EOF'
Usage:
  scripts/deploy/release-state.sh init --manifest <process.md> --phase source-prepared --evidence <id>
  scripts/deploy/release-state.sh show --manifest <process.md>
  scripts/deploy/release-state.sh assert --manifest <process.md> --phase <phase> [--status <status>]
  scripts/deploy/release-state.sh transition --manifest <process.md> --to <phase> --evidence <id> [--idempotent]
  scripts/deploy/release-state.sh block --manifest <process.md> --evidence <id>
  scripts/deploy/release-state.sh unblock --manifest <process.md> --evidence <id>

The state is stored in the task-local process.md. A transition may only move to
the next phase. Blocking preserves the current phase and prevents transitions
until it is explicitly cleared.
EOF
}

require_value() {
    [ -n "${2:-}" ] || die "missing value for $1"
}

parse_args() {
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --manifest)
                require_value "$1" "${2:-}"
                MANIFEST="$2"
                shift 2
                ;;
            --phase)
                require_value "$1" "${2:-}"
                PHASE="$2"
                shift 2
                ;;
            --to)
                require_value "$1" "${2:-}"
                TO_PHASE="$2"
                shift 2
                ;;
            --status)
                require_value "$1" "${2:-}"
                STATUS="$2"
                shift 2
                ;;
            --evidence)
                require_value "$1" "${2:-}"
                EVIDENCE="$2"
                shift 2
                ;;
            --idempotent)
                IDEMPOTENT=1
                shift
                ;;
            *)
                die "unknown argument: $1"
                ;;
        esac
    done
}

validate_phase() {
    case "$1" in
        source-prepared|composite-prepared|local-preparation-verified|live-discovery-recorded|build-host-preflight|artifacts-built|production-authorized|production-loaded-verified|candidates-healthy|cutover-complete|public-accepted|closed) ;;
        *) die "unknown phase: $1" ;;
    esac
}

validate_status() {
    case "$1" in
        active|blocked|complete) ;;
        *) die "unknown phase status: $1" ;;
    esac
}

validate_evidence() {
    [[ "$EVIDENCE" =~ ^[A-Za-z0-9][A-Za-z0-9._:/=@+-]{0,255}$ ]] || die "evidence must be a single safe identifier"
}

require_manifest() {
    [ -n "$MANIFEST" ] || die "--manifest is required"
    [ -f "$MANIFEST" ] || die "manifest does not exist: $MANIFEST"
}

state_exists() {
    grep -Fqx '## Release State' "$MANIFEST"
}

state_value() {
    local label="$1"
    sed -n "/^## Release State\$/,\$s/^- ${label}: //p" "$MANIFEST" | head -n 1
}

current_phase() {
    local value
    value="$(state_value 'Current Phase')"
    [ -n "$value" ] || die "release state is missing Current Phase"
    validate_phase "$value"
    printf '%s' "$value"
}

current_status() {
    local value
    value="$(state_value 'Phase Status')"
    [ -n "$value" ] || die "release state is missing Phase Status"
    validate_status "$value"
    printf '%s' "$value"
}

next_phase() {
    case "$1" in
        source-prepared) printf 'composite-prepared' ;;
        composite-prepared) printf 'local-preparation-verified' ;;
        local-preparation-verified) printf 'live-discovery-recorded' ;;
        live-discovery-recorded) printf 'build-host-preflight' ;;
        build-host-preflight) printf 'artifacts-built' ;;
        artifacts-built) printf 'production-authorized' ;;
        production-authorized) printf 'production-loaded-verified' ;;
        production-loaded-verified) printf 'candidates-healthy' ;;
        candidates-healthy) printf 'cutover-complete' ;;
        cutover-complete) printf 'public-accepted' ;;
        public-accepted) printf 'closed' ;;
        closed) return 1 ;;
    esac
}

history_lines() {
    awk '
        /^## Release State$/ { state = 1; next }
        state && /^## Transition History$/ { history = 1; next }
        history && /^- / { print }
    ' "$MANIFEST"
}

write_state() {
    local phase="$1" status="$2" evidence="$3" blocking_reason="$4" action="$5"
    local now tmp existing_history manifest_dir
    now="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    existing_history="$(history_lines)"
    manifest_dir="$(cd "$(dirname "$MANIFEST")" && pwd -P)"
    tmp="$(mktemp "$manifest_dir/.release-state.XXXXXX")"
    trap "rm -f '$tmp'" EXIT

    awk '/^## Release State$/ { exit } { print }' "$MANIFEST" >"$tmp"
    {
        printf '\n## Release State\n'
        printf '%s\n' "- Current Phase: $phase"
        printf '%s\n' "- Phase Status: $status"
        printf '%s\n' "- State Evidence: $evidence"
        printf '%s\n' "- Blocking Reason: $blocking_reason"
        printf '%s\n' "- State Updated At: $now"
        printf '\n## Transition History\n'
        [ -z "$existing_history" ] || printf '%s\n' "$existing_history"
        printf '%s\n' "- $now | $action | $phase | evidence=$evidence"
    } >>"$tmp"
    mv "$tmp" "$MANIFEST"
    trap - EXIT
}

show() {
    require_manifest
    state_exists || die "release state is missing; run init after source preparation"
    printf 'current_phase=%s\nphase_status=%s\nstate_evidence=%s\nblocking_reason=%s\n' \
        "$(current_phase)" "$(current_status)" "$(state_value 'State Evidence')" "$(state_value 'Blocking Reason')"
}

initialize() {
    require_manifest
    [ "$PHASE" = 'source-prepared' ] || die "initial phase must be source-prepared"
    validate_evidence
    if state_exists; then
        show
        return
    fi
    write_state "$PHASE" active "$EVIDENCE" none initialized
    show
}

assert_state() {
    require_manifest
    state_exists || die "release state is missing; run init after source preparation"
    validate_phase "$PHASE"
    [ "$(current_phase)" = "$PHASE" ] || die "expected phase $PHASE, found $(current_phase)"
    if [ -n "$STATUS" ]; then
        validate_status "$STATUS"
        [ "$(current_status)" = "$STATUS" ] || die "expected phase status $STATUS, found $(current_status)"
    fi
    show
}

transition() {
    local current status expected target_status
    require_manifest
    state_exists || die "release state is missing; run init after source preparation"
    validate_phase "$TO_PHASE"
    validate_evidence
    current="$(current_phase)"
    status="$(current_status)"
    [ "$status" = active ] || die "state is $status at phase $current; unblock or create a new task before transitioning"
    if [ "$current" = "$TO_PHASE" ] && [ "$IDEMPOTENT" -eq 1 ]; then
        show
        return
    fi
    expected="$(next_phase "$current" || true)"
    [ "$expected" = "$TO_PHASE" ] || die "invalid phase transition: $current -> $TO_PHASE; expected ${expected:-no further phase}"
    target_status=active
    [ "$TO_PHASE" = closed ] && target_status=complete
    write_state "$TO_PHASE" "$target_status" "$EVIDENCE" none transitioned
    show
}

block() {
    local phase status
    require_manifest
    state_exists || die "release state is missing; run init after source preparation"
    validate_evidence
    phase="$(current_phase)"
    status="$(current_status)"
    [ "$status" = active ] || die "state is already $status at phase $phase"
    write_state "$phase" blocked "$EVIDENCE" "$EVIDENCE" blocked
    show
}

unblock() {
    local phase status
    require_manifest
    state_exists || die "release state is missing; run init after source preparation"
    validate_evidence
    phase="$(current_phase)"
    status="$(current_status)"
    [ "$status" = blocked ] || die "state is $status at phase $phase; only blocked states can be unblocked"
    write_state "$phase" active "$EVIDENCE" none unblocked
    show
}

main() {
    local command="${1:-}"
    [ -n "$command" ] || {
        usage
        exit 1
    }
    shift
    parse_args "$@"
    case "$command" in
        init) initialize ;;
        show) show ;;
        assert) assert_state ;;
        transition) transition ;;
        block) block ;;
        unblock) unblock ;;
        -h|--help) usage ;;
        *) die "unknown command: $command" ;;
    esac
}

main "$@"
