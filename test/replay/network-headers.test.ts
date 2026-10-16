import { describe, expect, test, vi } from 'vite-plus/test';
import { createTaroReplay } from '../../src/replay/createTaroReplay';
import { ReplayCoordinator } from '../../src/replay/coordinator/ReplayCoordinator';
import { taroReplayIntegration } from '../../src/replay/coordinator/integration';
import { makeRuntime, makeSdk } from './fixtures';
import type { CreateTaroReplayOptions } from '../../src/replay/types';

const networkOptions = () => ({
  networkDetailAllowUrls: ['https://example.com/api/'],
  networkDetailDenyUrls: [/\/private(?:\/|$)/g],
  networkRequestHeaders: ['X-Request-Id'],
  networkResponseHeaders: ['X-Response-Id'],
});

function expectForwarded(actual: object) {
  expect(actual).toMatchObject({
    networkDetailAllowUrls: ['https://example.com/api/'],
    networkDetailDenyUrls: [/\/private(?:\/|$)/g],
    networkRequestHeaders: ['X-Request-Id'],
    networkResponseHeaders: ['X-Response-Id'],
  });
}

function mutate(options: ReturnType<typeof networkOptions>) {
  options.networkDetailAllowUrls.push('https://other.example.com/');
  options.networkDetailDenyUrls.length = 0;
  options.networkRequestHeaders.push('X-Private');
  options.networkResponseHeaders.length = 0;
}

