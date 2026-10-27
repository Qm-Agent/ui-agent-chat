import fs from "node:fs/promises";
import path from "node:path";

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export async function resolveContainedRegularFile(
  root: string,
  candidate: string
): Promise<string | undefined> {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (!isPathInside(resolvedRoot, resolvedCandidate)) return undefined;

  try {
    const [realRoot, realCandidate] = await Promise.all([
      fs.realpath(resolvedRoot),
      fs.realpath(resolvedCandidate)
    ]);
    if (!isPathInside(realRoot, realCandidate)) return undefined;
    return (await fs.stat(realCandidate)).isFile() ? realCandidate : undefined;
  } catch {
    return undefined;
  }
}
