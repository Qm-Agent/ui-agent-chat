import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

export const dataDir = path.resolve(
  process.env.UI_AGENT_DATA_DIR ?? path.join(projectRoot, "data")
);

export const skillSourceDir = path.resolve(
  process.env.UI_TEST_ASSISTANT_SKILL_PATH ??
    path.join(projectRoot, "skills", "ui-test-assistant-skill")
);

export const computerSkillSourceDir = path.resolve(
  process.env.DT_GUI_COMPUTER_SKILL_PATH ??
    path.join(projectRoot, "skills", "dt-gui-computer-skill")
);

export const browserSkillSourceDir = path.resolve(
  process.env.DT_GUI_BROWSER_SKILL_PATH ??
    path.join(projectRoot, "skills", "dt-gui-browser-skill")
);

export const sessionsDir = path.join(dataDir, "sessions");
export const inspectionsDir = path.join(dataDir, "inspections");
export const configDir = path.join(dataDir, "config");
export const regressionsDir = path.join(dataDir, "regressions");
export const qualityDir = path.join(dataDir, "quality");
export const uiOperationsDir = path.join(dataDir, "ui-operations");
export const evaluationLabDir = path.join(dataDir, "evaluation-lab");

// Local SQLite database. Placed under dataDir so it
// is co-located with workspace files and survives container restarts via the
// mounted volume. Ignored by .gitignore (*.db).
export const dbFilePath = path.resolve(
  process.env.UI_AGENT_DB_FILE ?? path.join(dataDir, "ui-agent-chat.db")
);

// Marker file written once legacy JSON migration completes, so subsequent
// startups skip the migration pass (idempotent).
export const dbMigratedMarker = path.join(dataDir, ".db-migrated");
