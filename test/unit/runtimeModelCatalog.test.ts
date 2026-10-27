import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCfuseModelCatalog,
  parseCodexModelCatalog,
  parseDtcoderModelCatalog
} from "../../server/src/executionRuntime.js";

test("CFuse 模型目录只保留当前引擎可见模型", () => {
  const models = parseCfuseModelCatalog({
    data: [
      { model: "antchat/GLM-5.2", displayName: "GLM-5.2", engine: ["cfuse"], visible: true },
      { model: "antchat/hidden", displayName: "Hidden", engine: ["cfuse"], visible: false },
      { model: "codex/only", displayName: "Codex only", engine: ["codex"], visible: true }
    ]
  });
  assert.deepEqual(models.map((item) => item.id), ["antchat/GLM-5.2"]);
  assert.equal(models[0].label, "GLM-5.2");
});

test("Codex 本地缓存转换为稳定模型选项", () => {
  const models = parseCodexModelCatalog({
    models: [
      { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list", supported_in_api: true },
      { slug: "hidden", display_name: "Hidden", visibility: "hide", supported_in_api: true }
    ]
  });
  assert.deepEqual(models.map((item) => item.id), ["gpt-5.6-sol"]);
});

test("DTCoder 模型 ID 保留 provider 前缀以便命令行精确选择", () => {
  const models = parseDtcoderModelCatalog({
    models: [
      {
        provider: "dtcoder-router-domestic",
        model_id: "glm-5.2",
        name: "glm-5.2",
        reasoning: true
      }
    ]
  });
  assert.equal(models[0].id, "dtcoder-router-domestic/glm-5.2");
  assert.equal(models[0].provider, "dtcoder-router-domestic");
  assert.equal(models[0].description, "支持推理");
});
