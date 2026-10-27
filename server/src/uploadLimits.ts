export interface SessionUploadLimits {
  files: number;
  fileSize: number;
  fields: number;
  fieldSize: number;
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export function resolveSessionUploadLimits(
  env: NodeJS.ProcessEnv = process.env
): SessionUploadLimits {
  const files = boundedInteger(env.UI_AGENT_UPLOAD_MAX_FILES, 10, 1, 50);
  const fileSizeMb = boundedInteger(env.UI_AGENT_UPLOAD_MAX_FILE_MB, 25, 1, 500);
  const fieldSizeMb = boundedInteger(env.UI_AGENT_UPLOAD_MAX_FIELD_MB, 2, 1, 10);
  return {
    files,
    fileSize: fileSizeMb * 1024 * 1024,
    fields: 24,
    fieldSize: fieldSizeMb * 1024 * 1024
  };
}
