import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const docs = readFileSync('docs/x402-bazaar-observability.md', 'utf8');

describe('x402 Bazaar observability docs', () => {
  it('covers searchable Bazaar metadata for paid MCP tools', () => {
    expect(docs).toContain('WithBazaar SDK wrappers now support search');
    expect(docs).toContain('client.extensions.bazaar.search');
    expect(docs).toContain('type: "mcp"');
    expect(docs).toContain('extensions: "bazaar"');
    expect(docs).toContain('input.tool');
    expect(docs).toContain('input.inputSchema');
  });

  it('requires unified auth for Bazaar, verify, settle, and supported', () => {
    expect(docs).toContain('createAuthHeaders');
    expect(docs).toContain('verify:');
    expect(docs).toContain('settle:');
    expect(docs).toContain('supported:');
    expect(docs).toContain('bazaar:');
  });

  it('documents EXTENSION-RESPONSES readback and sanitized logging', () => {
    expect(docs).toContain('EXTENSION-RESPONSES');
    expect(docs).toContain('verify_extension_responses');
    expect(docs).toContain('settle_extension_responses');
    expect(docs).toContain('rejectedReason');
    expect(docs).toContain('Never log full request bodies, auth headers, private keys, payment signatures, or customer contact data');
  });
});
