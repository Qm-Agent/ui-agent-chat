import fs from "node:fs/promises";
import path from "node:path";
import type { HostApplyStatus, HostEntry } from "./types.js";
import { refreshDnsCache } from "./dnsOverride.js";

const HOSTS_FILE = process.env.UIWARDEN_HOSTS_FILE ?? "/etc/hosts";
const START = "# >>> uiwarden managed hosts >>>";
const END = "# <<< uiwarden managed hosts <<<";

export async function applyHosts(entries: HostEntry[]): Promise<HostApplyStatus> {
  const enabled = entries.filter((entry) => entry.enabled);
  const block = [
    START,
    ...enabled.map((entry) => {
      const comment = entry.comment ? ` # ${entry.comment.replace(/\n/g, " ")}` : "";
      return `${entry.ip}\t${entry.hostname}${comment}`;
    }),
    END
  ].join("\n");

  try {
    let current: string;
    try {
      current = await fs.readFile(HOSTS_FILE, "utf8");
    } catch {
      current = "";
    }
    const next = replaceManagedBlock(current, block);
    await fs.mkdir(path.dirname(HOSTS_FILE), { recursive: true });
    await fs.writeFile(HOSTS_FILE, next, "utf8");
    refreshDnsCache();
    return {
      applied: true,
      appliedAt: new Date().toISOString(),
      message: `已应用 ${enabled.length} 条 Host 配置`
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const permissionHint = detail.includes("EACCES") || detail.includes("EPERM")
      ? "当前服务进程没有写入权限；镜像/容器内以具备权限/容器内以具备权限的用户运行即可生效，或通过 UIWARDEN_HOSTS_FILE 指向可写 hosts 文件。"
      : "";
    return {
      applied: false,
      appliedAt: new Date().toISOString(),
      message: `Host 配置已保存，但写入 ${HOSTS_FILE} 失败：${detail}${permissionHint ? ` ${permissionHint}` : ""}`
    };
  }
}

function replaceManagedBlock(current: string, block: string): string {
  const start = current.indexOf(START);
  const end = current.indexOf(END);
  if (start >= 0 && end > start) {
    const before = current.slice(0, start).trimEnd();
    const after = current.slice(end + END.length).trimStart();
    return `${before}\n\n${block}\n${after ? `\n${after}` : ""}`;
  }
  return `${current.trimEnd()}\n\n${block}\n`;
}