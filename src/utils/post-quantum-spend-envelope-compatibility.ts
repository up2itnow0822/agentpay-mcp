/**
 * Post-quantum spend-envelope compatibility mapping.
 *
 * This file documents compatibility at the receipt and policy layer only. It
 * does not claim ML-DSA signing, post-quantum key generation, or audit-ledger
 * publication. Those claims must come from cryptographic tests and package
 * inspection before they appear in AgentPay product docs.
 */

export type AgentPaySpendControl = {
  name: 'spend_limit' | 'allowlist' | 'x402_receipt' | 'approval_gate' | 'audit_metadata';
  agentpayField: string;
  envelopeConcept: string;
  compatibility: 'compatible' | 'requires_adapter' | 'not_implemented';
  nonClaim: string;
};

export type SpendEnvelopeCompatibilityReport = {
  status: 'assessment_only';
  controls: AgentPaySpendControl[];
  unsupportedClaims: string[];
};

export function buildPostQuantumSpendEnvelopeCompatibilityReport(): SpendEnvelopeCompatibilityReport {
  return {
    status: 'assessment_only',
    controls: [
      {
        name: 'spend_limit',
        agentpayField: 'SpendingPolicy.maxPerTx / dailyCap',
        envelopeConcept: 'maximum authorized spend inside a signed envelope',
        compatibility: 'compatible',
        nonClaim: 'AgentPay does not claim post-quantum signature enforcement for this field.',
      },
      {
        name: 'allowlist',
        agentpayField: 'allowedNetworks / allowedAssets / allowedPayTo',
        envelopeConcept: 'recipient, asset, and route constraints attached to spend intent',
        compatibility: 'compatible',
        nonClaim: 'AgentPay does not claim third-party AP2 or ACP envelope validation without an adapter.',
      },
      {
        name: 'x402_receipt',
        agentpayField: 'x402 receipt id, payment metadata, and settlement reference',
        envelopeConcept: 'receipt pointer for audit and reconciliation',
        compatibility: 'requires_adapter',
        nonClaim: 'AgentPay receipts are not ML-DSA envelopes unless a tested signer creates that envelope.',
      },
      {
        name: 'approval_gate',
        agentpayField: 'approval accepted / declined / cancelled before signing',
        envelopeConcept: 'human or policy approval prior to spend execution',
        compatibility: 'compatible',
        nonClaim: 'AgentPay approval gates do not prove post-quantum identity by themselves.',
      },
      {
        name: 'audit_metadata',
        agentpayField: 'agent_id, task_id, policy_version, receipt_id',
        envelopeConcept: 'audit ledger payload',
        compatibility: 'requires_adapter',
        nonClaim: 'AgentPay does not claim Arbitrum audit-ledger publication from this assessment.',
      },
    ],
    unsupportedClaims: [
      'ML-DSA-65 signing',
      'post-quantum key lifecycle',
      'AP2 envelope conformance',
      'ACP envelope conformance',
      'Arbitrum audit-ledger publication',
    ],
  };
}
