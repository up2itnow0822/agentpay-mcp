/**
 * Tests for session-credential fetch: header override immunity and
 * scope-bound redirect following.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  CrossOriginSessionRedirectError,
  fetchWithSessionCredentials,
  headersToRecord,
  isSessionCredentialHeader,
  mergeSessionHeaders,
  SessionScopeRedirectError,
} from '../src/utils/session-fetch.js';
import {
  PAYMENT_SESSION_HEADER,
  SESSION_TOKEN_HEADER,
  SESSION_WALLET_HEADER,
} from '../src/session/manager.js';

const SESSION_HEADERS = {
  [SESSION_TOKEN_HEADER]: 'payload.signature',
  [SESSION_WALLET_HEADER]: '0xabc',
  [PAYMENT_SESSION_HEADER]: 'session-id',
};

/** Prefix session covering https://api.example.com/v1 and its descendants. */
const PAID_SESSION = {
  endpoint: 'https://api.example.com/v1',
  scope: 'prefix' as const,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('mergeSessionHeaders', () => {
  it('lets caller headers through while session credentials win', () => {
    const merged = mergeSessionHeaders(
      { Accept: 'application/json', 'X-Custom': 'yes' },
      SESSION_HEADERS
    );
    expect(merged.Accept).toBe('application/json');
    expect(merged['X-Custom']).toBe('yes');
    expect(merged[SESSION_TOKEN_HEADER]).toBe('payload.signature');
    expect(merged[SESSION_WALLET_HEADER]).toBe('0xabc');
    expect(merged[PAYMENT_SESSION_HEADER]).toBe('session-id');
  });

  it('drops caller-supplied session credentials regardless of casing', () => {
    const merged = mergeSessionHeaders(
      {
        'x-session-token': 'attacker-token',
        'X-SESSION-WALLET': '0xattacker',
        'payment-session': 'forged-id',
        Authorization: 'Bearer leftover',
      },
      SESSION_HEADERS
    );

    expect(merged[SESSION_TOKEN_HEADER]).toBe('payload.signature');
    expect(merged[SESSION_WALLET_HEADER]).toBe('0xabc');
    expect(merged[PAYMENT_SESSION_HEADER]).toBe('session-id');
    expect(merged['x-session-token']).toBeUndefined();
    expect(merged['X-SESSION-WALLET']).toBeUndefined();
    expect(merged['payment-session']).toBeUndefined();
    expect(merged.Authorization).toBe('Bearer leftover');
  });

  it('recognises credential header names case-insensitively', () => {
    expect(isSessionCredentialHeader('x-session-token')).toBe(true);
    expect(isSessionCredentialHeader('PAYMENT-SESSION')).toBe(true);
    expect(isSessionCredentialHeader('Accept')).toBe(false);
  });
});

describe('headersToRecord', () => {
  it('copies Headers, arrays, and plain objects', () => {
    expect(headersToRecord({ A: '1' })).toEqual({ A: '1' });
    expect(headersToRecord([['B', '2']])).toEqual({ B: '2' });

    const headers = new Headers({ C: '3' });
    expect(headersToRecord(headers).c).toBe('3');
    expect(headersToRecord(undefined)).toEqual({});
  });
});

describe('fetchWithSessionCredentials', () => {
  it('calls fetch with redirect:manual and session headers last', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('ok', { status: 200 })
    );

    await fetchWithSessionCredentials(
      'https://api.example.com/v1/data',
      {
        method: 'GET',
        headers: {
          Accept: '*/*',
          'X-Session-Token': 'caller-override',
        },
      },
      SESSION_HEADERS,
      PAID_SESSION
    );

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(init?.redirect).toBe('manual');
    const headers = init?.headers as Record<string, string>;
    expect(headers[SESSION_TOKEN_HEADER]).toBe('payload.signature');
    expect(headers['X-Session-Token']).toBe('payload.signature');
    expect(headers['X-Session-Token']).not.toBe('caller-override');
    expect(headers.Accept).toBe('*/*');
  });

  it('follows a same-origin redirect without leaking to a second origin', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url) === 'https://api.example.com/v1') {
        return new Response(null, {
          status: 302,
          headers: { Location: '/v1/data' },
        });
      }
      return new Response('final', { status: 200 });
    });

    const response = await fetchWithSessionCredentials(
      'https://api.example.com/v1',
      { method: 'GET', headers: {} },
      SESSION_HEADERS,
      PAID_SESSION
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('final');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[1]![0])).toBe('https://api.example.com/v1/data');
    expect(fetchSpy.mock.calls[1]![1]?.redirect).toBe('manual');
    const hop2Headers = fetchSpy.mock.calls[1]![1]?.headers as Record<string, string>;
    expect(hop2Headers[SESSION_TOKEN_HEADER]).toBe('payload.signature');
  });

  it('refuses a cross-origin redirect and never fetches the target', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: 'https://attacker.example/steal' },
      })
    );

    await expect(
      fetchWithSessionCredentials(
        'https://api.example.com/v1/data',
        { method: 'GET', headers: {} },
        SESSION_HEADERS,
        PAID_SESSION
      )
    ).rejects.toBeInstanceOf(CrossOriginSessionRedirectError);

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(String(fetchSpy.mock.calls[0]![0])).toBe('https://api.example.com/v1/data');
  });

  it('drops POST body when following a 303 on the same origin', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url) === 'https://api.example.com/v1/submit') {
        return new Response(null, {
          status: 303,
          headers: { Location: '/v1/result' },
        });
      }
      return new Response('ok', { status: 200 });
    });

    await fetchWithSessionCredentials(
      'https://api.example.com/v1/submit',
      { method: 'POST', headers: {}, body: '{"paid":true}' },
      SESSION_HEADERS,
      PAID_SESSION
    );

    expect(fetchSpy.mock.calls[1]![1]?.method).toBe('GET');
    expect(fetchSpy.mock.calls[1]![1]?.body).toBeUndefined();
  });

  it('refuses a same-origin redirect outside the paid prefix and does not fetch it', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: '/v10/admin' },
      })
    );

    await expect(
      fetchWithSessionCredentials(
        'https://api.example.com/v1/item',
        { method: 'GET', headers: {} },
        SESSION_HEADERS,
        PAID_SESSION
      )
    ).rejects.toBeInstanceOf(SessionScopeRedirectError);

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(String(fetchSpy.mock.calls[0]![0])).toBe('https://api.example.com/v1/item');
  });
});

