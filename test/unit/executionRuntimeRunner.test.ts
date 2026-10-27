import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  detectCfuseConfiguredModel,
  shouldUseCfuseServiceEnvironment
} from "../../server/src/executionRuntime.js";
import {
  buildExecutionRuntimeCommand,
  cfuseCapabilityWarnings,
  classifyCfuseFailure,
  detectCfuseCliCapabilities,
  parseExecutionRuntimeLine,
  runExecutionRuntime
} from "../../server/src/executionRuntimeRunner.js";

test("CFuse command enables project skills, streaming, tool policy and resume", () => {
  const command = buildExecutionRuntimeCommand({
    runtimeId: "cfuse",
    executable: "/bin/cfuse",
    prompt: "hello",
    cwd: "/tmp/workspace",
    resumeSessionId: "session-one",
    conversationId: "conversation-one",
    model: "model-one",
    allowedTools: ["Bash", "Skill"]
  });
  assert.deepEqual(command.slice(-2), ["-p", "hello"]);
  assert.ok(command.includes("stream-json"));
  assert.ok(command.includes("--verbose"));
  assert.ok(command.includes("project,local"));
  assert.equal(command[command.indexOf("--resume") + 1], "session-one");
  assert.equal(command[command.indexOf("--allowedTools") + 1], "Bash,Skill");
});

test("CFuse command omits unsupported Claude-compatible options", () => {
  const command = buildExecutionRuntimeCommand({
    runtimeId: "cfuse",
    executable: "/bin/cfuse",
    prompt: "hello",
    cwd: "/tmp/workspace",
    resumeSessionId: "session-one",
    conversationId: "conversation-one",
    model: "model-one",
    allowedTools: ["Bash", "Skill"]
  }, {});
  assert.deepEqual(command, [
    "/bin/cfuse",
    "--output-format", "json",
    "-p", "hello"
  ]);
});

test("CFuse stream-json command only enables verbose when the installed CLI supports it", () => {
  const command = buildExecutionRuntimeCommand({
    runtimeId: "cfuse",
    executable: "/bin/cfuse",
    prompt: "hello",
    cwd: "/tmp/workspace",
    conversationId: "conversation-one"
  }, {
    print: "-p",
    outputFormat: "--output-format",
    verbose: "--verbose"
  });
  assert.deepEqual(command, [
    "/bin/cfuse",
    "--output-format", "stream-json",
    "--verbose",
    "-p", "hello"
  ]);

  const legacyCommand = buildExecutionRuntimeCommand({
    runtimeId: "cfuse",
    executable: "/bin/cfuse",
    prompt: "hello",
    cwd: "/tmp/workspace",
    conversationId: "conversation-one"
  }, {
    print: "-p",
    outputFormat: "--output-format"
  });
  assert.equal(legacyCommand.includes("--verbose"), false);
  assert.equal(legacyCommand[legacyCommand.indexOf("--output-format") + 1], "json");
});

