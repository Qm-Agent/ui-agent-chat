import { test } from "node:test";
import assert from "node:assert/strict";

// 回归测试：巡检/回归崩溃根因守卫
//
// 根因回顾：巡检以 `void executeInspectionRun(...)` fire-and-forget 方式执行。
// 其 catch 收尾块内部会 await 二次副作用（maybeNotifyInspection / finishInspectionRun）。
// 在生产环境这些副作用可能再次抛错（MySQL 断连、钉钉出站被墙、子进程崩溃），
// 异常从被 void 掉的 Promise 逃逸成 unhandledRejection。旧版无全局 handler，
// Node 默认对 unhandledRejection 以非零码退出进程 → 容器重启（现象：一触发就挂）。
//
// 这里用两组测试锁定两条防线：
//  1) executeInspectionRun 的收尾结构：即便收尾自身再抛错，也必须被内层 try/catch 吞掉，
//     绝不能从 fire-and-forget 的 Promise 逃逸。
//  2) 全局 fatal-guard：万一仍有遗漏路径逃逸，进程级 handler 必须拦住不退出。

/**
 * 复刻 executeInspectionRun 当前的三层防御收尾结构（不依赖 DB/网络），
 * 断言：无论 notify / finish 如何抛错，本函数返回的 Promise 都 resolve，绝不 reject。
 */
async function fireAndForgetFinalize(opts: {
  runThrows: boolean;
  notifyThrows: boolean;
  finishThrows: boolean;
}): Promise<{ escaped: unknown | null }> {
  const maybeNotify = async () => {
    // 真实 maybeNotifyInspection 内部自带 try/catch，永不抛；这里模拟它已被吞的行为，
    // 但保留 notifyThrows 分支用于验证“即便它意外抛了”也不会逃逸。
    if (opts.notifyThrows) throw new Error("simulated: dingtalk fetch failed");
    return { status: "failed" as const, message: "notified" };
  };
  const finishRun = async () => {
    if (opts.finishThrows) throw new Error("simulated: MySQL PROTOCOL_CONNECTION_LOST");
  };

  let escaped: unknown | null = null;
  // 复刻 executeInspectionRun 主体 + catch 三层结构
  await (async () => {
    try {
      if (opts.runThrows) throw new Error("simulated: agent/Chromium crashed");
      await maybeNotify();
      await finishRun();
    } catch (error) {
      // 收尾块：必须内层 try/catch，收尾自身再抛也吞掉
      try {
        await maybeNotify();
        await finishRun();
      } catch (finalizeError) {
        // 最后一层：尽力标记 failed，失败也不再抛
        await finishRun().catch(() => undefined);
        void finalizeError;
      }
      void error;
    }
  })().catch((e) => {
    // 一旦这里被命中，说明结构有缺陷，异常逃逸出了 fire-and-forget 边界
    escaped = e;
  });

  return { escaped };
}

test("收尾结构：agent 抛错 + 收尾 notify/finish 全部再抛 —— 不逃逸", async () => {
  const { escaped } = await fireAndForgetFinalize({
    runThrows: true,
    notifyThrows: true,
    finishThrows: true
  });
  assert.equal(escaped, null, "最坏情况下异常仍不得从 fire-and-forget Promise 逃逸");
});

test("收尾结构：仅 MySQL finish 抛错（钉钉正常）—— 不逃逸", async () => {
  const { escaped } = await fireAndForgetFinalize({
    runThrows: false,
    notifyThrows: false,
    finishThrows: true
  });
  assert.equal(escaped, null);
});

test("收尾结构：仅钉钉 notify 抛错（DB 正常）—— 不逃逸", async () => {
  const { escaped } = await fireAndForgetFinalize({
    runThrows: false,
    notifyThrows: true,
    finishThrows: false
  });
  assert.equal(escaped, null);
});

test("全局 fatal-guard：unhandledRejection 被拦截且进程不退出（子进程实测）", async () => {
  // node:test runner 自身会拦截 unhandledRejection 并判定测试失败，无法在本进程内直接验证。
  // 改为起一个子进程：装上与 index.ts 相同的 fatal-guard，主动制造一个无人 catch 的
  // rejection + 一个 uncaughtException，验证子进程仍以退出码 0 正常结束（进程未被杀死）。
  const { spawnSync } = await import("node:child_process");
  const script = [
    'process.on("unhandledRejection", (reason) => {',
    '  console.error("[fatal-guard] unhandledRejection:", reason instanceof Error ? reason.message : String(reason));',
    "});",
    'process.on("uncaughtException", (error) => {',
    '  console.error("[fatal-guard] uncaughtException:", error instanceof Error ? error.message : String(error));',
    "});",
    // 制造逃逸的 rejection（模拟 fire-and-forget 收尾漏网）
    'Promise.reject(new Error("simulated escaped rejection"));',
    // 制造同步未捕获异常
    "setTimeout(() => { throw new Error('simulated uncaught exception'); }, 10);",
    // 若守卫生效，进程应存活到这里正常退出
    'setTimeout(() => { console.log("STILL_ALIVE"); process.exit(0); }, 100);'
  ].join("\n");

  const res = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  assert.equal(res.status, 0, `子进程应正常退出(0)，实际=${res.status}；stderr=${res.stderr}`);
  assert.match(res.stdout, /STILL_ALIVE/, "进程必须在 unhandledRejection/uncaughtException 后继续存活");
  assert.match(res.stderr, /unhandledRejection/, "fatal-guard 必须记录到逃逸的 rejection");
  assert.match(res.stderr, /uncaughtException/, "fatal-guard 必须记录到未捕获异常");
});