describe('fetchWithSessionCredentials against a local server', () => {
  async function listen(
    handler: (_req: http.IncomingMessage, _res: http.ServerResponse) => void
  ): Promise<{ origin: string; close: () => Promise<void> }> {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address() as AddressInfo;
    return {
      origin: `http://127.0.0.1:${address.port}`,
      close: () =>
        new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    };
  }

  it('sends the token on an in-scope redirect and withholds it from /v10', async () => {
    const hits: Array<{ url: string | undefined; token: string | string[] | undefined }> = [];
    const server = await listen((req, res) => {
      hits.push({ url: req.url, token: req.headers['x-session-token'] });
      if (req.url === '/v1/item') {
        res.writeHead(302, { Location: '/v1/item/canonical' });
        res.end();
        return;
      }
      if (req.url === '/v1/escape') {
        res.writeHead(302, { Location: '/v10/admin' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('canonical-body');
    });

    try {
      const covered = await fetchWithSessionCredentials(
        `${server.origin}/v1/item`,
        { method: 'GET' },
        SESSION_HEADERS,
        { endpoint: `${server.origin}/v1`, scope: 'prefix' }
      );
      expect(covered.status).toBe(200);
      expect(await covered.text()).toBe('canonical-body');

      await expect(
        fetchWithSessionCredentials(
          `${server.origin}/v1/escape`,
          { method: 'GET' },
          SESSION_HEADERS,
          { endpoint: `${server.origin}/v1`, scope: 'prefix' }
        )
      ).rejects.toBeInstanceOf(SessionScopeRedirectError);
    } finally {
      await server.close();
    }

    expect(hits.map((hit) => hit.url)).toEqual(['/v1/item', '/v1/item/canonical', '/v1/escape']);
    expect(hits.every((hit) => hit.token === 'payload.signature')).toBe(true);
    expect(hits.some((hit) => hit.url === '/v10/admin')).toBe(false);
  });
});
