/**
 * Safe outbound transport (F8, F9, F15).
 *
 * These tests drive the REAL node:http connector against local servers — the
 * global test setup's connector override is cleared here — so DNS pinning,
 * byte caps, decompression limits, and redirect handling are proven on real
 * sockets, not on a fetch mock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import zlib from 'node:zlib'
import type { AddressInfo } from 'node:net'
import {
  ALLOWED_PRIVATE_HOSTS_ENV,
  ResponseTooLargeError,
  UnsafeDestinationError,
  _clearSafeTransportTestOverrides,
  assertSafeUrl,
  createSafeTransport,
  readLimitedText,
} from '../src/utils/safe-fetch.js'
import { installDefaultTransportOverrides } from './setup/test-env.js'
import { isPrivateAddress, resolvePublicAddresses } from '../src/utils/net-guard.js'

let server: http.Server
let port: number

beforeEach(async () => {
  _clearSafeTransportTestOverrides()
  server = http.createServer((req, res) => {
    switch (req.url) {
      case '/big-declared':
        res.writeHead(200, { 'content-length': String(5_000_000) })
        res.end(Buffer.alloc(5_000_000))
        return
      case '/big-streamed': {
        res.writeHead(200)
        const chunk = Buffer.alloc(512 * 1024, 0x61)
        let sent = 0
        const pump = (): void => {
          while (sent < 12) {
            sent++
            if (!res.write(chunk)) {
              res.once('drain', pump)
              return
            }
          }
          res.end()
        }
        pump()
        return
      }
      case '/gzip-bomb':
        res.writeHead(200, { 'content-encoding': 'gzip' })
        res.end(zlib.gzipSync(Buffer.alloc(50_000_000)))
        return
      case '/gzip-small':
        res.writeHead(200, { 'content-encoding': 'gzip' })
        res.end(zlib.gzipSync(Buffer.from('compressed-ok')))
        return
      case '/redirect-private':
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' })
        res.end()
        return
      case '/echo': {
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ host: req.headers.host, method: req.method, body, ae: req.headers['accept-encoding'] }))
        })
        return
      }
      default:
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end(`hello ${req.headers.host}`)
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  installDefaultTransportOverrides()
  delete process.env[ALLOWED_PRIVATE_HOSTS_ENV]
})

/** Every name resolves to the local test server; private space allowed. */
function loopback(resolver = vi.fn(async () => [{ address: '127.0.0.1', family: 4 }])) {
  return { transport: createSafeTransport({ allowPrivateNetwork: true, resolver }), resolver }
}

describe('destination validation', () => {
  it('requires https by default and refuses userinfo and private names', () => {
    expect(() => assertSafeUrl('http://example.com/')).toThrow(/https is required/)
    expect(() => assertSafeUrl('https://user:pw@example.com/')).toThrow(/credentials/)
    expect(() => assertSafeUrl('ftp://example.com/')).toThrow(/scheme/)
    expect(() => assertSafeUrl('https://metadata.google.internal/')).toThrow(/private network name/)
    expect(() => assertSafeUrl('https://printer.local/')).toThrow(/private network name/)
    expect(() => assertSafeUrl('https://a..example.com/')).toThrow(/not externally routable/)
    expect(assertSafeUrl('https://api.example.com/x').hostname).toBe('api.example.com')
  })

  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '192.168.0.10',
    '100.64.0.1',
    '::1',
    'fe80::1',
    'fd00::1',
    '::ffff:169.254.169.254',
    '::ffff:0:a9fe:a9fe',
    '::ffff:0:127.0.0.1',
    '64:ff9b::a9fe:a9fe',
    '2002:a9fe:a9fe::1',
  ])('classifies %s as private', (address) => {
    expect(isPrivateAddress(address)).toBe(true)
  })

  it('rejects literal private destinations before any connection', async () => {
    const connector = vi.fn()
    const transport = createSafeTransport({ connector })
    for (const url of [
      'https://127.0.0.1/',
      'https://169.254.169.254/latest/meta-data/',
      'https://[::ffff:a9fe:a9fe]/',
      'https://[fd00::1]/',
      'https://2130706433/', // decimal 127.0.0.1 — WHATWG normalises it
    ]) {
      await expect(transport(url)).rejects.toBeInstanceOf(UnsafeDestinationError)
    }
    expect(connector).not.toHaveBeenCalled()
  })

  it('rejects a host if ANY resolver answer is private (rebinding set-up)', async () => {
    const connector = vi.fn()
    const transport = createSafeTransport({
      connector,
      resolver: async () => [
        { address: '93.184.215.14', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ],
    })
    await expect(transport('https://mixed.example/')).rejects.toThrow(/private/)
    expect(connector).not.toHaveBeenCalled()
  })

  it('fails closed on resolution failure and on an empty answer', async () => {
    await expect(
      resolvePublicAddresses('nx.example', { resolver: async () => { throw new Error('ENOTFOUND') } })
    ).rejects.toThrow(/could not be resolved/)
    await expect(resolvePublicAddresses('empty.example', { resolver: async () => [] })).rejects.toThrow(
      /no addresses/
    )
  })

  it('lets an operator allowlist one private host without opening private space', async () => {
    process.env[ALLOWED_PRIVATE_HOSTS_ENV] = 'webhook.svc.internal'
    const connector = vi.fn(async () => new Response('ok'))
    const transport = createSafeTransport({
      connector,
      requireHttps: false,
      resolver: async () => [{ address: '10.0.0.7', family: 4 }],
    })
    await expect(transport('http://webhook.svc.internal/hook')).resolves.toBeInstanceOf(Response)
    await expect(transport('http://other.svc.internal/hook')).rejects.toThrow(/private network name/)
  })
})

