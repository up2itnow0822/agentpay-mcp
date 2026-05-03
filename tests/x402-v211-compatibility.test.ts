import { describe, expect, it } from 'vitest';
import {
  X402_V211_PAYMENT_SIGNATURE_HEADER,
  X402_V211_RECEIPT_HEADER,
  X402_V211_MCP_SESSION_HEADER,
  buildCorsExposeHeaders,
  buildReceiptLink,
  x402V211CompatibilityProof,
} from '../src/utils/x402-v211-compatibility.js';

describe('x402 v2.11 compatibility proof', () => {
  it('uses the v2.11 payment and response header names', () => {
    const proof = x402V211CompatibilityProof();
    expect(proof.paymentSignatureHeader).toBe('Payment-Signature');
    expect(proof.deprecatedPaymentHeaders).toContain('X-Payment');
    expect(proof.responseHeaders).toEqual(['payment-response', 'mcp-session-id']);
    expect(X402_V211_PAYMENT_SIGNATURE_HEADER).toBe('Payment-Signature');
    expect(X402_V211_RECEIPT_HEADER).toBe('payment-response');
    expect(X402_V211_MCP_SESSION_HEADER).toBe('mcp-session-id');
  });

  it('builds browser-exposed CORS headers without duplicates', () => {
    expect(buildCorsExposeHeaders(['Content-Type', 'payment-response'])).toBe(
      'Content-Type, payment-response, mcp-session-id'
    );
  });

  it('builds network-aware Base receipt links', () => {
    const tx = `0x${'a'.repeat(64)}`;
    expect(buildReceiptLink(84532, tx)).toBe(`https://sepolia.basescan.org/tx/${tx}`);
    expect(buildReceiptLink(8453, tx)).toBe(`https://basescan.org/tx/${tx}`);
    expect(() => buildReceiptLink(1, tx)).toThrow('Unsupported receipt chain');
  });

  it('documents initialize before tools/list and tools/call', () => {
    const proof = x402V211CompatibilityProof();
    expect(proof.streamableHttpSequence.join('\n')).toContain('initialize');
    expect(proof.streamableHttpSequence.join('\n')).toContain('tools/list');
    expect(proof.streamableHttpSequence.join('\n')).toContain('tools/call');
  });
});
