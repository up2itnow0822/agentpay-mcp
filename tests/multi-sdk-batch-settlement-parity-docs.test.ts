import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const docs = readFileSync('docs/x402-multi-sdk-batch-settlement-parity.md', 'utf8');

describe('x402 multi-SDK batch-settlement parity docs', () => {
  it('covers TS and Go channel-state parity for AgentPay MCP', () => {
    expect(docs).toContain('TypeScript and Go clients');
    expect(docs).toContain('same `channelId` derivation inputs');
    expect(docs).toContain('channel_config_hash');
    expect(docs).toContain('sdk_matrix');
  });

  it('requires the PR #2164 phased e2e proof names', () => {
    expect(docs).toContain('`initial`: deposit plus first voucher');
    expect(docs).toContain('`recovery-refund`: corrective recovery voucher plus cooperative refund');
    expect(docs).toContain('`full`: deposit, voucher, and refund');
    expect(docs).toContain('x402_batch_sdk_parity_phase');
  });

  it('documents signer separation and authorizer expectations', () => {
    expect(docs).toContain('EVM_VOUCHER_SIGNER_PRIVATE_KEY');
    expect(docs).toContain('payerAuthorizer');
    expect(docs).toContain('receiver authorizer');
    expect(docs).toContain('facilitator signer');
  });

  it('requires recovery, refund, and proof bundle visibility', () => {
    expect(docs).toContain('corrective 402 code');
    expect(docs).toContain('outstanding signed max claimable before refund');
    expect(docs).toContain('claim-before-refund behavior');
    expect(docs).toContain('The proof should link to CI output or a local validation artifact');
  });
});
