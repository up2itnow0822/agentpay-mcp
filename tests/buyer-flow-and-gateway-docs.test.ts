import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const buyerDoc = readFileSync(new URL('../docs/agentpay-buyer-flow-parity.md', import.meta.url), 'utf8');
const gatewayDoc = readFileSync(new URL('../docs/paid-mcp-gateway-hardening.md', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const buyerSource = readFileSync(new URL('../src/utils/x402-buyer-flow.ts', import.meta.url), 'utf8');
const gatewaySource = readFileSync(new URL('../src/utils/paid-mcp-gateway-hardening.ts', import.meta.url), 'utf8');

describe('buyer flow and paid MCP gateway hardening docs', () => {
  it('documents AgentScore Pay buyer-flow parity without claiming an AgentPay CLI clone', () => {
    for (const required of [
      'discover',
      'check',
      'dry-run',
      'pay',
      'Spend cap',
      'idempotency',
      'MCP tools',
      'audit',
      '@agent-score/pay@0.1.0-rc.13',
      'PaymentRequiredError',
      'QuotaExceededError',
      'TokenExpiredError',
      'X-Quota-*',
      'retry_after_quota_reset',
      'no-charge failure semantics',
      'Do not claim AgentPay MCP has a one-command buyer CLI',
    ]) {
      expect(buyerDoc).toContain(required);
    }
    expect(buyerSource).toContain('verifyX402BuyerFlow');
    expect(buyerSource).toContain('createX402IdempotencyKey');
    expect(buyerSource).toContain('classifyX402PaymentError');
  });

  it('documents create-mcpay gateway hardening checks as testable controls', () => {
    for (const required of [
      'create-mcpay@0.7.1',
      'Signup and challenge parsing',
      'Key minting',
      'Atomic billing',
      'Scope defaults',
      'Buyer audit trail',
      'no-charge validation failures',
      'verifyPaidMcpGatewayHardening',
    ]) {
      expect(gatewayDoc).toContain(required);
    }
    expect(gatewaySource).toContain('verifyPaidMcpGatewayHardening');
    expect(gatewaySource).toContain('defaultDeny');
  });

  it('links both response artifacts from the README', () => {
    expect(readme).toContain('docs/agentpay-buyer-flow-parity.md');
    expect(readme).toContain('docs/paid-mcp-gateway-hardening.md');
    expect(readme).toContain('typed payment errors');
    expect(readme).toContain('quota envelopes');
  });
});
