/**
 * Table names for the local SQLite database.
 */
export const TABLES = {
  sessions: "uac_sessions",
  chatMessages: "uac_chat_messages",
  sessionArtifacts: "uac_session_artifacts",
  inspectionTasks: "uac_inspection_tasks",
  inspectionRuns: "uac_inspection_runs",
  regressionModules: "uac_regression_modules",
  regressionCases: "uac_regression_cases",
  regressionBatches: "uac_regression_batches",
  regressionRuns: "uac_regression_runs",
  businessEnvironments: "uac_business_environments",
  hostEntries: "uac_host_entries",
  hostApplyStatus: "uac_host_apply_status",
  modelProfiles: "uac_model_profiles",
  modelSettings: "uac_model_settings",
  dingtalkRobots: "uac_dingtalk_robots"
} as const;

export type TableName = (typeof TABLES)[keyof typeof TABLES];

interface ColumnDef {
  name: string;
  type: string;
  nullable: boolean;
  default?: string;
}

const SCHEMA: Record<TableName, ColumnDef[]> = {
  [TABLES.sessions]: [
    { name: "id", type: "string(64)", nullable: false },
    { name: "title", type: "string(255)", nullable: false },
    { name: "status", type: "string(32)", nullable: false },
    { name: "sdk_session_id", type: "string(255)", nullable: true },
    { name: "workspace_path", type: "text", nullable: false },
    { name: "files_json", type: "text", nullable: false },
    { name: "last_error", type: "text", nullable: true },
    { name: "created_at", type: "string(40)", nullable: false },
    { name: "updated_at", type: "string(40)", nullable: false },
    { name: "test_outcome", type: "string(16)", nullable: true },
    { name: "test_summary", type: "text", nullable: true },
    // 会话类型：chat（默认）| cdp（CDP 直连会话，桌面客户端特性）
    { name: "kind", type: "string(16)", nullable: true },
    { name: "browser_kernel", type: "string(32)", nullable: true },
    { name: "execution_runtime_id", type: "string(32)", nullable: true }
  ],
  [TABLES.chatMessages]: [
    { name: "id", type: "string(64)", nullable: false },
    { name: "session_id", type: "string(64)", nullable: false },
    { name: "role", type: "string(16)", nullable: false },
    { name: "content", type: "text", nullable: false },
    { name: "files_json", type: "text", nullable: true },
    { name: "meta_json", type: "text", nullable: true },
    { name: "created_at", type: "string(40)", nullable: false },
    { name: "seq", type: "integer", nullable: false }
  ],
  [TABLES.sessionArtifacts]: [
    // Artifact ids are encoded relative paths and are observed below 191 chars.
    { name: "id", type: "string(191)", nullable: false },
    { name: "session_id", type: "string(64)", nullable: false },
    { name: "name", type: "string(255)", nullable: false },
    { name: "relative_path", type: "text", nullable: false },
    { name: "size", type: "integer", nullable: false },
    { name: "modified_at", type: "string(40)", nullable: false },
    { name: "kind", type: "string(16)", nullable: false },
    { name: "is_core_report", type: "boolean", nullable: false },
  ],
  [TABLES.inspectionTasks]: [
    { name: "id", type: "string(64)", nullable: false },
    { name: "name", type: "string(255)", nullable: false },
    { name: "url", type: "text", nullable: false },
    { name: "business_id", type: "string(64)", nullable: true },
    { name: "username", type: "string(255)", nullable: true },
    { name: "password", type: "string(255)", nullable: true },
    { name: "prompt", type: "text", nullable: true },
    { name: "schedule_enabled", type: "boolean", nullable: false },
    { name: "schedule_mode", type: "string(16)", nullable: true },
    { name: "interval_minutes", type: "integer", nullable: true },
    { name: "cron_expression", type: "string(64)", nullable: true },
    { name: "next_run_at", type: "string(40)", nullable: true },
    { name: "status", type: "string(16)", nullable: false },
    { name: "last_run_at", type: "string(40)", nullable: true },
    { name: "last_status", type: "string(16)", nullable: true },
    { name: "last_error", type: "text", nullable: true },
    { name: "created_at", type: "string(40)", nullable: false },
    { name: "updated_at", type: "string(40)", nullable: false },
    { name: "notify_robot_id", type: "string(64)", nullable: true },
    { name: "notify_trigger", type: "string(16)", nullable: true }
  ],
  [TABLES.inspectionRuns]: [
    { name: "id", type: "string(64)", nullable: false },
    { name: "task_id", type: "string(64)", nullable: false },
    { name: "session_id", type: "string(64)", nullable: false },
    { name: "trigger", type: "string(16)", nullable: false },
    { name: "status", type: "string(16)", nullable: false },
    { name: "started_at", type: "string(40)", nullable: false },
    { name: "finished_at", type: "string(40)", nullable: true },
    { name: "summary", type: "text", nullable: true },
    { name: "error", type: "text", nullable: true },
    { name: "artifacts_count", type: "integer", nullable: true },
    { name: "logs_json", type: "text", nullable: true },
    { name: "test_outcome", type: "string(16)", nullable: true },
    { name: "notify_status", type: "string(16)", nullable: true },
    { name: "notify_message", type: "text", nullable: true },
    { name: "seq", type: "integer", nullable: false }
  ],
  [TABLES.regressionModules]: [
    { name: "id", type: "string(64)", nullable: false },
    { name: "name", type: "string(255)", nullable: false },
    { name: "description", type: "text", nullable: true },
    { name: "created_at", type: "string(40)", nullable: false },
    { name: "updated_at", type: "string(40)", nullable: false }
  ],
  [TABLES.regressionCases]: [
    { name: "id", type: "string(64)", nullable: false },
    { name: "module_id", type: "string(64)", nullable: false },
    { name: "name", type: "string(255)", nullable: false },
    { name: "description", type: "text", nullable: true },
    { name: "prompt", type: "text", nullable: false },
    { name: "business_id", type: "string(64)", nullable: true },
    { name: "notify_robot_id", type: "string(64)", nullable: true },
    { name: "notify_trigger", type: "string(16)", nullable: true },
    { name: "created_at", type: "string(40)", nullable: false },
    { name: "updated_at", type: "string(40)", nullable: false }
  ],
  [TABLES.regressionBatches]: [
    { name: "id", type: "string(64)", nullable: false },
    { name: "name", type: "string(255)", nullable: false },
    { name: "status", type: "string(16)", nullable: false },
    { name: "trigger", type: "string(16)", nullable: false },
    { name: "started_at", type: "string(40)", nullable: false },
    { name: "finished_at", type: "string(40)", nullable: true },
    { name: "total", type: "integer", nullable: false },
    { name: "completed", type: "integer", nullable: false },
    { name: "failed", type: "integer", nullable: false },
    { name: "aborted", type: "integer", nullable: false },
    { name: "created_at", type: "string(40)", nullable: false },
    { name: "updated_at", type: "string(40)", nullable: false },
    { name: "notify_robot_id", type: "string(64)", nullable: true },
    { name: "notify_trigger", type: "string(16)", nullable: true },
    { name: "passed", type: "integer", nullable: false },
    { name: "assert_failed", type: "integer", nullable: false },
    { name: "unknown_count", type: "integer", nullable: false },
    { name: "notify_status", type: "string(16)", nullable: true },
    { name: "notify_message", type: "text", nullable: true }
  ],
  [TABLES.regressionRuns]: [
    { name: "id", type: "string(64)", nullable: false },
    { name: "batch_id", type: "string(64)", nullable: false },
    { name: "case_id", type: "string(64)", nullable: false },
    { name: "case_name", type: "string(255)", nullable: false },
    { name: "session_id", type: "string(64)", nullable: false },
    { name: "status", type: "string(16)", nullable: false },
    { name: "started_at", type: "string(40)", nullable: true },
    { name: "finished_at", type: "string(40)", nullable: true },
    { name: "summary", type: "text", nullable: true },
    { name: "error", type: "text", nullable: true },
    { name: "artifacts_count", type: "integer", nullable: true },
    { name: "test_outcome", type: "string(16)", nullable: true },
    { name: "notify_status", type: "string(16)", nullable: true },
    { name: "notify_message", type: "text", nullable: true },
    { name: "seq", type: "integer", nullable: false }
  ],
  [TABLES.businessEnvironments]: [
    { name: "id", type: "string(64)", nullable: false },
    { name: "name", type: "string(255)", nullable: false },
    { name: "url", type: "text", nullable: false },
    { name: "username", type: "string(255)", nullable: true },
    { name: "password", type: "string(255)", nullable: true },
    { name: "description", type: "text", nullable: true },
    { name: "created_at", type: "string(40)", nullable: false },
    { name: "updated_at", type: "string(40)", nullable: false }
  ],
  [TABLES.hostEntries]: [
    { name: "id", type: "string(64)", nullable: false },
    { name: "ip", type: "string(64)", nullable: false },
    { name: "hostname", type: "string(255)", nullable: false },
    { name: "comment", type: "text", nullable: true },
    { name: "enabled", type: "boolean", nullable: false },
    { name: "created_at", type: "string(40)", nullable: false },
    { name: "updated_at", type: "string(40)", nullable: false }
  ],
  [TABLES.hostApplyStatus]: [
    { name: "id", type: "string(32)", nullable: false },
    { name: "applied", type: "boolean", nullable: false },
    { name: "message", type: "text", nullable: true },
    { name: "applied_at", type: "string(40)", nullable: true },
    { name: "updated_at", type: "string(40)", nullable: false }
  ],
  [TABLES.modelProfiles]: [
    { name: "id", type: "string(64)", nullable: false },
    { name: "runtime_id", type: "string(32)", nullable: false, default: "claude-code" },
    { name: "name", type: "string(255)", nullable: false },
    { name: "base_url", type: "text", nullable: false },
    { name: "auth_token", type: "text", nullable: false },
    { name: "model", type: "string(255)", nullable: false },
    { name: "small_fast_model", type: "string(255)", nullable: true },
    { name: "sonnet_model", type: "string(255)", nullable: true },
    { name: "haiku_model", type: "string(255)", nullable: true },
    { name: "opus_model", type: "string(255)", nullable: true },
    { name: "is_default", type: "boolean", nullable: false },
    { name: "created_at", type: "string(40)", nullable: false },
    { name: "updated_at", type: "string(40)", nullable: false }
  ],
  [TABLES.modelSettings]: [
    { name: "id", type: "string(32)", nullable: false },
    { name: "active_id", type: "string(64)", nullable: false },
    { name: "active_profile_ids_json", type: "text", nullable: false, default: "{}" },
    { name: "model_overrides_json", type: "text", nullable: false, default: "{}" },
    { name: "execution_runtime_id", type: "string(32)", nullable: false, default: "dtcoder" },
    { name: "updated_at", type: "string(40)", nullable: false }
  ],
  [TABLES.dingtalkRobots]: [
    { name: "id", type: "string(64)", nullable: false },
    { name: "name", type: "string(255)", nullable: false },
    { name: "webhook_url", type: "text", nullable: false },
    { name: "secret", type: "text", nullable: true },
    { name: "description", type: "text", nullable: true },
    { name: "inspection_template", type: "text", nullable: true },
    { name: "regression_template", type: "text", nullable: true },
    { name: "created_at", type: "string(40)", nullable: false },
    { name: "updated_at", type: "string(40)", nullable: false }
  ]
};

export const ALL_TABLES = Object.values(TABLES);

export { SCHEMA };
export type ColumnDef_ = ColumnDef;
