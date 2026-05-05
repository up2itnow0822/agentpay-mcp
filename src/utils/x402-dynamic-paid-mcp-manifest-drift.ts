/**
 * Dynamic paid MCP manifest drift helpers.
 *
 * Paid MCP gateways can change discovery metadata during launch week without a
 * package version bump. Buyers need to validate the live .well-known/x402
 * snapshot before routing, not trust a launch article or stale directory card.
 */

export type DriftSeverity = 'info' | 'warning' | 'critical';

export type DriftFinding = {
  severity: DriftSeverity;
  field: string;
  message: string;
};

export type PaidMcpNetworkDescriptor = {
  network: string;
  name: string;
  gateway: string;
};

export type PaidMcpTrialPolicySnapshot = {
  enabled: boolean;
  description: string;
};

export type PaidMcpPricingSnapshot = {
  endpointCount: number;
  endpointsWithPrice: number;
  endpointsWithPriceAtomic: number;
  minimumPriceUsd?: string;
  distinctPrices: string[];
};

export type PaidMcpDirectorySnapshot = {
  wellKnownX402: string;
  openapi?: string;
  documentation?: string;
  mcpCatalog?: string;
  frameworks: Record<string, string>;
};

export type DynamicPaidMcpManifestSnapshot = {
  snapshotId: string;
  sourceUrl: string;
  capturedAt: string;
  commitSha?: string;
  x402Version: number | string;
  organization: string;
  primaryNetwork: string;
  supportedNetworks: PaidMcpNetworkDescriptor[];
  facilitator?: string;
  hasPayTo: boolean;
  capabilities: string[];
  mcp: {
    totalTools: number;
    totalServices?: number;
    protocol?: string;
    catalog?: string;
  };
  trial: PaidMcpTrialPolicySnapshot;
  pricing: PaidMcpPricingSnapshot;
  directories: PaidMcpDirectorySnapshot;
};

export type DynamicPaidMcpManifestValidationOptions = {
  now?: Date;
  maxSnapshotAgeHours?: number;
};

export type DynamicPaidMcpManifestValidationReport = {
  snapshotId: string;
  ageHours: number;
  stale: boolean;
  hasSupportedNetworks: boolean;
  hasPricingClarity: boolean;
  hasTrialPolicyClarity: boolean;
  hasDirectoryEndpointFreshness: boolean;
  findings: DriftFinding[];
};

export type DynamicPaidMcpManifestDriftReport = {
  fromSnapshotId: string;
  toSnapshotId: string;
  changedFields: string[];
  findings: DriftFinding[];
};

const DEFAULT_MAX_SNAPSHOT_AGE_HOURS = 24;

function isHttpsUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function hoursBetween(later: Date, earlier: Date): number {
  return Math.max(0, (later.getTime() - earlier.getTime()) / (1000 * 60 * 60));
}

function pushFinding(findings: DriftFinding[], severity: DriftSeverity, field: string, message: string): void {
  findings.push({ severity, field, message });
}

