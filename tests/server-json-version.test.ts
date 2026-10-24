import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('MCP registry metadata', () => {
  it('server.json versions match package.json', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const server = JSON.parse(readFileSync('server.json', 'utf8'));
    expect(server.version).toBe(pkg.version);
    for (const p of server.packages ?? []) expect(p.version).toBe(pkg.version);
  });
});
