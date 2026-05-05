/**
 * Wallet-action MCP preflight helpers.
 *
 * Wallet-action MCP servers can expose transfers, swaps, energy buys, and other
 * irreversible actions. Buyer agents should require simulation, spend caps,
 * resource caps, allowlists, and approval copy before any signature is made.
 */

export type WalletActionKind = 'transfer' | 'swap' | 'resource_purchase' | 'approval' | 'other';
export type WalletPreflightStatus = 'passed' | 'failed' | 'missing';

export type WalletActionPreflightProfile = {
  schema: 'agentpay-wallet-action-preflight/v1';
  source: {
    name: string;
    repo?: string;
    evidenceUrl?: string;
    observedAt: string;
  };
  action: {
    kind: WalletActionKind;
    chainNamespace: 'eip155' | 'tvm' | 'xrpl' | 'solana' | 'other';
    chainId?: string | number;
    asset: string;
    amount: string;
    recipient: string;
    nonce?: string;
    irreversible: true;
  };
  simulation: {
    required: true;
    status: WalletPreflightStatus;
    simulationId?: string;
    expectedOutcome: string;
    resourceEstimate: {
      feeAsset: string;
      maxNetworkFee: string;
      energy?: number;
      bandwidth?: number;
      computeUnits?: number;
    };
  };
  policy: {
    perActionSpendCap: string;
    dailyChainSpendCap: string;
    allowedRecipients: string[];
    allowedAssets: string[];
    resourceCaps: {
      maxNetworkFee: string;
      maxEnergy?: number;
      maxBandwidth?: number;
      maxComputeUnits?: number;
    };
    requireHumanApproval: boolean;
  };
  approvalCopy: {
    title: string;
    summary: string;
    lineItems: string[];
    irreversibleWarning: string;
  };
};

export type WalletActionPreflightDecision = {
  ok: boolean;
  decision: 'allow' | 'deny';
  failures: string[];
  warnings: string[];
  approvalPrompt: string;
};

