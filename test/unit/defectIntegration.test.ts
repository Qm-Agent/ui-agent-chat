import test from "node:test";
import assert from "node:assert/strict";
import {
  getDefectIntegrationCapabilities,
  isDefectProviderEnabled,
  registerDefectProvider,
  selectedDefectProvider,
  unregisterDefectProvider
} from "../../server/src/defectIntegration.js";

test("open-source defect integration is disabled by default", () => {
  const env = {} as NodeJS.ProcessEnv;
  assert.equal(selectedDefectProvider(env), undefined);
  assert.equal(isDefectProviderEnabled("jira", env), false);
  assert.equal(getDefectIntegrationCapabilities(env).enabled, false);
});

test("a deployment can register and select a defect adapter", () => {
  registerDefectProvider({
    id: "sample-tracker",
    displayName: "Sample Tracker",
    configurable: true,
    supports: { create: true, attachments: true, userResolution: false, evidenceBundle: true }
  });
  try {
    const env = { UIWARDEN_DEFECT_PROVIDER: " SAMPLE-TRACKER " } as NodeJS.ProcessEnv;
    assert.equal(selectedDefectProvider(env), "sample-tracker");
    assert.equal(isDefectProviderEnabled("sample-tracker", env), true);
    assert.deepEqual(getDefectIntegrationCapabilities(env), {
      enabled: true,
      provider: "sample-tracker",
      displayName: "Sample Tracker",
      configurable: true,
      supports: { create: true, attachments: true, userResolution: false, evidenceBundle: true }
    });
  } finally {
    unregisterDefectProvider("sample-tracker");
  }
});

test("unknown providers fail closed and invalid ids are rejected", () => {
  const env = { UIWARDEN_DEFECT_PROVIDER: "unknown" } as NodeJS.ProcessEnv;
  assert.equal(selectedDefectProvider(env), undefined);
  assert.throws(() => registerDefectProvider({
    id: "Invalid Provider",
    displayName: "Invalid",
    configurable: false,
    supports: { create: false, attachments: false, userResolution: false, evidenceBundle: false }
  }), /provider id/i);
});
