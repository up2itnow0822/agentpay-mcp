import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const docs = readFileSync(new URL('../docs/smithery-paid-mcp-installation.md', import.meta.url), 'utf8');
const example = readFileSync(new URL('../examples/smithery-paid-mcp-installation/README.md', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('Smithery paid MCP installation docs', () => {
  it('documents Smithery CLI without claiming live listing verification', () => {
    expect(docs).toContain('smithery mcp add up2itnow0822/agentpay-mcp');
    expect(docs).toContain('Do not claim a live verified Smithery listing');
    expect(docs).toContain('Smithery badge proves the install path is visible');
  });

  it('covers Vercel AI SDK MCP and @smithery/api TypeScript paths', () => {
    expect(docs).toContain('createMCPClient');
    expect(docs).toContain('@smithery/api/mcp');
    expect(docs).toContain('https://api.smithery.ai/sdks/typescript/up2itnow0822/agentpay-mcp/latest');
    expect(example).toContain('Vercel AI SDK MCP shape');
    expect(example).toContain('TypeScript SDK shape');
  });

  it('keeps paid-tool approval and stale-manifest gates explicit', () => {
    for (const required of [
      'AGENTPAY_DEFAULT_MAX_USDC',
      'AGENTPAY_APPROVAL_MODE',
      'AGENTPAY_MANIFEST_MAX_AGE_SECONDS',
      'human_required',
      '300',
      'no approval means no x402 signing',
      'Refusing paid MCP call because x402 manifest is stale',
    ]) {
      expect(docs).toContain(required);
    }
  });

  it('packages and links the proof', () => {
    expect(readme).toContain('docs/smithery-paid-mcp-installation.md');
    expect(readme).toContain('examples/smithery-paid-mcp-installation');
    expect(packageJson.files).toContain('examples/smithery-paid-mcp-installation/*.md');
  });
});