describe('network header options across adapter entry points', () => {
  test('createTaroReplay snapshots configuration before deferred start', () => {
    const f = makeSdk();
    const options = networkOptions();
    const replay = createTaroReplay({ ...options, sdk: f.sdk, runtime: makeRuntime() });
    mutate(options);
    replay.start();
    expectForwarded(f.getStartOptions());
    replay.dispose();
  });

  test('coordinator preserves the snapshot when a page is detached and reattached', () => {
    const f = makeSdk();
    const options = networkOptions();
    const c = new ReplayCoordinator({
      minReplayDuration: 0,
      ...options,
      sdk: f.sdk,
      client: f.sdk.getClient()!,
      replaysOnErrorSampleRate: 1,
    });
    c.attachRoot(makeRuntime());
    mutate(options);
    c.detachRoot();
    c.attachRoot(makeRuntime());
    expectForwarded(f.getStartOptions());
    c.destroy();
  });

  test('integration snapshots before setup and preserves options after error promotion', async () => {
    const f = makeSdk();
    const options = networkOptions();
    const integration = taroReplayIntegration({
      minReplayDuration: 0,
      ...options,
      sdk: f.sdk,
      replaysOnErrorSampleRate: 1,
    });
    mutate(options);
    integration.setup?.(f.sdk.getClient() as never);
    integration.bridge.attachRoot(makeRuntime());
    expectForwarded(f.getStartOptions());
    f.emitBeforeSend({
      event_id: 'a'.repeat(32),
      exception: { values: [{ type: 'Error', value: 'synthetic error' }] },
    });
    for (let index = 0; index < 20; index++) await Promise.resolve();
    expect(integration.bridge.getSnapshot().state).toBe('session');
    expectForwarded(f.getStartOptions());
    integration.cleanup();
  });

  test('private hint details are re-filtered without mutating ordinary breadcrumbs', () => {
    const f = makeSdk();
    const replay = createTaroReplay({ ...networkOptions(), sdk: f.sdk, runtime: makeRuntime() });
    replay.start();
    const breadcrumb = Object.freeze({
      category: 'fetch',
      data: Object.freeze({ url: 'https://example.com/api/items', status_code: 200 }),
    });
    const hint = Object.freeze({
      replayNetworkDetails: Object.freeze({
        url: 'https://example.com/api/items',
        request_headers: Object.freeze({
          'X-Request-Id': 'synthetic-hint',
          Authorization: 'private',
        }),
        response_headers: Object.freeze({ 'X-Response-Id': 'synthetic-response' }),
      }),
    });
    f.emitBreadcrumb(breadcrumb, hint);
    expect(f.addRecordedBreadcrumb).toHaveBeenLastCalledWith({
      ...breadcrumb,
      data: {
        ...breadcrumb.data,
        request_headers: { 'x-request-id': 'synthetic-hint' },
        response_headers: { 'x-response-id': 'synthetic-response' },
      },
    });
    expect(breadcrumb.data).toEqual({ url: 'https://example.com/api/items', status_code: 200 });
    expect(hint.replayNetworkDetails.request_headers.Authorization).toBe('private');
    replay.dispose();
  });

  test('a hint for another URL cannot attach header details after breadcrumb URL rewriting', () => {
    const f = makeSdk();
    const replay = createTaroReplay({ ...networkOptions(), sdk: f.sdk, runtime: makeRuntime() });
    replay.start();
    const breadcrumb = { category: 'fetch', data: { url: 'https://example.com/api/other' } };
    f.emitBreadcrumb(breadcrumb, {
      replayNetworkDetails: {
        url: 'https://example.com/api/items',
        request_headers: { 'X-Request-Id': 'mismatched-header' },
      },
    });
    expect(f.addRecordedBreadcrumb).toHaveBeenLastCalledWith(breadcrumb);
    replay.dispose();
  });

  test('throwing hint getters and proxies cannot interrupt host breadcrumb processing', () => {
    const f = makeSdk();
    const onError = vi.fn();
    const replay = createTaroReplay({
      ...networkOptions(),
      sdk: f.sdk,
      runtime: makeRuntime(),
      onError,
    });
    replay.start();
    const breadcrumb = { category: 'fetch', data: { url: 'https://example.com/api/items' } };
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('synthetic getter failure');
        },
      },
    );
    expect(() => f.emitBreadcrumb(breadcrumb, hostile)).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(breadcrumb.data).toEqual({ url: 'https://example.com/api/items' });
    replay.dispose();
  });

  test('configuration getters cannot be invoked later by integration setup or coordinator copies', () => {
    const getter = vi.fn(() => {
      throw new Error('synthetic configuration getter');
    });
    const f = makeSdk();
    const config = { networkDetailAllowUrls: ['https://example.com/'] };
    Object.defineProperty(config, 'networkDetailDenyUrls', { get: getter, enumerable: true });
    const integrationOptions = Object.defineProperties(
      { sdk: f.sdk, replaysOnErrorSampleRate: 1 },
      Object.getOwnPropertyDescriptors(config),
    );
    const integration = taroReplayIntegration(integrationOptions);
    expect(() => integration.setup?.(f.sdk.getClient() as never)).not.toThrow();
    integration.bridge.attachRoot(makeRuntime());
    f.emitBreadcrumb({
      category: 'xhr',
      data: {
        url: 'https://example.com/api/items',
        request_headers: { Accept: 'private-on-invalid-deny' },
      },
    });
    expect(f.addRecordedBreadcrumb.mock.calls.at(-1)![0].data.request_headers).toBe('[Filtered]');
    integration.cleanup();
    const coordinatorOptions = Object.defineProperties(
      { sdk: f.sdk, client: f.sdk.getClient()!, replaysOnErrorSampleRate: 1 },
      Object.getOwnPropertyDescriptors(config),
    );
    const coordinator = new ReplayCoordinator(coordinatorOptions);
    coordinator.attachRoot(makeRuntime());
    coordinator.destroy();
    expect(getter).not.toHaveBeenCalled();
  });

  test('manual and client breadcrumbs both require the explicit allowlist', () => {
    const f = makeSdk();
    const options: CreateTaroReplayOptions = {
      ...networkOptions(),
      sdk: f.sdk,
      runtime: makeRuntime(),
    };
    const replay = createTaroReplay(options);
    replay.start();
    const crumb = {
      category: 'fetch',
      data: {
        url: 'https://example.com/api/items?token=secret',
        request_headers: {
          'Content-Type': 'application/json',
          'X-Request-Id': 'synthetic-1',
          Authorization: 'Bearer secret',
          'X-Private': 'private',
        },
        response_headers: {
          'Content-Type': 'application/json',
          'X-Response-Id': 'synthetic-2',
          'Set-Cookie': 'private',
        },
        headers: { 'Content-Type': 'not-the-explicit-field' },
        request_body: { secret: 'private' },
      },
    };
    f.emitBreadcrumb(crumb);
    replay.getController()?.addBreadcrumb?.(crumb);
    const expected = {
      category: 'fetch',
      data: {
        url: 'https://example.com/api/items',
        request_headers: { 'content-type': 'application/json', 'x-request-id': 'synthetic-1' },
        response_headers: { 'content-type': 'application/json', 'x-response-id': 'synthetic-2' },
        headers: '[Filtered]',
        request_body: '[Filtered]',
      },
    };
    expect(f.addRecordedBreadcrumb).toHaveBeenLastCalledWith(expected);
    expect(f.addRecordedBreadcrumb.mock.calls.slice(-2).map(([value]) => value)).toEqual([
      expected,
      expected,
    ]);
    replay.dispose();
  });
});
