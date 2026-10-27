#!/usr/bin/env bash
#
# evidence-runner.sh
#
# Structured execution helper for qaskill agent-in-loop Phase 5 / Phase 5.5.
# It wraps command execution, log persistence, exit-code capture, sha256
# calculation, evidence-manifest append, and manifest verification.
#
# Examples:
#   REPORT_DIR=test-reports/execution/demo/20260602120000 \
#     test/scripts/shell/evidence-runner.sh run \
#       --kind maven \
#       --evidence-id EV-001 \
#       --case-id API-001 \
#       --requirement-id REQ-001 \
#       --layer API \
#       --command "mvn test -Dtest=XxxApiActionTest"
#
#   REPORT_DIR=test-reports/execution/demo/20260602120000 \
#     test/scripts/shell/evidence-runner.sh run \
#       --kind python \
#       --evidence-id EV-002 \
#       --case-id PY-001 \
#       --requirement-id REQ-001 \
#       --layer API \
#       --command "python3 test/scripts/python/demo/check_api.py --log-dir test-reports/execution/demo/20260602120000/logs"
#
#   REPORT_DIR=test-reports/execution/demo/20260602120000 \
#     test/scripts/shell/evidence-runner.sh verify

set -o pipefail

EVIDENCE_RUNNER_REPORT_DIR=""
EVIDENCE_RUNNER_LOGS_DIR=""
EVIDENCE_RUNNER_MANIFEST=""

evidence_runner_init() {
  local report_dir="$1"
  if [ -z "$report_dir" ]; then
    echo "[evidence-runner] FATAL: report_dir is required" >&2
    return 2
  fi

  EVIDENCE_RUNNER_REPORT_DIR="$report_dir"
  EVIDENCE_RUNNER_LOGS_DIR="${report_dir}/logs"
  EVIDENCE_RUNNER_MANIFEST="${report_dir}/evidence-manifest.yaml"

  mkdir -p "$EVIDENCE_RUNNER_LOGS_DIR"

  if [ ! -f "$EVIDENCE_RUNNER_MANIFEST" ]; then
    cat > "$EVIDENCE_RUNNER_MANIFEST" <<EOF
# Evidence manifest - maintained by evidence-runner.sh.
# A record is appended only after command execution, non-empty log validation,
# and artifact sha256 calculation.
# generated_at: $(date_iso)

EOF
  fi
}

run_evidence() {
  local kind="command" evidence_id="" case_id="" requirement_id="" layer=""
  local command_str="" screenshot="" retry_of="" notes="" report_path=""
  local workdir=""

  while [ $# -gt 0 ]; do
    case "$1" in
      --kind)           kind="$2"; shift 2 ;;
      --evidence-id)    evidence_id="$2"; shift 2 ;;
      --case-id)        case_id="$2"; shift 2 ;;
      --requirement-id) requirement_id="$2"; shift 2 ;;
      --layer)          layer="$2"; shift 2 ;;
      --command)        command_str="$2"; shift 2 ;;
      --screenshot)     screenshot="$2"; shift 2 ;;
      --retry-of)       retry_of="$2"; shift 2 ;;
      --notes)          notes="$2"; shift 2 ;;
      --report-path)    report_path="$2"; shift 2 ;;
      --workdir)        workdir="$2"; shift 2 ;;
      *) echo "[evidence-runner] unknown arg: $1" >&2; return 2 ;;
    esac
  done

  if [ -z "$EVIDENCE_RUNNER_REPORT_DIR" ]; then
    echo "[evidence-runner] FATAL: call evidence_runner_init first or set REPORT_DIR" >&2
    return 2
  fi
  if [ -z "$evidence_id" ] || [ -z "$case_id" ] || [ -z "$command_str" ]; then
    echo "[evidence-runner] FATAL: --evidence-id, --case-id, and --command are required" >&2
    return 2
  fi

  local log_file="${EVIDENCE_RUNNER_LOGS_DIR}/${evidence_id}.log"
  local started_at ended_at started_ms ended_ms duration_ms exit_code result sha256

  started_at=$(date_iso)
  started_ms=$(epoch_ms)

  echo "[evidence-runner] evidence_id=${evidence_id}"
  echo "[evidence-runner] kind=${kind}"
  echo "[evidence-runner] command=${command_str}"
  echo "[evidence-runner] log=${log_file}"

  if [ -n "$workdir" ]; then
    (
      cd "$workdir" || exit 2
      execute_command "$command_str"
    ) 2>&1 | tee "$log_file"
    exit_code=${PIPESTATUS[0]}
  else
    execute_command "$command_str" 2>&1 | tee "$log_file"
    exit_code=${PIPESTATUS[0]}
  fi

  ended_at=$(date_iso)
  ended_ms=$(epoch_ms)
  duration_ms=$((ended_ms - started_ms))

  if [ ! -s "$log_file" ]; then
    echo "[evidence-runner] FATAL: log file missing or empty: $log_file" >&2
    return 3
  fi

  sha256=$(file_sha256 "$log_file")

  result="FAIL"
  if [ "$exit_code" -eq 0 ]; then
    result="PASS"
  fi

  if [ "$kind" = "java" ] || [ "$kind" = "maven" ]; then
    report_path=$(archive_surefire_reports "$evidence_id" "$workdir" "$report_path")
  fi

  append_manifest_record \
    "$evidence_id" "$case_id" "$requirement_id" "$layer" "$kind" "$command_str" \
    "$exit_code" "$started_at" "$ended_at" "$duration_ms" "$result" "$log_file" \
    "$report_path" "$screenshot" "$sha256" "$retry_of" "$notes"

  echo "[evidence-runner] ${evidence_id} ${result} exit=${exit_code} duration_ms=${duration_ms} sha256=${sha256}"
  return "$exit_code"
}

