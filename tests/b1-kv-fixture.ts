/** Wire forms whose header values mask to EOL (sibling on the next line). */
export const B1_KV_EOL_HEADER_WIRE = new Set([
  'cookie',
  'set-cookie',
  'x-api-key',
  'authorization',
  'proxy-authorization',
  'x-auth-token',
  'x-payment',
  'seed',
  'mnemonic',
])

export function b1KvFixtureLine(wireKey: string, secret: string): string {
  return B1_KV_EOL_HEADER_WIRE.has(wireKey)
    ? `${wireKey}: ${secret}\nsibling_ok=visible`
    : `${wireKey}: ${secret}; sibling_ok=visible`
}