export function validateDynamicPaidMcpManifestSnapshot(
  snapshot: DynamicPaidMcpManifestSnapshot,
  options: DynamicPaidMcpManifestValidationOptions = {}
): DynamicPaidMcpManifestValidationReport {
  const findings: DriftFinding[] = [];
  const now = options.now ?? new Date();
  const maxSnapshotAgeHours = options.maxSnapshotAgeHours ?? DEFAULT_MAX_SNAPSHOT_AGE_HOURS;
  const capturedAt = new Date(snapshot.capturedAt);
  const ageHours = Number.isFinite(capturedAt.getTime()) ? hoursBetween(now, capturedAt) : Number.POSITIVE_INFINITY;
  const stale = ageHours > maxSnapshotAgeHours;

  if (!snapshot.snapshotId.trim()) pushFinding(findings, 'critical', 'snapshotId', 'snapshotId is required');
  if (!isHttpsUrl(snapshot.sourceUrl)) pushFinding(findings, 'critical', 'sourceUrl', 'sourceUrl must be an https URL');
  if (!Number.isFinite(capturedAt.getTime())) pushFinding(findings, 'critical', 'capturedAt', 'capturedAt must be an ISO timestamp');
  if (stale) pushFinding(findings, 'warning', 'capturedAt', `snapshot is older than ${maxSnapshotAgeHours} hours; refresh before buyer routing`);
  if (!snapshot.organization.trim()) pushFinding(findings, 'critical', 'organization', 'organization is required');
  if (!snapshot.primaryNetwork.trim()) pushFinding(findings, 'critical', 'primaryNetwork', 'primaryNetwork is required');

  const hasSupportedNetworks = snapshot.supportedNetworks.length > 0;
  if (!hasSupportedNetworks) pushFinding(findings, 'critical', 'supportedNetworks', 'at least one supported network descriptor is required');
  for (const [index, network] of snapshot.supportedNetworks.entries()) {
    if (!network.network.trim()) pushFinding(findings, 'critical', `supportedNetworks[${index}].network`, 'network is required');
    if (!network.name.trim()) pushFinding(findings, 'warning', `supportedNetworks[${index}].name`, 'network name should be explicit');
    if (!isHttpsUrl(network.gateway)) pushFinding(findings, 'critical', `supportedNetworks[${index}].gateway`, 'gateway must be an https URL');
  }

  if (!snapshot.facilitator) pushFinding(findings, 'warning', 'facilitator', 'facilitator metadata is missing');
  if (!snapshot.hasPayTo) pushFinding(findings, 'critical', 'hasPayTo', 'payTo recipient must be present before payment');
  if (snapshot.mcp.totalTools <= 0) pushFinding(findings, 'critical', 'mcp.totalTools', 'totalTools must be greater than zero');
  if (snapshot.mcp.totalServices !== undefined && snapshot.mcp.totalServices <= 0) {
    pushFinding(findings, 'warning', 'mcp.totalServices', 'totalServices should be greater than zero when present');
  }
  if (snapshot.pricing.endpointCount > 0 && snapshot.pricing.endpointCount !== snapshot.mcp.totalTools) {
    pushFinding(
      findings,
      'info',
      'pricing.endpointCount',
      'priced HTTP endpoint count differs from MCP totalTools; do not assume a one-to-one mapping'
    );
  }

  const hasPricingClarity =
    snapshot.pricing.endpointCount > 0 &&
    snapshot.pricing.endpointsWithPrice === snapshot.pricing.endpointCount &&
    snapshot.pricing.endpointsWithPriceAtomic === snapshot.pricing.endpointCount &&
    snapshot.pricing.distinctPrices.length > 0;
  if (!hasPricingClarity) {
    pushFinding(findings, 'critical', 'pricing', 'pricing fields must be present for every paid endpoint in the snapshot');
  }

  const hasTrialPolicyClarity = typeof snapshot.trial.enabled === 'boolean' && Boolean(snapshot.trial.description.trim());
  if (!hasTrialPolicyClarity) {
    pushFinding(findings, 'critical', 'trial', 'trial policy must be explicit, including no-trial cases');
  }
  if (!snapshot.trial.enabled && snapshot.capabilities.some((capability) => capability.toLowerCase().includes('free_trial'))) {
    pushFinding(
      findings,
      'warning',
      'capabilities.free_trial',
      'capabilities still advertises free_trial while trial.enabled is false; buyer agents should trust the explicit trial object and refresh directory cards'
    );
  }
  if (snapshot.trial.enabled && /0 free|no free/i.test(snapshot.trial.description)) {
    pushFinding(findings, 'critical', 'trial.description', 'trial.enabled conflicts with no-trial description');
  }

  const frameworkUrls = Object.values(snapshot.directories.frameworks);
  const hasDirectoryEndpointFreshness =
    isHttpsUrl(snapshot.directories.wellKnownX402) &&
    isHttpsUrl(snapshot.directories.mcpCatalog) &&
    isHttpsUrl(snapshot.directories.openapi) &&
    isHttpsUrl(snapshot.directories.documentation) &&
    frameworkUrls.length > 0 &&
    frameworkUrls.every(isHttpsUrl);
  if (!hasDirectoryEndpointFreshness) {
    pushFinding(findings, 'critical', 'directories', 'well-known, MCP catalog, OpenAPI, documentation, and framework endpoints must be https URLs');
  }

  return {
    snapshotId: snapshot.snapshotId,
    ageHours,
    stale,
    hasSupportedNetworks,
    hasPricingClarity,
    hasTrialPolicyClarity,
    hasDirectoryEndpointFreshness,
    findings,
  };
}

