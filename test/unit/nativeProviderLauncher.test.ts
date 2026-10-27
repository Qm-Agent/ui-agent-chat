import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import {
  macHelperExecutablePath,
  macProviderDaemonLaunchArguments,
  macProviderExecutableArguments,
  macProviderLaunchArguments
} from "../../native-automation/src-ts/providers.js";

test("macOS Provider 校验 Bundle 内签名可执行文件", () => {
  const appPath = path.join("/Applications", "UIWarden.app", "Contents", "Resources", "native-automation", "dt-gui-computer Provider.app");
  assert.equal(
    macHelperExecutablePath(appPath),
    path.join(appPath, "Contents", "MacOS", "dt-gui-computer-provider")
  );
});

test("macOS Provider 通过 LaunchServices 启动并使用独立响应文件", () => {
  const appPath = "/Applications/UIWarden.app/Contents/Resources/native-automation/dt-gui-computer Provider.app";
  assert.deepEqual(
    macProviderLaunchArguments(appPath, "/tmp/request.json", "/tmp/response.json", "/tmp/stages.jsonl"),
    [
      "-n", appPath, "--args",
      "--request", "/tmp/request.json",
      "--response", "/tmp/response.json",
      "--diagnostics", "/tmp/stages.jsonl"
    ]
  );
});

test("macOS Provider 可执行文件直连使用独立响应文件", () => {
  assert.deepEqual(
    macProviderExecutableArguments("/tmp/request.json", "/tmp/response.json", "/tmp/stages.jsonl"),
    [
      "--request", "/tmp/request.json",
      "--response", "/tmp/response.json",
      "--diagnostics", "/tmp/stages.jsonl"
    ]
  );
});

test("macOS Provider 常驻服务通过 LaunchServices 保持独立权限身份", () => {
  assert.deepEqual(
    macProviderDaemonLaunchArguments("/Applications/Provider.app", "/tmp/provider-daemon", 1234),
    ["-n", "/Applications/Provider.app", "--args", "--daemon-dir", "/tmp/provider-daemon", "--parent-pid", "1234"]
  );
});
