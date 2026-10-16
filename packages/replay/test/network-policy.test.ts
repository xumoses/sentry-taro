import { describe, expect, test, vi } from 'vite-plus/test';
import { createNetworkHeaderPolicy, snapshotNetworkOptions } from '../../sdk/src/network-details';
import { sanitizeBreadcrumb, sanitizeRecord } from '../src/privacy';

const policy = (extra: Parameters<typeof createNetworkHeaderPolicy>[0] = {}) =>
  createNetworkHeaderPolicy({
    networkDetailAllowUrls: [/^https:\/\/example\.com\/api(?:\/|$)/g],
    ...extra,
  });

describe('bounded Replay network header privacy policy', () => {
  test('URL matching strips credentials/query/hash, prefers deny and preserves caller RegExp state', () => {
    const regex = /^https:\/\/example\.com\/api(?:\/|$)/g;
    regex.lastIndex = 17;
    const p = policy({
      networkDetailAllowUrls: [regex],
      networkDetailDenyUrls: [/\/private(?:\/|$)/g],
    });
    for (let index = 0; index < 3; index++) {
      expect(p.isAllowed('https://name:private@example.com/api/items?private=1#fragment')).toBe(
        true,
      );
      expect(p.isAllowed('https://example.com/api/private/items?ok=1')).toBe(false);
      expect(p.isAllowed('https://example.com.evil.com/api/items')).toBe(false);
    }
    expect(regex.lastIndex).toBe(17);
    expect(
      policy({ networkDetailAllowUrls: ['?private=1'] }).isAllowed(
        'https://example.com/api/items?private=1',
      ),
    ).toBe(false);
    expect(policy({ networkDetailAllowUrls: ['example.com'] }).isAllowed('data:example.com')).toBe(
      false,
    );
  });

  test('only named Replay network fields can opt in; generic and nested content stays filtered', () => {
    const breadcrumb = {
      category: 'fetch',
      data: {
        url: 'https://example.com/api/items',
        request_headers: { Accept: 'application/json' },
        response_headers: { 'Content-Type': 'application/json' },
        headers: { Accept: 'never-generic' },
        request: { headers: { Accept: 'never-nested' }, body: 'private-body' },
      },
    };
    const p = policy();
    const sanitized = sanitizeBreadcrumb(breadcrumb, { maskMessage: true, networkPolicy: p });
    expect(sanitized.data).toMatchObject({
      request_headers: { accept: 'application/json' },
      response_headers: { 'content-type': 'application/json' },
      headers: '[Filtered]',
      request: { headers: '[Filtered]', body: '[Filtered]' },
    });
    expect(sanitizeRecord(breadcrumb.data).request_headers).toBe('[Filtered]');
    expect(sanitizeBreadcrumb(breadcrumb, { maskMessage: true }).data?.request_headers).toBe(
      '[Filtered]',
    );
    expect(
      sanitizeBreadcrumb(
        { ...breadcrumb, category: 'custom' },
        { maskMessage: true, networkPolicy: p },
      ).data?.request_headers,
    ).toBe('[Filtered]');
  });

  test('explicit names cannot permit sensitive headers or wildcard names', () => {
    const names = [
      'Authorization',
      'Cookie',
      'Set-Cookie',
      'X-Token',
      'X-API-Key',
      'X-Secret',
      'X-Password',
      'X-CSRF',
      'Proxy-Authorization',
      'Sentry-Trace',
      'Baggage',
      'X-Forwarded-For',
      'X-Session-Id',
      '__proto__',
      'constructor',
      '*',
    ];
    const p = policy({ networkRequestHeaders: names });
    expect(
      p.filterHeaders(
        Object.fromEntries(names.filter((name) => name !== '*').map((name) => [name, 'private'])),
        'request',
      ),
    ).toEqual({});
    expect(
      p.filterHeaders(
        {
          'content-TYPE': 'application/json',
          ACCEPT: 'application/json',
          'Content-Length': 12,
          'X-Unlisted': 'private',
        },
        'request',
      ),
    ).toEqual({
      'content-type': 'application/json',
      accept: 'application/json',
      'content-length': '12',
    });
  });

  test('header names, values and total bytes are bounded without truncation or evaluating getters', () => {
    const getter = vi.fn(() => 'private');
    const names = [
      'x-short',
      'x-unicode',
      'x-crlf',
      'x-object',
      'x-getter',
      `x-${'a'.repeat(128)}`,
      ...Array.from({ length: 10 }, (_, index) => `x-wide-${index}`),
    ];
    const p = policy({ networkRequestHeaders: names });
    const raw = Object.fromEntries(names.map((name) => [name, 'a'.repeat(1000)]));
    raw['x-short'] = 'okay';
    raw['x-unicode'] = '界'.repeat(342);
    raw['x-crlf'] = 'one\r\nother: secret';
    Object.defineProperty(raw, 'x-getter', { get: getter, enumerable: true });
    Object.defineProperty(raw, 'x-object', { value: { toString: getter }, enumerable: true });
    const result = p.filterHeaders(raw, 'request');
    expect(result['x-short']).toBe('okay');
    for (const name of ['x-unicode', 'x-crlf', 'x-getter', 'x-object', names[5]!])
      expect(result[name]).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
    expect(
      Object.entries(result).reduce(
        (bytes, [name, value]) => bytes + Buffer.byteLength(name + value),
        0,
      ),
    ).toBeLessThanOrEqual(4096);
    expect(Object.values(result).every((value) => value === 'okay' || value.length === 1000)).toBe(
      true,
    );
    expect(
      p.filterHeaders(
        new Proxy(
          {},
          {
            ownKeys() {
              throw new Error('synthetic proxy');
            },
          },
        ),
        'request',
      ),
    ).toEqual({});
  });

  test('configuration snapshots include all keys and freeze cloned arrays and regexes', () => {
    const original = /^https:\/\/example\.com/g;
    const input = { networkDetailAllowUrls: [original] };
    const snapshot = snapshotNetworkOptions(input);
    expect(Object.keys(snapshot)).toHaveLength(4);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.networkDetailAllowUrls)).toBe(true);
    expect(Object.isFrozen(snapshot.networkDetailAllowUrls[0])).toBe(true);
    expect(snapshot.networkDetailAllowUrls[0]).not.toBe(original);
    input.networkDetailAllowUrls.length = 0;
    expect(snapshot.networkDetailAllowUrls).toHaveLength(1);
  });
});