describe('real pinned connector', () => {
  it('connects to the validated address even though the name is unresolvable by system DNS', async () => {
    const { transport } = loopback()
    const response = await transport(`http://pinned.agentpay.invalid:${port}/`)
    expect(await response.text()).toBe(`hello pinned.agentpay.invalid:${port}`)
  })

  it('resolves once per transport: a second answer can never redirect the connection (F9/F15)', async () => {
    const resolver = vi
      .fn()
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }])
      // A rebinding resolver would answer differently the second time.
      .mockResolvedValue([{ address: '203.0.113.9', family: 4 }])
    const { transport } = loopback(resolver)
    await transport(`http://rebind.agentpay.invalid:${port}/`)
    const second = await transport(`http://rebind.agentpay.invalid:${port}/`)
    expect(await second.text()).toContain('hello')
    expect(resolver).toHaveBeenCalledTimes(1)
  })

  it('refuses a declared Content-Length over the cap before reading (F8)', async () => {
    const { transport } = loopback()
    await expect(transport(`http://t.invalid:${port}/big-declared`)).rejects.toBeInstanceOf(
      ResponseTooLargeError
    )
  })

  it('errors a streamed body once it exceeds the cap (F8)', async () => {
    const { transport } = loopback()
    const response = await transport(`http://t.invalid:${port}/big-streamed`)
    await expect(response.text()).rejects.toThrow()
  })

  it('caps DECODED bytes, so a gzip bomb hits the same ceiling (F8)', async () => {
    const { transport } = loopback()
    const bomb = await transport(`http://t.invalid:${port}/gzip-bomb`)
    await expect(bomb.arrayBuffer()).rejects.toThrow()
    const small = await transport(`http://t.invalid:${port}/gzip-small`)
    expect(await small.text()).toBe('compressed-ok')
  })

  it('readLimitedText truncates at the soft cap and cancels the rest', async () => {
    const { transport } = loopback()
    const response = await transport(`http://t.invalid:${port}/big-streamed`)
    const limited = await readLimitedText(response, 1000)
    expect(limited.truncated).toBe(true)
    expect(limited.bytes).toBe(1000)
    expect(limited.text).toBe('a'.repeat(1000))
  })

  it('never follows a redirect (a validated URL cannot bounce into private space)', async () => {
    const { transport } = loopback()
    const response = await transport(`http://t.invalid:${port}/redirect-private`)
    expect(response.status).toBe(302)
    await expect(
      transport(`http://t.invalid:${port}/redirect-private`, { redirect: 'error' })
    ).rejects.toThrow(/redirect/)
  })

  it('sends method/body and forces identity encoding', async () => {
    const { transport } = loopback()
    const response = await transport(`http://t.invalid:${port}/echo`, {
      method: 'POST',
      body: '{"a":1}',
      headers: { 'Accept-Encoding': 'gzip, br' },
    })
    const echoed = JSON.parse(await response.text())
    expect(echoed).toMatchObject({ method: 'POST', body: '{"a":1}', ae: 'identity' })
    expect(response.url).toBe(`http://t.invalid:${port}/echo`)
  })

  it('honours an abort signal', async () => {
    const { transport } = loopback()
    const controller = new AbortController()
    controller.abort()
    await expect(
      transport(`http://t.invalid:${port}/`, { signal: controller.signal })
    ).rejects.toThrow()
  })
})
