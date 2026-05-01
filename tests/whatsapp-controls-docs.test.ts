import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const whatsappDocs = readFileSync('docs/whatsapp-smb-agent-controls.md', 'utf8');

describe('WhatsApp SMB control docs', () => {
  it('binds spend controls at vertical persona creation time', () => {
    expect(whatsappDocs).toContain('Persona creation approval gate');
    expect(whatsappDocs).toContain('persona_id');
    expect(whatsappDocs).toContain('policy_version');
    expect(whatsappDocs).toContain('Persona creation cannot enable paid tools without an attached AgentPay MCP policy');
  });
});
