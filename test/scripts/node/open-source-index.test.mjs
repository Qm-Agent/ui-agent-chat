import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("../../../scripts/check-open-source-index.mjs", import.meta.url));
const historyChecker = fileURLToPath(new URL("../../../scripts/check-open-source-history.mjs", import.meta.url));
const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));

test("default Docker build is the public build and copies only named source paths", () => {
  const dockerfile = fs.readFileSync(path.join(projectRoot, "Dockerfile"), "utf8");
  const dockerignore = fs.readFileSync(path.join(projectRoot, "Dockerfile.dockerignore"), "utf8");
  assert.doesNotMatch(dockerfile, /^COPY\s+\.\s+\.$/m);
  assert.doesNotMatch(dockerfile, /acs-reg\.alipay\.com|artifacts\.antgroup|\bcfuse\b/i);
  assert.match(dockerfile, /^COPY vendor\/browser-use\/browser_use-3\.1\.6-\*\.whl \/tmp\/browser-use\/$/m);
  assert.match(dockerfile, /^ENV NODE_ENV=development$/m);
  for (const source of ["client", "server", "gui-runtime", "native-automation", "browser-automation", "skills"]) {
    assert.match(dockerfile, new RegExp(`^COPY ${source} \\./${source}$`, "m"));
  }
  assert.match(dockerignore, /^test-reports$/m);
  assert.match(dockerignore, /^\.skill-output$/m);
  assert.match(dockerignore, /^skills\/ui-test-assistant-skill\/config\/perference_context\/\*$/m);
  assert.match(dockerignore, /^skills\/ui-test-assistant-skill\/config\/prompt_context\/\*$/m);
  assert.match(dockerignore, /^!skills\/ui-test-assistant-skill\/config\/prompt_context\/global_readme\.md$/m);
  assert.equal(
    dockerignore,
    fs.readFileSync(path.join(projectRoot, "Dockerfile.dockerignore"), "utf8"),
    "Docker ignore manifests must stay identical"
  );
  assert.match(dockerfile, /^COPY THIRD_PARTY_NOTICES\.md \/app\/THIRD_PARTY_NOTICES\.md$/m);
  assert.match(dockerfile, /^COPY LICENSES\/browser-use-MIT\.txt \/app\/LICENSES\/browser-use-MIT\.txt$/m);
  assert.match(dockerfile, /^ARG UIWARDEN_BROWSER_USE_REDISTRIBUTION_APPROVED=false$/m);
  assert.match(dockerfile, /UIWARDEN_BROWSER_USE_REDISTRIBUTION_APPROVED="\$UIWARDEN_BROWSER_USE_REDISTRIBUTION_APPROVED"/);
  assert.match(dockerfile, /process\.env\.PORT\|\|8787/, "Docker health check must honor the configured PORT");
  for (const internalFile of ["Dockerfile.base", "Dockerfile.opensource", "aci.yml"]) {
    assert.equal(fs.existsSync(path.join(projectRoot, internalFile)), false, `${internalFile} must not be part of the public tree`);
  }
});