function changed<T>(field: string, before: T, after: T, changedFields: string[]): boolean {
  const didChange = JSON.stringify(before) !== JSON.stringify(after);
  if (didChange) changedFields.push(field);
  return didChange;
}

export function compareDynamicPaidMcpManifestSnapshots(
  before: DynamicPaidMcpManifestSnapshot,
  after: DynamicPaidMcpManifestSnapshot
): DynamicPaidMcpManifestDriftReport {
  const changedFields: string[] = [];
  const findings: DriftFinding[] = [];

  if (changed('mcp.totalTools', before.mcp.totalTools, after.mcp.totalTools, changedFields)) {
    pushFinding(findings, 'warning', 'mcp.totalTools', `tool count changed from ${before.mcp.totalTools} to ${after.mcp.totalTools}`);
  }
  if (changed('mcp.totalServices', before.mcp.totalServices, after.mcp.totalServices, changedFields)) {
    pushFinding(findings, 'warning', 'mcp.totalServices', `service count changed from ${before.mcp.totalServices ?? 'unknown'} to ${after.mcp.totalServices ?? 'unknown'}`);
  }
  if (changed('trial.enabled', before.trial.enabled, after.trial.enabled, changedFields)) {
    pushFinding(findings, 'critical', 'trial.enabled', `trial policy changed from ${before.trial.enabled} to ${after.trial.enabled}`);
  }
  if (changed('trial.description', before.trial.description, after.trial.description, changedFields)) {
    pushFinding(findings, 'warning', 'trial.description', 'trial policy description changed; refresh buyer-facing directory metadata');
  }
  if (changed('pricing.distinctPrices', before.pricing.distinctPrices, after.pricing.distinctPrices, changedFields)) {
    pushFinding(findings, 'warning', 'pricing.distinctPrices', 'advertised price surface changed');
  }
  if (changed('supportedNetworks', before.supportedNetworks, after.supportedNetworks, changedFields)) {
    pushFinding(findings, 'warning', 'supportedNetworks', 'supported network descriptors changed');
  }
  if (changed('directories', before.directories, after.directories, changedFields)) {
    pushFinding(findings, 'warning', 'directories', 'directory or framework endpoint URLs changed');
  }
  if (changed('commitSha', before.commitSha, after.commitSha, changedFields)) {
    pushFinding(findings, 'info', 'commitSha', 'source commit changed; use the newer snapshot for routing');
  }

  return {
    fromSnapshotId: before.snapshotId,
    toSnapshotId: after.snapshotId,
    changedFields,
    findings,
  };
}

export function assertNoStaticPaidMcpManifestAssumptions(
  baseline: DynamicPaidMcpManifestSnapshot,
  latest: DynamicPaidMcpManifestSnapshot
): DynamicPaidMcpManifestDriftReport {
  const drift = compareDynamicPaidMcpManifestSnapshots(baseline, latest);
  const changedCriticalFields = new Set(drift.changedFields);
  if (changedCriticalFields.has('mcp.totalTools') || changedCriticalFields.has('trial.enabled') || changedCriticalFields.has('directories')) {
    return drift;
  }
  return drift;
}
