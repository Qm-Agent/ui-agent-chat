export type DefectProviderId = string;

export interface DefectProviderDefinition {
  id: DefectProviderId;
  displayName: string;
  configurable: boolean;
  supports: DefectIntegrationCapabilities["supports"];
}

export interface DefectIntegrationCapabilities {
  enabled: boolean;
  provider?: DefectProviderId;
  displayName?: string;
  configurable: boolean;
  supports: {
    create: boolean;
    attachments: boolean;
    userResolution: boolean;
    evidenceBundle: boolean;
  };
}

const DISABLED_CAPABILITIES: DefectIntegrationCapabilities = {
  enabled: false,
  configurable: false,
  supports: {
    create: false,
    attachments: false,
    userResolution: false,
    evidenceBundle: false
  }
};

const providerDefinitions = new Map<string, DefectProviderDefinition>();

/** Registers an adapter supplied by a private deployment or future plugin. */
export function registerDefectProvider(definition: DefectProviderDefinition): void {
  const id = definition.id.trim().toLowerCase();
  if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error("Defect provider id must contain lowercase letters, numbers, or hyphens");
  }
  providerDefinitions.set(id, { ...definition, id });
}

/** Test and plugin lifecycle helper. */
export function unregisterDefectProvider(provider: DefectProviderId): void {
  providerDefinitions.delete(provider.trim().toLowerCase());
}

/**
 * Selects an optional defect provider. Open-source distributions default to no
 * provider; private deployments can explicitly register their adapter.
 */
export function selectedDefectProvider(env: NodeJS.ProcessEnv = process.env): DefectProviderId | undefined {
  const requested = env.UIWARDEN_DEFECT_PROVIDER?.trim().toLowerCase();
  return requested && providerDefinitions.has(requested) ? requested : undefined;
}

export function isDefectProviderEnabled(
  provider: DefectProviderId,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return selectedDefectProvider(env) === provider;
}

export function getDefectIntegrationCapabilities(
  env: NodeJS.ProcessEnv = process.env
): DefectIntegrationCapabilities {
  const provider = selectedDefectProvider(env);
  const definition = provider ? providerDefinitions.get(provider) : undefined;
  if (!provider || !definition) return structuredClone(DISABLED_CAPABILITIES);
  return {
    enabled: true,
    provider,
    displayName: definition.displayName,
    configurable: definition.configurable,
    supports: structuredClone(definition.supports)
  };
}
