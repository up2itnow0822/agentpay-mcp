/**
 * Tests for session-credential fetch: header override immunity and
 * origin-bound redirect following.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  CrossOriginSessionRedirectError,
  fetchWithSessionCredentials,
  headersToRecord,
  isSessionCredentialHeader,
  mergeSessionHeaders,
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
      SESSION_HEADERS
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
      SESSION_HEADERS
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
        SESSION_HEADERS
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
      SESSION_HEADERS
    );

    expect(fetchSpy.mock.calls[1]![1]?.method).toBe('GET');
    expect(fetchSpy.mock.calls[1]![1]?.body).toBeUndefined();
  });
});
