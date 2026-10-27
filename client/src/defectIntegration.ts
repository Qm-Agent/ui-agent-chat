export interface DefectIntegrationCapabilities {
  enabled: boolean;
  provider?: string;
  displayName?: string;
  configurable: boolean;
  supports: {
    create: boolean;
    attachments: boolean;
    userResolution: boolean;
    evidenceBundle: boolean;
  };
}

export const DISABLED_DEFECT_INTEGRATION: DefectIntegrationCapabilities = {
  enabled: false,
  configurable: false,
  supports: {
    create: false,
    attachments: false,
    userResolution: false,
    evidenceBundle: false
  }
};

export function isDefectIntegrationEnabled(capabilities: DefectIntegrationCapabilities): boolean {
  return capabilities.enabled && Boolean(capabilities.provider);
}
