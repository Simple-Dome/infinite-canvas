#!/usr/bin/env bash

# Generic Canvas release source contract. The domain comes from a release-worktree profile.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(git -C "$SCRIPT_DIR/../.." rev-parse --show-toplevel)"
TASK_ID=""
PROFILE=""
STATE_ROOT="$REPO_ROOT/.agents/state/tasks"
ARTIFACT_ROOT="$REPO_ROOT/.agents/release-artifacts"
WORKTREE_ROOT="$REPO_ROOT/.agents/release-worktrees"
DOMAIN=""
EVIDENCE_FILE=""
MAX_AGE_SECONDS="1800"
MAX_CLOCK_SKEW_SECONDS="300"

die() { printf 'canvas-release-control: %s\n' "$*" >&2; exit 1; }
need() { [ -n "${2:-}" ] || die "missing value for $1"; }
valid_task() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; }
valid_commit() { [[ "$1" =~ ^[0-9a-f]{40}$ ]]; }
valid_domain() { [[ "$1" =~ ^[a-z0-9][a-z0-9.-]*[a-z0-9]$ ]]; }

usage() {
    cat <<'EOF'
Usage:
  canvas-release-control.sh prepare --task-id ID --profile PATH --source-ref SHA
  canvas-release-control.sh prepare-worktree --task-id ID --profile PATH --source-ref SHA
  canvas-release-control.sh assert-source --task-id ID --profile PATH
  canvas-release-control.sh build-plan --task-id ID --profile PATH
  canvas-release-control.sh record-live-topology --task-id ID --profile PATH --evidence-file PATH
  canvas-release-control.sh refresh-live-topology --task-id ID --profile PATH --evidence-file PATH
  canvas-release-control.sh assert-live-ready --task-id ID --profile PATH [--max-age-seconds N]

The checked-out Canvas source stays domain-neutral. A worktree-local profile
supplies the domain, Vite build values, public path, ports, and Nginx snippets.
EOF
}

parse_common() {
    REMAINING=()
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --task-id) need "$1" "${2:-}"; TASK_ID="$2"; shift 2 ;;
            --profile) need "$1" "${2:-}"; PROFILE="$2"; shift 2 ;;
            --repo-root) need "$1" "${2:-}"; REPO_ROOT="$2"; shift 2 ;;
            --state-root) need "$1" "${2:-}"; STATE_ROOT="$2"; shift 2 ;;
            --artifact-root) need "$1" "${2:-}"; ARTIFACT_ROOT="$2"; shift 2 ;;
            --worktree-root) need "$1" "${2:-}"; WORKTREE_ROOT="$2"; shift 2 ;;
            --domain) need "$1" "${2:-}"; DOMAIN="$2"; shift 2 ;;
            --evidence-file) need "$1" "${2:-}"; EVIDENCE_FILE="$2"; shift 2 ;;
            --max-age-seconds) need "$1" "${2:-}"; MAX_AGE_SECONDS="$2"; shift 2 ;;
            --max-clock-skew-seconds) need "$1" "${2:-}"; MAX_CLOCK_SKEW_SECONDS="$2"; shift 2 ;;
            *) REMAINING+=("$1"); shift ;;
        esac
    done
    valid_task "$TASK_ID" || die 'invalid task id'
    [ -f "$PROFILE" ] || die 'profile is missing'
    REPO_ROOT="$(cd "$REPO_ROOT" && pwd -P)"
}

profile_value() {
    local key="$1" count value
    count="$(grep -c "^${key}=" "$PROFILE" || true)"
    [ "$count" = 1 ] || die "profile must contain exactly one $key"
    value="$(sed -n "s/^${key}=//p" "$PROFILE")"
    [[ "$value" != *$'\n'* && "$value" != *$'\r'* && -n "$value" ]] || die "invalid profile value for $key"
    printf '%s' "$value"
}