evidence_runner_verify() {
  if [ -z "$EVIDENCE_RUNNER_MANIFEST" ] || [ ! -f "$EVIDENCE_RUNNER_MANIFEST" ]; then
    echo "[evidence-runner] FATAL: manifest not found. Run init first or set REPORT_DIR." >&2
    return 2
  fi

  local total=0 log_present=0 log_non_empty=0 sha_ok=0 screenshot_checked=0 screenshot_present=0
  local broken=()

  while IFS=$'\t' read -r ev_id lp sha screenshot; do
    [ -z "$ev_id" ] && continue
    total=$((total + 1))

    if [ -f "$lp" ]; then
      log_present=$((log_present + 1))
      if [ -s "$lp" ]; then
        log_non_empty=$((log_non_empty + 1))
        local actual
        actual=$(file_sha256 "$lp")
        if [ "$actual" = "$sha" ]; then
          sha_ok=$((sha_ok + 1))
        else
          broken+=("${ev_id}: sha256 mismatch")
        fi
      else
        broken+=("${ev_id}: log empty (${lp})")
      fi
    else
      broken+=("${ev_id}: log missing (${lp})")
    fi

    if [ -n "$screenshot" ]; then
      screenshot_checked=$((screenshot_checked + 1))
      if [ -f "$screenshot" ]; then
        screenshot_present=$((screenshot_present + 1))
      else
        broken+=("${ev_id}: screenshot missing (${screenshot})")
      fi
    fi
  done < <(parse_manifest "$EVIDENCE_RUNNER_MANIFEST")

  local integrity="COMPLETE"
  if [ "$total" -eq 0 ]; then
    integrity="BROKEN"
  elif [ "$sha_ok" -lt "$total" ] || [ "$screenshot_present" -lt "$screenshot_checked" ]; then
    if [ "$log_present" -eq "$total" ] && [ "$log_non_empty" -eq "$total" ]; then
      integrity="PARTIAL"
    else
      integrity="BROKEN"
    fi
  fi

  echo "===== Phase 5.5 Evidence Verify ====="
  echo "manifest:           $EVIDENCE_RUNNER_MANIFEST"
  echo "total_evidences:    $total"
  echo "log_present:        $log_present / $total"
  echo "log_non_empty:      $log_non_empty / $total"
  echo "sha256_verified:    $sha_ok / $total"
  if [ "$screenshot_checked" -gt 0 ]; then
    echo "screenshot_present: $screenshot_present / $screenshot_checked"
  else
    echo "screenshot_present: N/A"
  fi
  echo "evidence_integrity: $integrity"
  if [ ${#broken[@]} -gt 0 ]; then
    echo "broken_items:"
    local item
    for item in "${broken[@]}"; do
      echo "  - $item"
    done
  fi
  echo "====================================="

  case "$integrity" in
    COMPLETE) return 0 ;;
    PARTIAL) return 1 ;;
    BROKEN) return 2 ;;
  esac
}

execute_command() {
  local command_str="$1"
  bash -c "$command_str"
}

archive_surefire_reports() {
  local evidence_id="$1"
  local workdir="$2"
  local existing_report_path="$3"
  local base_dir="."
  if [ -n "$workdir" ]; then
    base_dir="$workdir"
  fi

  local surefire_dir="${base_dir}/target/surefire-reports"
  local failsafe_dir="${base_dir}/target/failsafe-reports"
  local archive_dir="${EVIDENCE_RUNNER_REPORT_DIR}/surefire/${evidence_id}"
  local archived=""

  mkdir -p "$archive_dir"
  if [ -d "$surefire_dir" ]; then
    cp -R "$surefire_dir/." "$archive_dir/"
    archived="$archive_dir"
  fi
  if [ -d "$failsafe_dir" ]; then
    mkdir -p "${archive_dir}/failsafe-reports"
    cp -R "$failsafe_dir/." "${archive_dir}/failsafe-reports/"
    archived="$archive_dir"
  fi

  if [ -n "$existing_report_path" ]; then
    printf '%s' "$existing_report_path"
  elif [ -n "$archived" ]; then
    printf '%s' "$archived"
  else
    printf ''
  fi
}

