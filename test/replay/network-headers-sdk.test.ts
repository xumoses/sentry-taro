import {
  Client,
  addBreadcrumb,
  withIsolationScope,
  withScope,
  type ClientOptions,
  type Event,
  type EventHint,
  type SeverityLevel,
} from '@sentry/core';
import { afterEach, describe, expect, test, vi } from 'vite-plus/test';
import { createTaroReplay } from '../../src/replay/createTaroReplay';
import { taroReplayIntegration } from '../../src/replay/coordinator/integration';
import { makeRuntime, makeSdk } from './fixtures';
import type {
  SentryMiniappReplaySdk,
  StartTaroReplayRecorderOptions,
  TaroReplayEvent,
  TaroReplayNetworkOptions,
  TaroReplayRecorderController,
} from '../../src/replay/types';

class HeaderClient extends Client {
  constructor(options: ClientOptions) {
    super(options);
  }
  eventFromException(_exception: unknown, _hint?: EventHint): PromiseLike<Event> {
    return Promise.resolve({});
  }
  eventFromMessage(
    _message: string,
    _level?: SeverityLevel,
    _hint?: EventHint,
  ): PromiseLike<Event> {
    return Promise.resolve({});
  }
}

const headers = {
  networkDetailAllowUrls: [/^https:\/\/example\.com\/api\//g],
  networkDetailDenyUrls: [/\/private(?:\/|$)/g],
  networkRequestHeaders: ['X-Request-Id', 'Authorization', 'Cookie', 'X-Token'],
  networkResponseHeaders: ['X-Response-Id', 'Set-Cookie'],
};
const network = (url = 'https://example.com/api/items?token=secret#fragment') => ({
  category: 'fetch',
  data: {
    url,
    method: 'POST',
    status_code: 200,
    request_headers: {
      'Content-Type': 'application/json',
      'X-Request-Id': 'synthetic-1',
      Authorization: 'Bearer private',
      Cookie: 'secret-cookie',
      'X-Token': 'secret-token',
      'X-Unlisted': 'not-allowed',
    },
    response_headers: {
      'Content-Length': '12',
      'X-Response-Id': 'synthetic-2',
      'Set-Cookie': 'private-cookie',
    },
    request_body: 'private-body',
    response_body: 'private-response',
  },
});
const settle = async () => {
  for (let index = 0; index < 25; index++) await Promise.resolve();
};
function spans(events: TaroReplayEvent[]) {
  return events
    .filter((event) => event.data['tag'] === 'performanceSpan')
    .map(
      (event) =>
        event.data['payload'] as {
          description: string;
          data: {
            request: { headers: Record<string, string> };
            response: { headers: Record<string, string> };
          };
        },
    );
}
async function fixture() {
  const { startTaroDomReplayPoc } = (await import('../../src/replay/recorder/recorder')) as Pick<
    SentryMiniappReplaySdk,
    'startTaroDomReplayPoc'
  >;
  const f = makeSdk();
  const controllers: TaroReplayRecorderController[] = [];
  const starts: StartTaroReplayRecorderOptions[] = [];
  f.sdk.startTaroDomReplayPoc = (options) => {
    starts.push(options);
    const controller = startTaroDomReplayPoc(options);
    controllers.push(controller);
    return controller;
  };
  const runtime = makeRuntime({ nodeType: 1, nodeName: 'view', attributes: [], childNodes: [] });
  return { ...f, runtime, controllers, starts };
}
afterEach(() => vi.useRealTimers());

describe('workspace network header SDK and adapter contract', () => {
  test('defaults stay closed even for manually supplied network detail fields', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const replay = createTaroReplay({ sdk: f.sdk, runtime: f.runtime });
    replay.start();
    replay.getController()?.addBreadcrumb?.(network());
    const capture = replay.getController()!.getCapture();
    expect(spans(capture.events)[0]!.data).toMatchObject({
      request: { headers: {} },
      response: { headers: {} },
    });
    expect(JSON.stringify(capture)).not.toContain('synthetic-1');
    expect(JSON.stringify(capture)).not.toContain('private-body');
    replay.dispose();
  });

  test('both layers preserve only allowed headers; repeated global patterns stay deterministic', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const replay = createTaroReplay({ sdk: f.sdk, runtime: f.runtime, ...headers });
    replay.start();
    f.emitBreadcrumb(network());
    replay.getController()?.addBreadcrumb?.(network());
    for (const url of [
      'https://example.com/api/private/items',
      'https://other.example.com/api/items',
      'https://example.com.evil.com/api/items',
    ])
      f.emitBreadcrumb(network(url));
    const capture = replay.getController()!.getCapture();
    const recorded = spans(capture.events);
    expect(recorded).toHaveLength(5);
    for (const span of recorded.slice(0, 2)) {
      expect(span.description).toBe('https://example.com/api/items');
      expect(span.data).toMatchObject({
        request: { headers: { 'content-type': 'application/json', 'x-request-id': 'synthetic-1' } },
        response: { headers: { 'content-length': '12', 'x-response-id': 'synthetic-2' } },
      });
    }
    for (const span of recorded.slice(2))
      expect(span.data).toMatchObject({ request: { headers: {} }, response: { headers: {} } });
    for (const secret of [
      'private-body',
      'private-response',
      'secret-cookie',
      'secret-token',
      'Bearer private',
      'not-allowed',
      'token=secret',
    ])
      expect(JSON.stringify(capture)).not.toContain(secret);
    expect(headers.networkDetailAllowUrls[0]!.lastIndex).toBe(0);
    replay.dispose();
  });

  test('snapshotted policy survives buffer rollover, error promotion and page reattach', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const callerAllow = [/^https:\/\/example\.com\/api\//g];
    const callerHeaders = ['X-Request-Id'];
    const options: TaroReplayNetworkOptions = {
      networkDetailAllowUrls: callerAllow,
      networkRequestHeaders: callerHeaders,
      networkResponseHeaders: ['X-Response-Id'],
    };
    const integration = taroReplayIntegration({
      minReplayDuration: 0,
      sdk: f.sdk,
      ...options,
      replaysOnErrorSampleRate: 1,
      limits: { maxDurationMs: 5 * 60_000 },
    });
    integration.setup?.(f.sdk.getClient() as never);
    integration.bridge.attachRoot(f.runtime);
    callerAllow.length = 0;
    callerHeaders.length = 0;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(f.controllers).toHaveLength(2);
    f.emitBreadcrumb(network());
    f.emitBeforeSend({
      event_id: 'e'.repeat(32),
      exception: { values: [{ type: 'Error', value: 'synthetic error' }] },
    });
    await settle();
    expect(integration.bridge.getSnapshot().state).toBe('session');
    expect(f.controllers).toHaveLength(2); // Promotion retains the current observer.
    expect(f.sendEnvelope.mock.calls[0]![0][1][1][1]).toContain('synthetic-1');
    f.emitBreadcrumb(network());
    await integration.bridge.flush();
    expect(f.sendEnvelope.mock.calls.at(-1)![0][1][1][1]).toContain('synthetic-2');
    integration.bridge.detachRoot();
    integration.bridge.attachRoot(f.runtime);
    f.emitBreadcrumb(network());
    expect(
      spans(f.controllers.at(-1)!.getCapture().events)[0]!.data.request.headers['x-request-id'],
    ).toBe('synthetic-1');
    integration.cleanup();
  });

  test('real core keeps hint header values out of the error envelope but includes them in Replay', async () => {
    const f = await fixture();
    const items: Array<{ type: string; value: unknown }> = [];
    const client = new HeaderClient({
      dsn: 'https://public@example.com/1',
      integrations: [],
      stackParser: () => [],
      transport: () => ({
        send: (envelope) => {
          for (const [header, value] of envelope[1]) items.push({ type: header.type, value });
          return Promise.resolve({ statusCode: 200 });
        },
        flush: () => Promise.resolve(true),
      }),
    });
    const sdk = { ...f.sdk, getClient: () => client, addBreadcrumb };
    const integration = taroReplayIntegration({
      minReplayDuration: 0,
      sdk,
      ...headers,
      replaysSessionSampleRate: 1,
    });
    integration.setup?.(client);
    await withIsolationScope(async () =>
      withScope(async (scope) => {
        scope.setClient(client);
        integration.bridge.attachRoot(f.runtime);
        const breadcrumb = Object.freeze({
          category: 'xhr',
          data: Object.freeze({ url: 'https://example.com/api/items', status_code: 200 }),
        });
        const hint = Object.freeze({
          replayNetworkDetails: Object.freeze({
            url: 'https://example.com/api/items',
            request_headers: Object.freeze({ 'X-Request-Id': 'only-in-replay-123' }),
            response_headers: Object.freeze({ 'X-Response-Id': 'only-in-replay-456' }),
          }),
        });
        addBreadcrumb(breadcrumb, hint);
        scope.captureEvent({
          event_id: 'f'.repeat(32),
          exception: { values: [{ type: 'Error', value: 'synthetic error' }] },
        });
        await client.flush(1000);
        await integration.bridge.flush();
        const error = items.find((item) => item.type === 'event');
        const recording = items.find((item) => item.type === 'replay_recording');
        expect(error).toBeDefined();
        expect(JSON.stringify(error)).toContain('https://example.com/api/items');
        expect(JSON.stringify(error)).not.toContain('only-in-replay');
        expect(JSON.stringify(error)).not.toContain('request_headers');
        expect(JSON.stringify(recording)).toContain('only-in-replay-123');
        expect(JSON.stringify(recording)).toContain('only-in-replay-456');
        expect(breadcrumb.data).toEqual({ url: 'https://example.com/api/items', status_code: 200 });
      }),
    );
    integration.cleanup();
    await client.close(0);
  });

  test('manual oversized values obey count and byte budgets after two filtering layers', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const names = Array.from({ length: 30 }, (_, index) => `x-demo-${index}`);
    const replay = createTaroReplay({
      sdk: f.sdk,
      runtime: f.runtime,
      networkDetailAllowUrls: ['https://example.com/'],
      networkRequestHeaders: names,
    });
    replay.start();
    const data = Object.fromEntries(names.map((name) => [name, 'a']));
    data[names[0]!] = '界'.repeat(342); // 1026 UTF-8 bytes: skipped, never truncated.
    replay.getController()?.addBreadcrumb?.({
      category: 'xhr',
      data: { url: 'https://example.com/api/items', request_headers: data },
    });
    const recorded = spans(replay.getController()!.getCapture().events)[0]!.data.request.headers;
    expect(Object.keys(recorded)).toHaveLength(20);
    expect(recorded[names[0]!]).toBeUndefined();
    expect(
      Object.entries(recorded).reduce(
        (sum, [name, value]) => sum + Buffer.byteLength(name + value),
        0,
      ),
    ).toBeLessThanOrEqual(4096);
    replay.dispose();
  });
});
