import { describe, expect, it } from 'vitest';
import {
  buildTronWalletActionPreflightExample,
  evaluateWalletActionPreflight,
} from '../src/utils/wallet-action-preflight-profile.js';

describe('wallet-action preflight profile', () => {
  it('allows an irreversible TRON resource action only after simulation, caps, allowlists, and approval copy pass', () => {
    const decision = evaluateWalletActionPreflight(buildTronWalletActionPreflightExample());
    expect(decision.ok).toBe(true);
    expect(decision.decision).toBe('allow');
    expect(decision.failures).toEqual([]);
    expect(decision.approvalPrompt).toContain('Approve TRON wallet resource purchase?');
    expect(decision.approvalPrompt).toContain('Resource cost: max 1.0 TRX network fee');
  });

  it('denies signing when simulation is missing', () => {
    const profile = buildTronWalletActionPreflightExample();
    profile.simulation.status = 'missing';
    const decision = evaluateWalletActionPreflight(profile);
    expect(decision.ok).toBe(false);
    expect(decision.failures).toContain('simulation status missing is not passed.');
  });

  it('denies signing when recipient, resource cost, or amount exceed policy', () => {
    const profile = buildTronWalletActionPreflightExample();
    profile.action.recipient = 'TUnknownRecipient2222222222222222222222222';
    profile.action.amount = '50';
    profile.simulation.resourceEstimate.maxNetworkFee = '3.5';
    const decision = evaluateWalletActionPreflight(profile);
    expect(decision.ok).toBe(false);
    expect(decision.failures).toContain('action amount 50 exceeds per-action cap 25.');
    expect(decision.failures).toContain('network fee 3.5 exceeds cap 2.5.');
    expect(decision.failures).toContain('recipient TUnknownRecipient2222222222222222222222222 is not allowlisted.');
  });
});
