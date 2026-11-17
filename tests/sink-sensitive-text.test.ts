import { describe, expect, it } from 'vitest'
import {
  SENSITIVE_TEXT_KEY_WIRE_FORMS,
  isSensitiveTextKeyName,
  maskSensitiveTextFields,
} from '../src/utils/sink-sensitive-text.js'
import { safeText } from '../src/utils/sink.js'
import { guardToolCall } from '../src/utils/tool-guard.js'

/** Must not appear as a substring of any sensitive wire key name (e.g. avoid "xy" in "proxy"). */
const SHORT = 'q7q'

describe('B1 sensitive text key matcher', () => {
  it.each(['tokenAddress', 'tokenId', 'tokenAmount', 'tokenSymbol'])(
    'does not treat %s as a sensitive key name',
    (name) => {
      expect(isSensitiveTextKeyName(name)).toBe(false)
    }
  )

  it.each(['tokenAddress', 'tokenId'])('leaves %s values in JSON text', (name) => {
    const json = `{"${name}":"${SHORT}","sibling_ok":"visible"}`
    const out = safeText(json)
    expect(out).toContain(SHORT)
    expect(out).toContain('sibling_ok')
    expect(out).toContain('visible')
  })

  it.each([
    ['db_password', 'db_password'],
    ['credentials', 'credentials'],
    ['bearer', 'bearer'],
  ] as const)('masks short JSON value for %s', (_label, wireKey) => {
    const json = `{"${wireKey}":"${SHORT}","sibling_ok":"visible"}`
    const out = safeText(json)
    expect(out).not.toContain(SHORT)
    expect(out).toContain('[redacted]')
    expect(out).toContain('sibling_ok')
  })

  it.each([
    ['SMTP_PASSWORD', 'SMTP_PASSWORD'],
    ['webhookSecret', 'webhookSecret'],
  ] as const)('masks suffix-sensitive key %s in JSON', (_label, wireKey) => {
    const json = `{"${wireKey}":"${SHORT}","sibling_ok":"visible"}`
    const out = safeText(json)
    expect(out).not.toContain(SHORT)
    expect(out).toContain('[redacted]')
    expect(out).toContain('sibling_ok')
  })

  it.each(SENSITIVE_TEXT_KEY_WIRE_FORMS)(
    'masks 1–3 char JSON value for wire key %s with sibling intact',
    (wireKey) => {
      const json = `{"${wireKey}":"${SHORT}","sibling_ok":"visible"}`
      const out = safeText(json)
      expect(out).not.toContain(SHORT)
      expect(out).toContain('[redacted]')
      expect(out).toContain('sibling_ok')
      expect(out).toContain('visible')
    }
  )

  it.each(SENSITIVE_TEXT_KEY_WIRE_FORMS)(
    'masks 1–3 char key=value for wire key %s with sibling intact',
    (wireKey) => {
      const line =
        wireKey === 'cookie' || wireKey === 'set-cookie'
          ? `${wireKey}: ${SHORT}\nsibling_ok=visible`
          : `${wireKey}: ${SHORT}; sibling_ok=visible`
      const out = safeText(line)
      expect(out).not.toContain(SHORT)
      expect(out).toContain('[redacted]')
      expect(out).toContain('sibling_ok=visible')
    }
  )

  const SPELLING_SECRET = 'FAKEsetCookieSpellSECRET'

  it.each([
    ['JSON setCookie', JSON.stringify({ setCookie: `sid=${SPELLING_SECRET}` })],
    ['JSON set_cookie', JSON.stringify({ set_cookie: SPELLING_SECRET })],
    ['KV set_cookie=', `set_cookie=${SPELLING_SECRET}`],
    ['colon SET_COOKIE', `SET_COOKIE: ${SPELLING_SECRET}`],
  ] as const)('safeText masks non-header set-cookie spelling %s', (_label, text) => {
    const out = safeText(text)
    expect(out).not.toContain(SPELLING_SECRET)
    expect(out).toContain('[redacted]')
  })

  it.each([
    ['JSON setCookie', JSON.stringify({ setCookie: `sid=${SPELLING_SECRET}` })],
    ['JSON set_cookie', JSON.stringify({ set_cookie: SPELLING_SECRET })],
    ['KV set_cookie=', `set_cookie=${SPELLING_SECRET}`],
    ['colon SET_COOKIE', `SET_COOKIE: ${SPELLING_SECRET}`],
  ] as const)('guardToolCall masks non-header set-cookie spelling %s', async (_label, text) => {
    const r = await guardToolCall('spell', () => ({ content: [{ type: 'text', text }] }))
    expect(JSON.stringify(r)).not.toContain(SPELLING_SECRET)
    expect(r.content[0]!.text).toContain('[redacted]')
  })

  it.each([
    ['Cookie header EOL', `Cookie: theme=dark; session=${SPELLING_SECRET}`],
    ['COOKIE header EOL', `COOKIE: theme=dark; session=${SPELLING_SECRET}`],
    ['JSON cookie', JSON.stringify({ cookie: `a=1; sid=${SPELLING_SECRET}` })],
  ] as const)('safeText masks cookie spelling %s', (_label, text) => {
    const out = safeText(text)
    expect(out).not.toContain(SPELLING_SECRET)
    expect(out).toContain('[redacted]')
  })

  it.each([
    ['Cookie header EOL', `Cookie: theme=dark; session=${SPELLING_SECRET}`],
    ['COOKIE header EOL', `COOKIE: theme=dark; session=${SPELLING_SECRET}`],
    ['JSON cookie', JSON.stringify({ cookie: `a=1; sid=${SPELLING_SECRET}` })],
  ] as const)('guardToolCall masks cookie spelling %s', async (_label, text) => {
    const r = await guardToolCall('cookie_spell', () => ({ content: [{ type: 'text', text }] }))
    expect(JSON.stringify(r)).not.toContain(SPELLING_SECRET)
    expect(r.content[0]!.text).toContain('[redacted]')
  })

  it('masks JSON values built with an embedded quote in the secret field', () => {
    const json = JSON.stringify({ client_secret: `a"b${SHORT}`, sibling_ok: 'visible' })
    const out = maskSensitiveTextFields(json)
    expect(out).not.toContain(SHORT)
    expect(out).toContain('[redacted]')
    expect(out).toContain('sibling_ok')
  })
})