function parseAmount(value: string): number {
  const cleaned = value.replace(/,/g, '').trim();
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function includesCaseInsensitive(values: string[], value: string): boolean {
  return values.map((entry) => entry.toLowerCase()).includes(value.toLowerCase());
}

function requireText(value: string, label: string, failures: string[]): void {
  if (!value || !value.trim()) failures.push(`${label} is required.`);
}

export function evaluateWalletActionPreflight(profile: WalletActionPreflightProfile): WalletActionPreflightDecision {
  const failures: string[] = [];
  const warnings: string[] = [];

  if (profile.schema !== 'agentpay-wallet-action-preflight/v1') failures.push('schema must be agentpay-wallet-action-preflight/v1.');
  requireText(profile.source.name, 'source.name', failures);
  requireText(profile.source.observedAt, 'source.observedAt', failures);
  requireText(profile.action.asset, 'action.asset', failures);
  requireText(profile.action.amount, 'action.amount', failures);
  requireText(profile.action.recipient, 'action.recipient', failures);
  requireText(profile.simulation.expectedOutcome, 'simulation.expectedOutcome', failures);
  requireText(profile.approvalCopy.title, 'approvalCopy.title', failures);
  requireText(profile.approvalCopy.summary, 'approvalCopy.summary', failures);
  requireText(profile.approvalCopy.irreversibleWarning, 'approvalCopy.irreversibleWarning', failures);

  if (!profile.simulation.required) failures.push('simulation.required must be true.');
  if (profile.simulation.status !== 'passed') failures.push(`simulation status ${profile.simulation.status} is not passed.`);
  if (profile.action.irreversible !== true) failures.push('wallet-action preflight applies to irreversible actions and must declare irreversible=true.');

  const actionAmount = parseAmount(profile.action.amount);
  const perActionCap = parseAmount(profile.policy.perActionSpendCap);
  const networkFee = parseAmount(profile.simulation.resourceEstimate.maxNetworkFee);
  const maxNetworkFee = parseAmount(profile.policy.resourceCaps.maxNetworkFee);

  if (Number.isNaN(actionAmount)) failures.push('action.amount must be numeric.');
  if (Number.isNaN(perActionCap)) failures.push('policy.perActionSpendCap must be numeric.');
  if (!Number.isNaN(actionAmount) && !Number.isNaN(perActionCap) && actionAmount > perActionCap) {
    failures.push(`action amount ${profile.action.amount} exceeds per-action cap ${profile.policy.perActionSpendCap}.`);
  }

  if (Number.isNaN(networkFee)) failures.push('simulation.resourceEstimate.maxNetworkFee must be numeric.');
  if (Number.isNaN(maxNetworkFee)) failures.push('policy.resourceCaps.maxNetworkFee must be numeric.');
  if (!Number.isNaN(networkFee) && !Number.isNaN(maxNetworkFee) && networkFee > maxNetworkFee) {
    failures.push(`network fee ${profile.simulation.resourceEstimate.maxNetworkFee} exceeds cap ${profile.policy.resourceCaps.maxNetworkFee}.`);
  }

  if (profile.policy.resourceCaps.maxEnergy !== undefined && profile.simulation.resourceEstimate.energy !== undefined && profile.simulation.resourceEstimate.energy > profile.policy.resourceCaps.maxEnergy) {
    failures.push(`energy ${profile.simulation.resourceEstimate.energy} exceeds cap ${profile.policy.resourceCaps.maxEnergy}.`);
  }

  if (profile.policy.resourceCaps.maxBandwidth !== undefined && profile.simulation.resourceEstimate.bandwidth !== undefined && profile.simulation.resourceEstimate.bandwidth > profile.policy.resourceCaps.maxBandwidth) {
    failures.push(`bandwidth ${profile.simulation.resourceEstimate.bandwidth} exceeds cap ${profile.policy.resourceCaps.maxBandwidth}.`);
  }

  if (!includesCaseInsensitive(profile.policy.allowedAssets, profile.action.asset)) {
    failures.push(`asset ${profile.action.asset} is not allowlisted.`);
  }

  if (!includesCaseInsensitive(profile.policy.allowedRecipients, profile.action.recipient)) {
    failures.push(`recipient ${profile.action.recipient} is not allowlisted.`);
  }

  if (profile.approvalCopy.lineItems.length < 4) {
    failures.push('approvalCopy.lineItems must include recipient, amount, simulation, and resource-cost lines.');
  }

  if (!profile.policy.requireHumanApproval) {
    warnings.push('Human approval is disabled. Irreversible wallet actions should normally require approval copy review.');
  }

  const approvalPrompt = [
    profile.approvalCopy.title,
    profile.approvalCopy.summary,
    ...profile.approvalCopy.lineItems.map((item) => `- ${item}`),
    profile.approvalCopy.irreversibleWarning,
  ].join('\n');

  const ok = failures.length === 0;
  return {
    ok,
    decision: ok ? 'allow' : 'deny',
    failures,
    warnings,
    approvalPrompt,
  };
}

export function buildTronWalletActionPreflightExample(): WalletActionPreflightProfile {
  return {
    schema: 'agentpay-wallet-action-preflight/v1',
    source: {
      name: 'merx-mcp market signal',
      repo: 'nicosmall503/merx-mcp',
      evidenceUrl: 'https://github.com/nicosmall503/merx-mcp',
      observedAt: '2026-05-05T01:10:00.000Z',
    },
    action: {
      kind: 'resource_purchase',
      chainNamespace: 'tvm',
      chainId: 'tron-mainnet',
      asset: 'TRX',
      amount: '12.5',
      recipient: 'TAllowlistedRecipient111111111111111111111',
      nonce: 'simulation-required-before-nonce-lock',
      irreversible: true,
    },
    simulation: {
      required: true,
      status: 'passed',
      simulationId: 'merx-style-tron-resource-sim-2026-05-05',
      expectedOutcome: 'Buy bandwidth or energy for one allowlisted wallet action without transferring custody.',
      resourceEstimate: {
        feeAsset: 'TRX',
        maxNetworkFee: '1.0',
        energy: 25000,
        bandwidth: 600,
      },
    },
    policy: {
      perActionSpendCap: '25',
      dailyChainSpendCap: '100',
      allowedRecipients: ['TAllowlistedRecipient111111111111111111111'],
      allowedAssets: ['TRX', 'USDT', 'USDC', 'USDD'],
      resourceCaps: {
        maxNetworkFee: '2.5',
        maxEnergy: 50000,
        maxBandwidth: 1000,
      },
      requireHumanApproval: true,
    },
    approvalCopy: {
      title: 'Approve TRON wallet resource purchase?',
      summary: 'AgentPay detected an irreversible wallet-action request. Simulation passed and policy caps are satisfied.',
      lineItems: [
        'Recipient: TAllowlistedRecipient111111111111111111111',
        'Amount: 12.5 TRX, cap 25 TRX per action',
        'Simulation: merx-style-tron-resource-sim-2026-05-05 passed',
        'Resource cost: max 1.0 TRX network fee, 25,000 energy, 600 bandwidth',
      ],
      irreversibleWarning: 'Signing will authorize an irreversible TRON resource purchase. Decline if recipient, amount, or resource estimate differs from the intended task.',
    },
  };
}