test("CFuse capabilities are detected from the installed CLI help", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uiwarden-cfuse-help-"));
  const executable = path.join(root, "cfuse");
  try {
    await fs.writeFile(
      executable,
      [
        "#!/bin/sh",
        "printf '%s\\n' 'Options:'",
        "printf '%s\\n' '  --output-format <format>'",
        "printf '%s\\n' '  --permission-mode <mode>'",
        "printf '%s\\n' '  --allowed-tools <tools...>'",
        "printf '%s\\n' '  --resume [value]'"
      ].join("\n"),
      { mode: 0o700 }
    );
    const capabilities = await detectCfuseCliCapabilities(executable, {
      PATH: process.env.PATH || ""
    });
    assert.deepEqual(capabilities, {
      probeStatus: "ok",
      print: undefined,
      outputFormat: "--output-format",
      model: undefined,
      settingSources: undefined,
      permissionMode: "--permission-mode",
      includePartialMessages: undefined,
      verbose: undefined,
      allowedTools: "--allowed-tools",
      resume: "--resume"
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("CFuse infers verbose when non-TTY help exposes partial streaming", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uiwarden-cfuse-help-"));
  const executable = path.join(root, "cfuse");
  try {
    await fs.writeFile(
      executable,
      [
        "#!/bin/sh",
        "printf '%s\\n' '  -p, --print'",
        "printf '%s\\n' '  --output-format <format>'",
        "printf '%s\\n' '  --include-partial-messages'"
      ].join("\n"),
      { mode: 0o700 }
    );
    const capabilities = await detectCfuseCliCapabilities(executable, {
      PATH: process.env.PATH || ""
    });
    assert.equal(capabilities.includePartialMessages, "--include-partial-messages");
    assert.equal(capabilities.verbose, "--verbose");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("CFuse unavailable capability probe uses the conservative JSON protocol", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uiwarden-cfuse-empty-help-"));
  const executable = path.join(root, "cfuse");
  try {
    await fs.writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const capabilities = await detectCfuseCliCapabilities(executable, {
      PATH: process.env.PATH || ""
    });
    assert.equal(capabilities.probeStatus, "unavailable");
    assert.equal(capabilities.verbose, undefined);
    const command = buildExecutionRuntimeCommand({
      runtimeId: "cfuse",
      executable,
      prompt: "hello",
      cwd: root,
      conversationId: "fallback-conversation"
    }, capabilities);
    assert.equal(command[command.indexOf("--output-format") + 1], "json");
    assert.equal(command.includes("--verbose"), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("CFuse compatibility warnings expose missing resume and tool policy", () => {
  const warnings = cfuseCapabilityWarnings({
    probeStatus: "ok",
    print: "-p",
    outputFormat: "--output-format",
    model: "--model"
  });
  assert.ok(warnings.some((warning) => warning.includes("会话续接")));
  assert.ok(warnings.some((warning) => warning.includes("工具白名单")));
});

test("CFuse failures are converted to actionable diagnostics", () => {
  assert.match(
    classifyCfuseFailure("Error: When using --print, --output-format=stream-json requires --verbose", "exit 1"),
    /流式参数协商失败/
  );
  assert.match(
    classifyCfuseFailure("Unknown arguments: setting-sources", "exit 1"),
    /参数.*不兼容/
  );
  assert.match(
    classifyCfuseFailure("401 unauthorized: token expired", "exit 1"),
    /认证不可用/
  );
  assert.match(
    classifyCfuseFailure("model foo not found", "exit 1"),
    /不支持所选模型/
  );
  assert.match(
    classifyCfuseFailure(
      "API Error: 422 未找到匹配的自定义供应商配置：请确认已传 X-USER-MODEL-PROVIDER-CATEGORY 头",
      "exit 1"
    ),
    /antchat\/MiniMax-M2\.5/
  );
  assert.match(
    classifyCfuseFailure("connect ETIMEDOUT api.example.com", "exit 1"),
    /网络、代理、DNS/
  );
  assert.match(
    classifyCfuseFailure("429 已达到 Token Plan 用量上限", "exit 1"),
    /额度不足或已触发限流/
  );
  assert.doesNotMatch(
    classifyCfuseFailure("401 unauthorized token=very-secret-token", "exit 1"),
    /very-secret-token/
  );
});

test("execution runtime stops when no first event arrives before startup timeout", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uiwarden-runtime-timeout-"));
  const executable = path.join(root, "slow-runtime");
  try {
    await fs.writeFile(executable, "#!/bin/sh\nsleep 5\n", { mode: 0o700 });
    const events = [];
    for await (const event of runExecutionRuntime({
      runtimeId: "dtcoder",
      executable,
      prompt: "hello",
      cwd: root,
      conversationId: "timeout-case",
      env: { PATH: process.env.PATH || "" },
      abortSignal: new AbortController().signal,
      startupTimeoutMs: 100
    })) {
      events.push(event);
    }
    const failure = events.find((event) => event.result?.subtype === "error");
    assert.match(String(failure?.result?.result || ""), /未返回首个事件/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("aborting an execution runtime terminates its descendant process tree", {
  skip: process.platform === "win32"
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uiwarden-runtime-tree-"));
  const executable = path.join(root, "runtime-with-child");
  const childPidPath = path.join(root, "child.pid");
  const controller = new AbortController();
  try {
    await fs.writeFile(
      executable,
      [
        "#!/bin/sh",
        "sleep 30 &",
        `echo $! > ${JSON.stringify(childPidPath)}`,
        "wait"
      ].join("\n"),
      { mode: 0o700 }
    );
    const consume = async () => {
      const events = [];
      for await (const event of runExecutionRuntime({
        runtimeId: "dtcoder",
        executable,
        prompt: "hello",
        cwd: root,
        conversationId: "abort-tree",
        env: { PATH: process.env.PATH || "" },
        abortSignal: controller.signal
      })) {
        events.push(event);
      }
      return events;
    };
    const execution = consume();
    const childPid = await waitForPidFile(childPidPath);
    controller.abort();
    const events = await execution;
    assert.ok(events.some((event) => event.result?.result === "任务已被中止"));
    await waitForProcessExit(childPid);
  } finally {
    controller.abort();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("aborting an execution runtime terminates a tool process in a detached group", {
  skip: process.platform === "win32"
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uiwarden-runtime-detached-tree-"));
  const executable = path.join(root, "runtime-with-detached-tool");
  const childPidPath = path.join(root, "detached-child.pid");
  const controller = new AbortController();
  try {
    await fs.writeFile(
      executable,
      [
        "#!/bin/sh",
        "python3 -c 'import pathlib, subprocess, sys, time; "
          + "p=subprocess.Popen([\"sleep\", \"30\"], start_new_session=True); "
          + "pathlib.Path(sys.argv[1]).write_text(str(p.pid)); time.sleep(30)' "
          + `${JSON.stringify(childPidPath)} &`,
        "wait"
      ].join("\n"),
      { mode: 0o700 }
    );
    const execution = (async () => {
      const events = [];
      for await (const event of runExecutionRuntime({
        runtimeId: "dtcoder",
        executable,
        prompt: "hello",
        cwd: root,
        conversationId: "abort-detached-tree",
        env: { PATH: process.env.PATH || "" },
        abortSignal: controller.signal
      })) {
        events.push(event);
      }
      return events;
    })();
    const childPid = await waitForPidFile(childPidPath);
    controller.abort();
    const events = await execution;
    assert.ok(events.some((event) => event.result?.result === "任务已被中止"));
    await waitForProcessExit(childPid);
  } finally {
    controller.abort();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Codex command starts and resumes the same JSONL thread", () => {
  const initial = buildExecutionRuntimeCommand({
    runtimeId: "codex",
    executable: "/bin/codex",
    prompt: "hello",
    cwd: "/tmp/workspace",
    conversationId: "conversation-one"
  });
  assert.deepEqual(initial.slice(0, 2), ["/bin/codex", "exec"]);
  assert.ok(initial.includes("--json"));
  assert.equal(initial[initial.indexOf("--cd") + 1], "/tmp/workspace");

  const resumed = buildExecutionRuntimeCommand({
    runtimeId: "codex",
    executable: "/bin/codex",
    prompt: "continue",
    cwd: "/tmp/workspace",
    resumeSessionId: "thread-one",
    conversationId: "conversation-one"
  });
  assert.deepEqual(resumed.slice(0, 3), ["/bin/codex", "exec", "resume"]);
  assert.equal(resumed.at(-2), "thread-one");
  assert.equal(resumed.at(-1), "continue");
});

test("DTCoder command binds a stable UIWarden conversation", () => {
  const command = buildExecutionRuntimeCommand({
    runtimeId: "dtcoder",
    executable: "/bin/dtcoder",
    prompt: "hello",
    cwd: "/tmp/workspace",
    conversationId: "chat:one/two"
  });
  assert.deepEqual(command.slice(0, 2), ["/bin/dtcoder", "-p"]);
  assert.equal(command[command.indexOf("--session") + 1], "chat-one-two");
  assert.deepEqual(command.slice(-2), ["--", "hello"]);
});

for (const executable of ["/tmp/aiwork", "/tmp/aiworkcn", "/tmp/aiworkcli"]) {
  test(`${path.basename(executable)} command uses the AiWork chat protocol and stable session label`, () => {
    const command = buildExecutionRuntimeCommand({
      runtimeId: "dtcoder",
      executable,
      prompt: "hello",
      cwd: "/tmp/workspace",
      conversationId: "chat:one/two",
      model: "provider/model"
    });
    assert.deepEqual(command, [
      executable, "chat", "--agent", "coder",
      "--session", "chat-one-two", "--message", "hello",
      "--json", "--dangerously-skip-permissions", "--model", "provider/model"
    ]);
  });
}

test("internal AiWork starts its daemon and creates a session before chat", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uiwarden-aiwork-runner-"));
  const executable = path.join(root, "aiwork");
  const callLog = path.join(root, "calls.jsonl");
  try {
    await fs.writeFile(executable, [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + '\\n');",
      "if (args[0] === 'agent' && args[1] === 'status') console.log(JSON.stringify({ok:true,agents:[]}));",
      "else if (args[0] === 'agent' && args[1] === 'start') console.log(JSON.stringify({ok:true}));",
      "else if (args[0] === 'sessions' && args[1] === 'create') console.log(JSON.stringify({ok:true,created:true}));",
      "else if (args[0] === 'chat') {",
      "  console.log(JSON.stringify({event:{name:'stream.text_delta'},data:{text:'done'}}));",
      "  console.log(JSON.stringify({event:{name:'stream.completed'},data:{}}));",
      "} else process.exit(2);"
    ].join("\n"), { mode: 0o700 });
    const events = [];
    for await (const event of runExecutionRuntime({
      runtimeId: "dtcoder",
      executable,
      prompt: "hello",
      cwd: root,
      conversationId: "conversation-one",
      env: { PATH: process.env.PATH || "", CALL_LOG: callLog },
      abortSignal: new AbortController().signal,
      startupTimeoutMs: 10_000
    })) events.push(event);
    assert.ok(events.some((event) => event.text === "done"));
    assert.ok(events.some((event) => event.result?.subtype === "success"));
    const calls = (await fs.readFile(callLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(calls.map((args) => args.slice(0, 2)), [
      ["agent", "status"], ["agent", "start"], ["sessions", "create"], ["chat", "--agent"]
    ]);
    assert.equal(calls[2][calls[2].indexOf("--cwd") + 1], root);
    assert.equal(calls[3][calls[3].indexOf("--session") + 1], "conversation-one");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("CFuse, Codex and DTCoder streams normalize to shared events", () => {
  const cfuseInit = parseExecutionRuntimeLine(
    "cfuse-stream-json",
    '{"type":"system","subtype":"init","session_id":"cfuse-one","model":"antchat/GLM-5.1"}',
    {}
  );
  assert.equal(cfuseInit[0].sdkSessionId, "cfuse-one");
  assert.equal(cfuseInit[0].actualModel, "antchat/GLM-5.1");

  const cfuse = parseExecutionRuntimeLine(
    "cfuse-stream-json",
    '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"cfuse ok"}}}',
    {}
  );
  assert.equal(cfuse[0].text, "cfuse ok");

  const codexSession = parseExecutionRuntimeLine(
    "codex-jsonl",
    '{"type":"thread.started","thread_id":"thread-one"}',
    {}
  );
  assert.equal(codexSession[0].sdkSessionId, "thread-one");
  const codexText = parseExecutionRuntimeLine(
    "codex-jsonl",
    '{"type":"item.completed","item":{"type":"agent_message","text":"codex ok"}}',
    {}
  );
  assert.equal(codexText[0].text, "codex ok");
  const codexCommand = parseExecutionRuntimeLine(
    "codex-jsonl",
    '{"type":"item.started","item":{"id":"cmd-1","type":"command_execution","command":"dt-gui-computer observe"}}',
    {}
  );
  assert.equal(codexCommand[0].tool?.name, "Bash");
  assert.equal(codexCommand[0].tool?.runtimeToolName, "command_execution");

  const dtcoder = parseExecutionRuntimeLine(
    "dtcoder-stream-json",
    '{"event":{"name":"stream.failed"},"data":{"code":"PROVIDER_QUOTA_EXCEEDED","message":"额度不足"}}',
    {}
  );
  assert.equal(dtcoder[0].result?.subtype, "error");
  assert.equal(dtcoder[0].result?.result, "额度不足");

  const inspected = parseExecutionRuntimeLine(
    "dtcoder-stream-json",
    '{"event":{"name":"stream.failed"},"data":{"code":"PROVIDER_ERROR","failure":{"summary":"模型服务返回未识别错误。","diagnostics":{"raw_error":"data_inspection_failed: Output data may contain inappropriate content"}}}}',
    {}
  );
  assert.match(String(inspected[0].result?.result), /内容检查拦截/);
  assert.match(String(inspected[0].result?.rawError), /data_inspection_failed/);
});

test("Codex non-zero exit includes bounded redacted stderr diagnostics", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uiwarden-codex-failure-"));
  const executable = path.join(root, "codex");
  try {
    await fs.writeFile(
      executable,
      [
        "#!/bin/sh",
        "echo 'Error loading rules:' >&2",
        "echo 'codeisland.rules:489: unfinished string literal token=secret-token-value' >&2",
        "exit 1"
      ].join("\n"),
      { mode: 0o700 }
    );
    const events = [];
    for await (const event of runExecutionRuntime({
      runtimeId: "codex",
      executable,
      prompt: "hello",
      cwd: root,
      conversationId: "conversation-one",
      env: { PATH: process.env.PATH || "" },
      abortSignal: new AbortController().signal
    })) {
      events.push(event);
    }
    const failure = events.find((event) => event.result?.subtype === "error");
    assert.match(String(failure?.result?.result), /unfinished string literal/);
    assert.match(String(failure?.result?.result), /token=\[REDACTED\]/);
    assert.doesNotMatch(String(failure?.result?.result), /secret-token-value/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function waitForPidFile(filePath: string): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const value = Number((await fs.readFile(filePath, "utf8")).trim());
      if (Number.isInteger(value) && value > 0) return value;
    } catch {
      // Runtime has not written its child PID yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("runtime child PID was not written");
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`runtime descendant ${pid} is still alive after abort`);
}

test("CFuse ignores stale runtime markers and only trusts persistent local configuration", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "uiwarden-cfuse-env-"));
  try {
    const env = { ANTHROPIC_AUTH_TOKEN: "service-token" };
    assert.equal(shouldUseCfuseServiceEnvironment(env, home), true);
    await fs.mkdir(path.join(home, ".codefuse"), { recursive: true });
    await fs.writeFile(path.join(home, ".codefuse", "agent.lock"), "");
    assert.equal(shouldUseCfuseServiceEnvironment(env, home), true);
    await fs.mkdir(path.join(home, ".codefuse", "fuse"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".codefuse", "fuse", "codefuse.json"),
      JSON.stringify({ model: "antchat/GLM-5.1", token: "local-token" })
    );
    assert.equal(shouldUseCfuseServiceEnvironment(env, home), false);
    await fs.rm(path.join(home, ".codefuse", "fuse", "codefuse.json"));
    await fs.writeFile(path.join(home, ".codefuse", "settings.json"), "{}");
    assert.equal(shouldUseCfuseServiceEnvironment(env, home), false);
    assert.equal(shouldUseCfuseServiceEnvironment({}, home), false);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("CFuse model detection follows the same local-state priority as execution", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "uiwarden-cfuse-model-"));
  try {
    const env = { ANTHROPIC_MODEL: "MiniMax-M2.5" };
    assert.equal(detectCfuseConfiguredModel(env, home), "MiniMax-M2.5");

    await fs.mkdir(path.join(home, ".codefuse", "fuse"), { recursive: true });
    await fs.mkdir(path.join(home, ".codefuse", "temp"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".codefuse", "fuse", "codefuse.json"),
      JSON.stringify({ model: "antchat/GLM-5.1" })
    );
    await fs.writeFile(path.join(home, ".codefuse", "temp", "IDENTITY"), "local");

    assert.equal(detectCfuseConfiguredModel(env, home), "MiniMax-M2.5");
    await fs.writeFile(
      path.join(home, ".codefuse", "fuse", "codefuse.json"),
      JSON.stringify({ model: "antchat/GLM-5.1", token: "local-token" })
    );
    assert.equal(detectCfuseConfiguredModel(env, home), "antchat/GLM-5.1");
    await fs.writeFile(path.join(home, ".codefuse", "settings.json"), "{}");
    assert.equal(detectCfuseConfiguredModel(env, home), "antchat/GLM-5.1");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