append_manifest_record() {
  local evidence_id="$1" case_id="$2" requirement_id="$3" layer="$4" kind="$5"
  local command_str="$6" exit_code="$7" started_at="$8" ended_at="$9"
  local duration_ms="${10}" result="${11}" log_file="${12}" report_path="${13}"
  local screenshot="${14}" sha256="${15}" retry_of="${16}" notes="${17}"

  {
    echo "- evidence_id: $(yaml_quote "$evidence_id")"
    echo "  case_id: $(yaml_quote "$case_id")"
    echo "  requirement_id: $(yaml_quote "$requirement_id")"
    echo "  layer: $(yaml_quote "$layer")"
    echo "  kind: $(yaml_quote "$kind")"
    echo "  command: $(yaml_quote "$command_str")"
    echo "  exit_code: ${exit_code}"
    echo "  started_at: $(yaml_quote "$started_at")"
    echo "  ended_at: $(yaml_quote "$ended_at")"
    echo "  duration_ms: ${duration_ms}"
    echo "  result: ${result}"
    echo "  log_path: $(yaml_quote "$log_file")"
    echo "  report_path: $(yaml_quote "$report_path")"
    echo "  screenshot_path: $(yaml_quote "$screenshot")"
    echo "  artifact_sha256: $(yaml_quote "$sha256")"
    echo "  redaction_status: \"PENDING_REVIEW\""
    echo "  retry_of: $(yaml_quote "$retry_of")"
    if [ -n "$notes" ]; then
      echo "  notes: $(yaml_quote "$notes")"
    fi
    echo ""
  } >> "$EVIDENCE_RUNNER_MANIFEST"
}

parse_manifest() {
  local file="$1"
  awk '
    /^- evidence_id:/ {
      if (ev_id != "") print ev_id "\t" lp "\t" sha "\t" screenshot;
      ev_id = yaml_value($0);
      lp = ""; sha = ""; screenshot = "";
      next
    }
    /^[[:space:]]+log_path:/ {
      lp = yaml_value($0);
      next
    }
    /^[[:space:]]+artifact_sha256:/ {
      sha = yaml_value($0);
      next
    }
    /^[[:space:]]+screenshot_path:/ {
      screenshot = yaml_value($0);
      next
    }
    END {
      if (ev_id != "") print ev_id "\t" lp "\t" sha "\t" screenshot;
    }
    function yaml_value(line) {
      sub(/^[^:]+:[[:space:]]*/, "", line);
      gsub(/^"/, "", line);
      gsub(/"$/, "", line);
      gsub(/\\"/, "\"", line);
      gsub(/\\\\/, "\\", line);
      return line;
    }
  ' "$file"
}

yaml_quote() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '"%s"' "$s"
}

file_sha256() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    echo "[evidence-runner] FATAL: sha256sum or shasum is required" >&2
    return 2
  fi
}

date_iso() {
  date -Iseconds 2>/dev/null || date '+%Y-%m-%dT%H:%M:%S%z'
}

epoch_ms() {
  local ms
  ms=$(date +%s%3N 2>/dev/null || true)
  if [ -n "$ms" ] && [ "$ms" != "%3N" ] && [[ "$ms" =~ ^[0-9]+$ ]]; then
    echo "$ms"
  else
    echo "$(date +%s)000"
  fi
}

usage() {
  cat <<EOF
Usage:
  $0 init <REPORT_DIR>
  REPORT_DIR=<path> $0 run --kind <maven|java|python|shell|command> \\
    --evidence-id EV-001 --case-id API-001 --requirement-id REQ-001 \\
    --layer API --command "<command>" [--workdir <dir>] [--report-path <path>] \\
    [--screenshot <path>] [--retry-of <evidence_id>] [--notes <text>]
  REPORT_DIR=<path> $0 verify

Source mode:
  source $0
  evidence_runner_init <REPORT_DIR>
  run_evidence --kind python ...
  evidence_runner_verify
EOF
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  cmd="${1:-}"
  shift || true
  case "$cmd" in
    init)
      evidence_runner_init "$@"
      ;;
    run)
      if [ -n "${REPORT_DIR:-}" ]; then
        evidence_runner_init "$REPORT_DIR" >/dev/null
      fi
      run_evidence "$@"
      ;;
    verify)
      if [ -n "${REPORT_DIR:-}" ]; then
        evidence_runner_init "$REPORT_DIR" >/dev/null
      fi
      evidence_runner_verify
      ;;
    *)
      usage
      exit 2
      ;;
  esac
fi
