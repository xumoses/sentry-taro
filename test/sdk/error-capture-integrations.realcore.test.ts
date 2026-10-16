import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';
import * as Sentry from '../../src/sdk/index';
import { installedIntegrations } from '@sentry/core';
import type { Envelope } from '@sentry/core';
import { resetPlatformCache } from '../../src/sdk/crossPlatform';
import { _resetAppLifecycle } from '../../src/sdk/appLifecycle';

const g = globalThis as any;
let envelopes: Envelope[];
let response: Record<string, unknown>;

const events = (): any[] => {
  const result: unknown[] = [];
  for (const envelope of envelopes)
    for (const item of envelope[1]) if (item[0].type === 'event') result.push(item[1]);
  return result;
};

function initialize(options: Sentry.MiniappOptions = {}) {
  return Sentry.init({
    dsn: 'https://public@ingest.example.test/1',
    defaultIntegrations: false,
    enableAutoSessionTracking: false,
    enableNavigationBreadcrumbs: false,
    enableUserInteractionBreadcrumbs: false,
    enableNetworkStatusMonitoring: false,
    enableSourceMap: false,
    enableOfflineCache: false,
    transport: () => ({
      send: async (env) => {
        envelopes.push(env);
        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
    ...options,
  })!;
}

function request(options: Record<string, unknown>): void {
  g.wx.request({ method: 'POST', ...options });
}

beforeEach(() => {
  envelopes = [];
  response = { statusCode: 503, data: 'unavailable', header: { 'Content-Length': '11' } };
  installedIntegrations.length = 0;
  Sentry.getCurrentScope().clear();
  Sentry.getIsolationScope().clear();
  Sentry.getCurrentScope().setClient(undefined);
  _resetAppLifecycle();
  g.wx.request = vi.fn((options: any) => {
    options.success?.(response);
    options.complete?.(response);
  });
  resetPlatformCache();
});

afterEach(async () => {
  await Sentry.getClient()?.close(0);
  Sentry.getCurrentScope().setClient(undefined);
  _resetAppLifecycle();
});

describe('httpClientIntegration', () => {
  test('captures 5xx responses with the official event shape and a sanitized URL', async () => {
    const client = initialize({
      integrations: [new Sentry.Integrations.NetworkBreadcrumbs(), Sentry.httpClientIntegration()],
    });
    const success = vi.fn();
    request({
      url: 'https://user:pass@api.example.test/orders/1?token=secret#frag',
      header: { Authorization: 'Bearer secret', 'X-App': 'demo' },
      success,
    });
    await client.flush(2000);

    expect(success).toHaveBeenCalledWith(response);
    const [event] = events();
    expect(events()).toHaveLength(1);
    expect(event.message).toBe('HTTP Client Error with status code: 503');
    expect(event.exception.values[0]).toMatchObject({
      type: 'Error',
      value: 'HTTP Client Error with status code: 503',
      mechanism: { type: 'auto.http.client.request', handled: false },
    });
    expect(event.request).toEqual({ url: 'https://api.example.test/orders/1', method: 'POST' });
    expect(event.contexts.response).toEqual({ status_code: 503 });
    expect(JSON.stringify(event)).not.toMatch(/secret|pass|frag/);
  });

  test('ignores successful, non-matching and network-failed requests', async () => {
    const client = initialize({
      integrations: [
        new Sentry.Integrations.NetworkBreadcrumbs(),
        Sentry.httpClientIntegration({
          failedRequestStatusCodes: [[500, 502], 504],
          failedRequestTargets: ['api.example.test', /\/reports\//],
        }),
      ],
    });
    response = { statusCode: 200 };
    request({ url: 'https://api.example.test/ok' });
    response = { statusCode: 503 };
    request({ url: 'https://api.example.test/excluded-status' });
    response = { statusCode: 500 };
    request({ url: 'https://cdn.other.test/untracked' });
    g.wx.request = vi.fn((options: any) => options.fail?.({ errMsg: 'request:fail timeout' }));
    resetPlatformCache();
    request({ url: 'https://api.example.test/timeout' });
    await client.flush(2000);
    expect(events()).toHaveLength(0);
  });

  test('matches status ranges, single codes and regex targets against the full URL', async () => {
    const client = initialize({
      integrations: [
        new Sentry.Integrations.NetworkBreadcrumbs(),
        Sentry.httpClientIntegration({
          failedRequestStatusCodes: [404, [500, 599]],
          failedRequestTargets: [/[?&]debug=1/],
        }),
      ],
    });
    response = { statusCode: 404 };
    request({ url: 'https://api.example.test/missing?debug=1' });
    response = { statusCode: 404 };
    request({ url: 'https://api.example.test/missing' });
    await client.flush(2000);
    expect(events().map((event) => event.request.url)).toEqual([
      'https://api.example.test/missing',
    ]);
  });

  test('sendDefaultPii adds filtered headers and cookies like the official integration', async () => {
    const client = initialize({
      sendDefaultPii: true,
      integrations: [new Sentry.Integrations.NetworkBreadcrumbs(), Sentry.httpClientIntegration()],
    });
    response = {
      statusCode: 500,
      header: { 'Content-Type': 'text/plain', 'Content-Length': '42', 'X-Request-Id': 'r1' },
      cookies: ['theme=dark; Path=/', 'session=abc'],
    };
    request({
      url: 'https://api.example.test/pay',
      header: { Authorization: 'Bearer secret', 'X-App': 'demo', Cookie: 'lang=zh; token=t' },
    });
    await client.flush(2000);

    const [event] = events();
    expect(event.request.headers).toEqual({
      Authorization: '[Filtered]',
      'X-App': 'demo',
      Cookie: '[Filtered]',
    });
    expect(event.request.headers).not.toHaveProperty('sentry-trace');
    expect(event.request.cookies).toEqual({ lang: 'zh', token: '[Filtered]' });
    expect(event.contexts.response).toMatchObject({
      status_code: 500,
      headers: { 'Content-Type': 'text/plain', 'Content-Length': '42', 'X-Request-Id': 'r1' },
      cookies: { theme: 'dark', session: '[Filtered]' },
      body_size: 42,
    });
  });

  test('skips Sentry requests and stops after the client closes', async () => {
    const client = initialize({
      integrations: [new Sentry.Integrations.NetworkBreadcrumbs(), Sentry.httpClientIntegration()],
    });
    request({ url: 'https://ingest.example.test/api/1/envelope/?sentry_key=public' });
    await client.flush(2000);
    expect(events()).toHaveLength(0);

    await client.close(0);
    request({ url: 'https://api.example.test/after-close' });
    expect(events()).toHaveLength(0);
  });
});

describe('captureConsoleIntegration', () => {
  test('re-exports the official core integration', async () => {
    const core = await import('@sentry/core');
    expect(Sentry.captureConsoleIntegration).toBe(core.captureConsoleIntegration);
  });

  test('captures console.error messages and errors with the official mechanism', async () => {
    const nativeError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = initialize({
      integrations: [Sentry.captureConsoleIntegration({ levels: ['error'] })],
    });
    console.error('order failed', { id: 7 });
    console.error(new Error('boom'));
    console.warn('not captured');
    await client.flush(2000);

    const [message, exception] = events();
    expect(events()).toHaveLength(2);
    expect(message).toMatchObject({
      level: 'error',
      logger: 'console',
      message: 'order failed [object Object]', // official safeJoin
      extra: { arguments: ['order failed', { id: 7 }] },
    });
    expect(exception.exception.values[0]).toMatchObject({
      type: 'Error',
      value: 'boom',
      mechanism: { type: 'auto.core.capture_console', handled: true },
    });
    expect(nativeError).toHaveBeenCalledTimes(2);
  });
});
