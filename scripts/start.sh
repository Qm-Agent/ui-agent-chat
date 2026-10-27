#!/usr/bin/env sh
set -eu

if { [ -n "${ANTHROPIC_AUTH_TOKEN:-}" ] || [ -n "${ANTHROPIC_API_KEY:-}" ]; } && [ -z "${ANTHROPIC_MODEL:-}" ]; then
  echo "WARN: Anthropic-compatible service auth is set without ANTHROPIC_MODEL; the selected runtime will use its configured default model." >&2
fi

if [ ! -f "${UI_TEST_ASSISTANT_SKILL_PATH:-/opt/ui-test-assistant-skill}/SKILL.md" ]; then
  echo "ERROR: UI_TEST_ASSISTANT_SKILL_PATH does not contain SKILL.md: ${UI_TEST_ASSISTANT_SKILL_PATH:-/opt/ui-test-assistant-skill}" >&2
  exit 1
fi

mkdir -p "${UI_AGENT_DATA_DIR:-/data/ui-agent-chat}"
mkdir -p "${UI_TEST_ASSISTANT_SKILL_PATH:-/opt/ui-test-assistant-skill}/config"
# Ensure the local SQLite database parent directory exists.
mkdir -p "$(dirname "${UI_AGENT_DB_FILE:-${UI_AGENT_DATA_DIR:-/data/ui-agent-chat}/ui-agent-chat.db}")"

SKILL_DIR="${UI_TEST_ASSISTANT_SKILL_PATH:-/opt/ui-test-assistant-skill}"
SKILL_ENV_FILE="${SKILL_DIR}/config/.env"
SKILL_ENV_EXAMPLE="${SKILL_DIR}/config/.env.example"

# Use .env.example as base, then overlay with runtime environment variables.
if [ -f "${SKILL_ENV_EXAMPLE}" ]; then
  cp "${SKILL_ENV_EXAMPLE}" "${SKILL_ENV_FILE}"
else
  : > "${SKILL_ENV_FILE}"
fi

env | while IFS='=' read -r key value; do
  case "${key}" in
    ANTHROPIC_*|OPENAI_*|BU_*|QUICK_*|TARGET_URL|USERNAME|PASSWORD|UI_TEST_*|UIWARDEN_*|MIDSCENE_*|PLAYWRIGHT_*|PUPPETEER_*)
      printf '%s=%s\n' "${key}" "${value}" >> "${SKILL_ENV_FILE}"
      ;;
  esac
done
chmod 600 "${SKILL_ENV_FILE}"

exec node /app/dist/server/index.js
