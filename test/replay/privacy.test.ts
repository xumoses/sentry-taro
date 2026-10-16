import { describe, expect, test } from 'vite-plus/test';

import { sanitizeBreadcrumb, sanitizeRecord, sanitizeUrl } from '../../src/replay/privacy';

describe('Replay privacy helpers', () => {
  test('removes URL secrets while preserving useful paths', () => {
    expect(sanitizeUrl('https://alice:secret@example.test/path?q=token#hash')).toBe(
      'https://[filtered]:[filtered]@example.test/path',
    );
    expect(sanitizeUrl('data:image/png;base64,private')).toBe('data:image/png');
    expect(sanitizeUrl('/pages/order?id=123')).toBe('/pages/order');
  });

  test('filters nested sensitive keys and circular values', () => {
    const value: Record<string, unknown> = {
      url: 'https://example.test/api?token=secret',
      avatarUrl: 'https://example.test/avatar.png?signature=secret',
      urls: ['https://example.test/first?token=secret', 'https://example.test/second#private'],
      request: {
        authorization: 'Bearer secret',
        accessToken: 'secret',
        requestBody: 'private',
        method: 'GET',
      },
    };
    value.self = value;

    expect(sanitizeRecord(value)).toEqual({
      url: 'https://example.test/api',
      avatarUrl: 'https://example.test/avatar.png',
      urls: ['https://example.test/first', 'https://example.test/second'],
      request: {
        authorization: '[Filtered]',
        accessToken: '[Filtered]',
        requestBody: '[Filtered]',
        method: 'GET',
      },
      self: '[Filtered]',
    });
  });

  test('masks breadcrumb messages and request content by default', () => {
    expect(
      sanitizeBreadcrumb(
        {
          category: 'fetch',
          message: 'Customer Alice opened order 123',
          data: {
            url: 'https://example.test/orders/123?token=private',
            request_body: '{"card":"private"}',
            status_code: 200,
          },
        },
        { maskMessage: true },
      ),
    ).toEqual({
      category: 'fetch',
      message: '[Filtered]',
      data: {
        url: 'https://example.test/orders/123',
        request_body: '[Filtered]',
        status_code: 200,
      },
    });
  });
});