load_profile() {
    DOMAIN="$(profile_value DOMAIN)"
    VITE_BASE="$(profile_value VITE_BASE)"
    VITE_FIXED_API_BASE_URL="$(profile_value VITE_FIXED_API_BASE_URL)"
    VITE_DOCS_URL="$(profile_value VITE_DOCS_URL)"
    CANVAS_PUBLIC_PATH="$(profile_value CANVAS_PUBLIC_PATH)"
    valid_domain "$DOMAIN" || die 'invalid profile domain'
    [ "$VITE_FIXED_API_BASE_URL" = "https://$DOMAIN" ] || die 'profile API URL must match profile domain'
    [[ "$VITE_BASE" = /*/ && "$CANVAS_PUBLIC_PATH" = /* ]] || die 'profile Canvas paths must be absolute'
    [[ "$VITE_DOCS_URL" == "https://$DOMAIN/"* ]] || die 'profile docs URL must stay on selected domain'
}

state_dir() { printf '%s/%s' "$STATE_ROOT" "$TASK_ID"; }
source_record() { printf '%s/canvas-source.env' "$(state_dir)"; }
read_record() { awk -F= -v key="$1" '$1 == key { value=substr($0,length(key)+2) } END { print value }' "$(source_record)"; }
process_manifest() { printf '%s/process.md' "$(state_dir)"; }

state_phase() {
    "$SCRIPT_DIR/release-state.sh" show --manifest "$(process_manifest)" | sed -n 's/^current_phase=//p'
}

state_transition() {
    local target="$1" evidence="$2"
    "$SCRIPT_DIR/release-state.sh" transition --manifest "$(process_manifest)" --to "$target" --evidence "$evidence" >/dev/null
}

evidence_value() {
    local key="$1" count
    count="$(grep -c "^${key}=" "$EVIDENCE_FILE" || true)"
    [ "$count" = 1 ] || die "live topology evidence must contain exactly one $key entry"
    sed -n "s/^${key}=//p" "$EVIDENCE_FILE"
}

optional_evidence_value() {
    local key="$1" count
    count="$(grep -c "^${key}=" "$EVIDENCE_FILE" || true)"
    [ "$count" -le 1 ] || die "live topology evidence must contain at most one $key entry"
    [ "$count" = 1 ] && sed -n "s/^${key}=//p" "$EVIDENCE_FILE" || true
}

validate_timestamp() {
    local value="$1"
    [[ "$value" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || die 'topology timestamp must be UTC RFC 3339'
    python3 - "$value" <<'PY' >/dev/null || die 'topology timestamp is invalid'
from datetime import datetime
import sys
datetime.strptime(sys.argv[1], "%Y-%m-%dT%H:%M:%SZ")
PY
}

timestamp_epoch() {
    python3 - "$1" <<'PY'
from datetime import datetime, timezone
import sys
print(int(datetime.strptime(sys.argv[1], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()))
PY
}

timestamp_skew() {
    local left right
    left="$(timestamp_epoch "$1")"; right="$(timestamp_epoch "$2")"
    python3 - "$left" "$right" <<'PY'
import sys
print(abs(int(sys.argv[1]) - int(sys.argv[2])))
PY
}

topology_status_value() {
    case "$1" in ready|not-ready|unknown) printf '%s' "$1" ;; *) die 'topology checks must be ready, not-ready, or unknown' ;; esac
}

topology_age() {
    python3 - "$1" <<'PY'
from datetime import datetime, timezone
import sys
observed = datetime.strptime(sys.argv[1], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
print(int((datetime.now(timezone.utc) - observed).total_seconds()))
PY
}

write_live_topology() {
    local status="$1" domain="$2" evidence_sha="$3" observed_at="$4" controller_at="$5" skew="$6"
    local shell_status="$7" canvas_status="$8" uploads_status="$9" minio_status="${10}"
    local manifest tmp live_section inserted=0
    manifest="$(process_manifest)"
    tmp="$(mktemp "$(state_dir)/.live-topology.XXXXXX")"
    live_section="$(mktemp "$(state_dir)/.live-section.XXXXXX")"
    {
        printf '## Live Topology\n'
        printf '%s\n' "- Live Status: $status" "- Discovery Domain: $domain" "- Evidence SHA-256: $evidence_sha" "- Observed At: $observed_at" "- Controller Observed At: $controller_at" "- Clock Skew Seconds: $skew" "- Shell Blue/Green: $shell_status" "- Canvas Blue/Green: $canvas_status" "- Uploads Blue/Green: $uploads_status" "- MinIO Isolation: $minio_status"
        printf '\n'
    } > "$live_section"
    awk -v section="$live_section" '
        /^## Live Topology$/ { skip=1; next }
        skip && /^## Release State$/ { while ((getline line < section) > 0) print line; close(section); inserted=1; skip=0; print; next }
        !skip && /^## Release State$/ && !inserted { while ((getline line < section) > 0) print line; close(section); inserted=1; print; next }
        skip { next }
        { print }
        END { if (!inserted) { while ((getline line < section) > 0) print line; close(section) } }
    ' "$manifest" > "$tmp"
    mv "$tmp" "$manifest"
    rm -f "$live_section"
}

prepare_worktree() {
    parse_common "$@"
    set -- "${REMAINING[@]}"
    local source_ref="" source_sha worktree profile_path
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --source-ref) need "$1" "${2:-}"; source_ref="$2"; shift 2 ;;
            *) die "unknown option: $1" ;;
        esac
    done
    profile_path="$(cd "$(dirname "$PROFILE")" && pwd -P)/$(basename "$PROFILE")"
    load_profile
    valid_commit "$source_ref" || die 'source ref must be a 40-character SHA'
    source_sha="$(git -C "$REPO_ROOT" rev-parse --verify "${source_ref}^{commit}")"
    git -C "$REPO_ROOT" merge-base --is-ancestor origin/main "$source_sha" || die 'source ref is not based on origin/main'
    worktree="$WORKTREE_ROOT/$TASK_ID"
    mkdir -p "$WORKTREE_ROOT"
    if [ -e "$worktree" ]; then
        [ -d "$worktree" ] || die 'release worktree path is not a directory'
        git -C "$worktree" symbolic-ref -q HEAD >/dev/null && die 'prepared worktree must be detached'
        [ "$(git -C "$worktree" rev-parse HEAD)" = "$source_sha" ] || die 'existing release worktree source differs'
        [ -z "$(git -C "$worktree" status --porcelain --untracked-files=all)" ] || die 'prepared release worktree is dirty'
    else
        git -C "$REPO_ROOT" worktree add --detach "$worktree" "$source_sha" >/dev/null
    fi
    prepare --task-id "$TASK_ID" --profile "$profile_path" --source-ref "$source_sha" --repo-root "$worktree" --state-root "$STATE_ROOT" --artifact-root "$ARTIFACT_ROOT"
    printf 'worktree=%s\n' "$worktree" >> "$(source_record)"
    printf 'prepared_worktree=%s\nsource_sha=%s\nstatus=prepared\n' "$worktree" "$source_sha"
}

record_live_topology() {
    local mode="$1"
    parse_common "${@:2}"
    [ "${#REMAINING[@]}" = 0 ] || die "unknown option: ${REMAINING[0]}"
    load_profile
    [ -f "$(process_manifest)" ] || die 'run prepare first'
    [ -f "$EVIDENCE_FILE" ] || die 'live topology evidence is missing'
    local discovery_domain observed_at controller_at skew shell_status canvas_status uploads_status minio_status evidence_sha status phase
    discovery_domain="$(evidence_value domain)"
    [ "$discovery_domain" = "$DOMAIN" ] || die 'live topology evidence domain does not match profile'
    observed_at="$(evidence_value observed_at)"; validate_timestamp "$observed_at"
    controller_at="$(optional_evidence_value controller_observed_at)"
    if [ -n "$controller_at" ]; then
        validate_timestamp "$controller_at"
        [[ "$MAX_CLOCK_SKEW_SECONDS" =~ ^[0-9]+$ ]] || die 'max clock skew seconds must be non-negative'
        skew="$(timestamp_skew "$observed_at" "$controller_at")"
        [ "$skew" -le "$MAX_CLOCK_SKEW_SECONDS" ] || die "topology clock skew ${skew}s exceeds ${MAX_CLOCK_SKEW_SECONDS}s"
    else
        controller_at=pending
        skew=not-recorded
    fi
    shell_status="$(topology_status_value "$(evidence_value shell_bluegreen)")"
    canvas_status="$(topology_status_value "$(evidence_value canvas_bluegreen)")"
    uploads_status="$(topology_status_value "$(evidence_value uploads_bluegreen)")"
    minio_status="$(topology_status_value "$(evidence_value minio_isolation)")"
    evidence_sha="$(shasum -a 256 "$EVIDENCE_FILE" | awk '{print $1}')"
    status=not-ready
    if [ "$shell_status" = ready ] && [ "$canvas_status" = ready ] && [ "$uploads_status" = ready ] && [ "$minio_status" = ready ]; then status=ready-for-bluegreen; fi
    phase="$(state_phase)"
    if [ "$mode" = record ]; then
        case "$phase" in
            source-prepared) state_transition composite-prepared "source-$evidence_sha"; phase=composite-prepared ;;
        esac
        case "$phase" in
            composite-prepared) state_transition local-preparation-verified "local-$evidence_sha"; phase=local-preparation-verified ;;
        esac
        case "$phase" in
            local-preparation-verified) state_transition live-discovery-recorded "live-topology-sha256:$evidence_sha" ;;
            live-discovery-recorded) : ;;
            *) die "record-live-topology is not allowed at release phase $phase" ;;
        esac
    else
        case "$phase" in
            artifacts-built|production-authorized|production-loaded-verified|candidates-healthy|cutover-complete) : ;;
            *) die "refresh-live-topology is not allowed at release phase $phase" ;;
        esac
    fi
    write_live_topology "$status" "$discovery_domain" "$evidence_sha" "$observed_at" "$controller_at" "$skew" "$shell_status" "$canvas_status" "$uploads_status" "$minio_status"
    printf 'operation=%s-live-topology\nlive_status=%s\nlive_evidence_sha256=%s\ncontroller_observed_at=%s\nclock_skew_seconds=%s\ncurrent_phase=%s\n' "$mode" "$status" "$evidence_sha" "$controller_at" "$skew" "$(state_phase)"
}

assert_live_ready() {
    parse_common "$@"
    [ "${#REMAINING[@]}" = 0 ] || die "unknown option: ${REMAINING[0]}"
    load_profile
    [ -f "$(process_manifest)" ] || die 'run prepare first'
    [[ "$MAX_AGE_SECONDS" =~ ^[1-9][0-9]*$ ]] || die 'max age seconds must be a positive integer'
    local live_section live_domain status evidence_sha observed_at controller_at clock_skew freshness age check
    live_section="$(process_manifest)"
    live_domain="$(awk '/^## Live Topology$/{capture=1;next} capture && /^- Discovery Domain:/{sub(/^- Discovery Domain: /,"",$0);print;exit}' "$live_section")"
    status="$(awk '/^## Live Topology$/{capture=1;next} capture && /^- Live Status:/{sub(/^- Live Status: /,"",$0);print;exit}' "$live_section")"
    evidence_sha="$(awk '/^## Live Topology$/{capture=1;next} capture && /^- Evidence SHA-256:/{sub(/^- Evidence SHA-256: /,"",$0);print;exit}' "$live_section")"
    observed_at="$(awk '/^## Live Topology$/{capture=1;next} capture && /^- Observed At:/{sub(/^- Observed At: /,"",$0);print;exit}' "$live_section")"
    controller_at="$(awk '/^## Live Topology$/{capture=1;next} capture && /^- Controller Observed At:/{sub(/^- Controller Observed At: /,"",$0);print;exit}' "$live_section")"
    clock_skew="$(awk '/^## Live Topology$/{capture=1;next} capture && /^- Clock Skew Seconds:/{sub(/^- Clock Skew Seconds: /,"",$0);print;exit}' "$live_section")"
    [ "$live_domain" = "$DOMAIN" ] || die 'live topology domain does not match profile'
    [ "$status" = ready-for-bluegreen ] || die "live topology status is ${status:-missing}"
    [[ "$evidence_sha" =~ ^[0-9a-f]{64}$ ]] || die 'live topology evidence SHA-256 is invalid'
    validate_timestamp "$observed_at"
    freshness="$observed_at"
    if [ -n "$controller_at" ] && [ "$controller_at" != pending ]; then
        validate_timestamp "$controller_at"
        [[ "$MAX_CLOCK_SKEW_SECONDS" =~ ^[0-9]+$ ]] || die 'max clock skew seconds must be non-negative'
        [[ "$clock_skew" =~ ^[0-9]+$ ]] || die 'live topology clock skew is invalid'
        [ "$clock_skew" -le "$MAX_CLOCK_SKEW_SECONDS" ] || die "live topology clock skew ${clock_skew}s exceeds ${MAX_CLOCK_SKEW_SECONDS}s"
        freshness="$controller_at"
    fi
    age="$(topology_age "$freshness")"
    [ "$age" -ge 0 ] || die 'live topology observation is in the future'
    [ "$age" -le "$MAX_AGE_SECONDS" ] || die "live topology evidence is stale: ${age}s exceeds ${MAX_AGE_SECONDS}s"
    for check in 'Shell Blue/Green' 'Canvas Blue/Green' 'Uploads Blue/Green' 'MinIO Isolation'; do
        grep -Fqx -- "- $check: ready" "$live_section" || die "live topology check is not ready: $check"
    done
    printf 'live_status=%s\nlive_evidence_sha256=%s\nlive_evidence_age_seconds=%s\ntopology_gate=ready-for-bluegreen\n' "$status" "$evidence_sha" "$age"
}

prepare() {
    parse_common "$@"
    set -- "${REMAINING[@]}"
    local source_ref="" source_sha archive archive_sha docker_sha process
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --source-ref) need "$1" "${2:-}"; source_ref="$2"; shift 2 ;;
            *) die "unknown option: $1" ;;
        esac
    done
    load_profile
    valid_commit "$source_ref" || die 'source ref must be a 40-character SHA'
    source_sha="$(git -C "$REPO_ROOT" rev-parse --verify "${source_ref}^{commit}")"
    git -C "$REPO_ROOT" merge-base --is-ancestor origin/main "$source_sha" || die 'source ref is not based on origin/main'
    "$SCRIPT_DIR/validate-canvas-contract.py" "$REPO_ROOT" "$DOMAIN" >/dev/null
    mkdir -p "$ARTIFACT_ROOT/$TASK_ID" "$(state_dir)"
    archive="$ARTIFACT_ROOT/$TASK_ID/source-$source_sha.tar"
    git -C "$REPO_ROOT" archive --format=tar "$source_sha" > "$archive.new"
    mv "$archive.new" "$archive"
    archive_sha="$(shasum -a 256 "$archive" | awk '{print $1}')"
    docker_sha="$(git -C "$REPO_ROOT" show "$source_sha:Dockerfile" | shasum -a 256 | awk '{print $1}')"
    umask 077
    {
        printf 'task_id=%s\ndomain=%s\nsource_sha=%s\nsource_archive=%s\nsource_archive_sha256=%s\ndockerfile_sha256=%s\n' "$TASK_ID" "$DOMAIN" "$source_sha" "$archive" "$archive_sha" "$docker_sha"
        printf 'vite_base=%s\nvite_fixed_api_base_url=%s\nvite_docs_url=%s\ncanvas_public_path=%s\n' "$VITE_BASE" "$VITE_FIXED_API_BASE_URL" "$VITE_DOCS_URL" "$CANVAS_PUBLIC_PATH"
        printf 'build_lock=build-artifact:canvas:%s:%s\ndocker_load_lock=production-docker-load-global\ndomain_lock=production-domain:%s\nnginx_lock=production-nginx-global\n' "$DOMAIN" "$source_sha" "$DOMAIN"
    } > "$(source_record)"
    process="$(state_dir)/process.md"
    if [ ! -f "$process" ]; then
        umask 077
        {
            printf '# Canvas Release Task\n\n'
            printf '## Current Task\n- Prepare a guarded Canvas release for %s.\n\n' "$DOMAIN"
            printf '## Done\n- Source archive and release metadata prepared by canvas-release-control.sh.\n\n'
            printf '## Key Files\n- Dockerfile\n- scripts/deploy/canvas-release-control.sh\n- scripts/deploy/canvas-artifact-manifest.sh\n\n'
            printf '## Verification\n- Source contract and archive checks are recorded below.\n\n'
            printf '## Current Constraints\n- Production actions require fresh authorization for root@155.103.156.90.\n\n'
            printf '## Next Step\n1. Verify the exact artifact on newapi-16 before any production action.\n'
        } > "$process"
    fi
    "$SCRIPT_DIR/release-state.sh" init --manifest "$process" --phase source-prepared --evidence "source-$source_sha" >/dev/null
    printf 'source_sha=%s\nsource_archive=%s\nsource_archive_sha256=%s\ndockerfile_sha256=%s\ndomain=%s\nstatus=prepared\n' "$source_sha" "$archive" "$archive_sha" "$docker_sha" "$DOMAIN"
}

assert_source() {
    parse_common "$@"
    [ "${#REMAINING[@]}" = 0 ] || die "unknown option: ${REMAINING[0]}"
    load_profile
    [ -f "$(source_record)" ] || die 'run prepare first'
    local source_sha archive archive_sha docker_sha actual
    source_sha="$(read_record source_sha)"; archive="$(read_record source_archive)"; archive_sha="$(read_record source_archive_sha256)"; docker_sha="$(read_record dockerfile_sha256)"
    [ "$(read_record domain)" = "$DOMAIN" ] || die 'profile domain differs from prepared source'
    valid_commit "$source_sha" || die 'invalid source SHA'
    git -C "$REPO_ROOT" merge-base --is-ancestor origin/main "$source_sha" || die 'source is not based on origin/main'
    [ -f "$archive" ] || die 'source archive is missing'
    actual="$(shasum -a 256 "$archive" | awk '{print $1}')"; [ "$actual" = "$archive_sha" ] || die 'source archive identity drift'
    [ "$(git -C "$REPO_ROOT" show "$source_sha:Dockerfile" | shasum -a 256 | awk '{print $1}')" = "$docker_sha" ] || die 'Dockerfile identity drift'
    "$SCRIPT_DIR/validate-canvas-contract.py" "$REPO_ROOT" "$DOMAIN"
    printf 'source_sha=%s\nsource_archive_sha256=%s\ndomain=%s\nstatus=verified\n' "$source_sha" "$archive_sha" "$DOMAIN"
}

build_plan() {
    parse_common "$@"
    [ "${#REMAINING[@]}" = 0 ] || die "unknown option: ${REMAINING[0]}"
    assert_source --task-id "$TASK_ID" --profile "$PROFILE" --repo-root "$REPO_ROOT" --state-root "$STATE_ROOT" --artifact-root "$ARTIFACT_ROOT"
    printf 'build_host=newapi-16\nplatform=linux/amd64\ndockerfile=Dockerfile\nbuild_arg=VITE_BASE=%s\nbuild_arg=VITE_FIXED_API_BASE_URL=%s\nbuild_arg=VITE_DOCS_URL=%s\n' "$VITE_BASE" "$VITE_FIXED_API_BASE_URL" "$VITE_DOCS_URL"
}

command="${1:-}"; shift || true
case "$command" in
    prepare) prepare "$@" ;;
    prepare-worktree) prepare_worktree "$@" ;;
    assert-source) assert_source "$@" ;;
    build-plan) build_plan "$@" ;;
    record-live-topology) record_live_topology record "$@" ;;
    refresh-live-topology) record_live_topology refresh "$@" ;;
    assert-live-ready) assert_live_ready "$@" ;;
    -h|--help|'') usage ;;
    *) die "unknown command: $command" ;;
esac