test("open-source check reads the Git index and build-context env examples", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uiwarden-index-check-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    const sample = path.join(root, "sample.md");
    fs.writeFileSync(sample, "SHARED_MODEL_API_KEY=fake-test-token\n");
    execFileSync("git", ["add", "sample.md"], { cwd: root });
    fs.writeFileSync(sample, "SHARED_MODEL_API_KEY=\n");

    const stagedSecret = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
    assert.equal(stagedSecret.status, 1);
    assert.match(stagedSecret.stderr, /sample\.md: populated shared model key/);

    execFileSync("git", ["add", "sample.md"], { cwd: root });
    const cleanIndex = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
    assert.equal(cleanIndex.status, 0);

    const envExample = path.join(root, ".env.example");
    fs.writeFileSync(envExample, "ANTHROPIC_AUTH_TOKEN=private-fixture-token\n");
    execFileSync("git", ["add", ".env.example"], { cwd: root });
    const populatedExample = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
    assert.equal(populatedExample.status, 1);
    assert.match(populatedExample.stderr, /ANTHROPIC_AUTH_TOKEN in index env example/);
    assert.doesNotMatch(populatedExample.stderr, /private-fixture-token/);
    fs.writeFileSync(envExample, "ANTHROPIC_AUTH_TOKEN=\n");
    execFileSync("git", ["add", ".env.example"], { cwd: root });
    fs.writeFileSync(envExample, "ANTHROPIC_AUTH_TOKEN=working-tree-fixture-token\n");
    const dirtyExample = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
    assert.equal(dirtyExample.status, 1);
    assert.match(dirtyExample.stderr, /ANTHROPIC_AUTH_TOKEN in working tree env example/);
    assert.doesNotMatch(dirtyExample.stderr, /working-tree-fixture-token/);
    fs.writeFileSync(envExample, "ANTHROPIC_AUTH_TOKEN=\n");

    const internalLink = path.join(root, "internal-link.md");
    const internalFixtureDomain = ["project", "alipay", "com"].join(".");
    fs.writeFileSync(internalLink, `https://${internalFixtureDomain}/space/W00000000000/bug\n`);
    execFileSync("git", ["add", "internal-link.md"], { cwd: root });
    const internalDomain = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
    assert.equal(internalDomain.status, 1);
    assert.match(internalDomain.stderr, /internal-link\.md: internal service domain/);
    fs.rmSync(internalLink);
    execFileSync("git", ["add", "-u"], { cwd: root });

    const privateNetwork = path.join(root, "private-network.md");
    const privateNetworkFixture = ["192", "168", "10", "20"].join(".");
    fs.writeFileSync(privateNetwork, `service=http://${privateNetworkFixture}:8080\n`);
    execFileSync("git", ["add", "private-network.md"], { cwd: root });
    const privateNetworkResult = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
    assert.equal(privateNetworkResult.status, 1);
    assert.match(privateNetworkResult.stderr, /private-network\.md: private network address/);
    assert.doesNotMatch(privateNetworkResult.stderr, new RegExp(privateNetworkFixture.replaceAll(".", "\\.")));
    fs.rmSync(privateNetwork);
    execFileSync("git", ["add", "-u"], { cwd: root });

    const credentialFile = path.join(root, "credential.md");
    const credentialFixture = ["sk", "fixturetoken0123456789012345"].join("-");
    fs.writeFileSync(credentialFile, `token=${credentialFixture}\n`);
    execFileSync("git", ["add", "credential.md"], { cwd: root });
    const credentialResult = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
    assert.equal(credentialResult.status, 1);
    assert.match(credentialResult.stderr, /credential\.md: credential-like sk token/);
    assert.doesNotMatch(credentialResult.stderr, new RegExp(credentialFixture));
    fs.rmSync(credentialFile);
    execFileSync("git", ["add", "-u"], { cwd: root });

    const personalPath = path.join(root, "personal-path.md");
    fs.writeFileSync(personalPath, ["/Users", "qiming", "private.txt"].join("/") + "\n");
    execFileSync("git", ["add", "personal-path.md"], { cwd: root });
    const personalPathResult = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
    assert.equal(personalPathResult.status, 1);
    assert.match(personalPathResult.stderr, /personal-path\.md: personal absolute path/);
    fs.rmSync(personalPath);
    execFileSync("git", ["add", "-u"], { cwd: root });

    fs.mkdirSync(path.join(root, "test-reports"));
    fs.writeFileSync(path.join(root, "test-reports", "private.txt"), "test fixture\n");
    execFileSync("git", ["add", "test-reports/private.txt"], { cwd: root });
    const stagedReport = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
    assert.equal(stagedReport.status, 1);
    assert.match(stagedReport.stderr, /test-reports\/private\.txt: sensitive output or binary is tracked/);

    execFileSync("git", ["reset", "-q", "test-reports/private.txt"], { cwd: root });
    for (const localPath of [".claude/settings.local.json", ".idea/workspace.xml", "test/data/evaluation-lab/results/run.json"]) {
      const fullPath = path.join(root, localPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, "{}\n");
      execFileSync("git", ["add", "-f", localPath], { cwd: root });
      const localConfig = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
      assert.equal(localConfig.status, 1);
      assert.match(localConfig.stderr, new RegExp(localPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      execFileSync("git", ["reset", "-q", localPath], { cwd: root });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("history check rejects reports removed from the current tree", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uiwarden-history-check-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    fs.mkdirSync(path.join(root, "test-reports"));
    fs.writeFileSync(path.join(root, "test-reports", "private.txt"), "test fixture\n");
    fs.mkdirSync(path.join(root, ".claude"));
    fs.writeFileSync(path.join(root, ".claude", "settings.local.json"), "{}\n");
    fs.mkdirSync(path.join(root, ".idea"));
    fs.writeFileSync(path.join(root, ".idea", "workspace.xml"), "<project/>\n");
    fs.mkdirSync(path.join(root, "test", "data", "evaluation-lab", "results"), { recursive: true });
    fs.writeFileSync(path.join(root, "test", "data", "evaluation-lab", "results", "run.json"), "{}\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["add", "-f", ".claude/settings.local.json", "test/data/evaluation-lab/results/run.json"], { cwd: root });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "add report"], { cwd: root });
    fs.rmSync(path.join(root, "test-reports"), { recursive: true });
    execFileSync("git", ["add", "-u"], { cwd: root });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "remove report"], { cwd: root });

    const result = spawnSync(process.execPath, [historyChecker], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /test-reports: 1 个历史路径/);
    assert.match(result.stderr, /evaluation-results: 1 个历史路径/);
    assert.match(result.stderr, /local-agent-settings: 1 个历史路径/);
    assert.match(result.stderr, /editor-settings: 1 个历史路径/);
    assert.doesNotMatch(result.stderr, /private\.txt/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("history check detects a removed model key without printing it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uiwarden-key-history-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    const envExample = path.join(root, ".env.example");
    fs.writeFileSync(envExample, "SHARED_MODEL_API_KEY=private-fixture-key\nANTHROPIC_AUTH_TOKEN=private-fixture-token\n");
    execFileSync("git", ["add", ".env.example"], { cwd: root });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "add example"], { cwd: root });
    fs.writeFileSync(envExample, "SHARED_MODEL_API_KEY=\n");
    execFileSync("git", ["add", ".env.example"], { cwd: root });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "clear example"], { cwd: root });

    const result = spawnSync(process.execPath, [historyChecker], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /populated-env-example: 1 个历史对象/);
    assert.match(result.stderr, /credential-key-names \(values suppressed\): ANTHROPIC_AUTH_TOKEN, SHARED_MODEL_API_KEY/);
    assert.doesNotMatch(result.stderr, /private-fixture-key/);
    assert.doesNotMatch(result.stderr, /private-fixture-token/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
