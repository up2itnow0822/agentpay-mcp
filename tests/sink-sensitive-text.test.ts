import { describe, expect, it } from 'vitest'
import {
  SENSITIVE_TEXT_KEY_WIRE_FORMS,
  isSensitiveTextKeyName,
  maskSensitiveTextFields,
} from '../src/utils/sink-sensitive-text.js'
import { safeText } from '../src/utils/sink.js'

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
      const line = `${wireKey}: ${SHORT}; sibling_ok=visible`
      const out = safeText(line)
      expect(out).not.toContain(SHORT)
      expect(out).toContain('[redacted]')
      expect(out).toContain('sibling_ok=visible')
    }
  )

  it('masks JSON values built with an embedded quote in the secret field', () => {
    const json = JSON.stringify({ client_secret: `a"b${SHORT}`, sibling_ok: 'visible' })
    const out = maskSensitiveTextFields(json)
    expect(out).not.toContain(SHORT)
    expect(out).toContain('[redacted]')
    expect(out).toContain('sibling_ok')
  })
})