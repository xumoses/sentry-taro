import type { Envelope, Event } from '@sentry/core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';
import * as Sentry from '../../src/index';
import { resetPlatformCache } from '../../src/sdk/crossPlatform';
import { makeRuntime } from './fixtures';

type ReplayEvent = {
  replay_id: string;
  error_ids: string[];
  sdk?: { name?: string; version?: string };
};

const clients: NonNullable<ReturnType<typeof Sentry.init>>[] = [];
const integrations: Sentry.TaroReplayIntegration[] = [];

beforeEach(() => {
  vi.stubGlobal('wx', {
    request: vi.fn(),
    getDeviceInfo: () => ({ platform: 'ios', system: 'iOS 16.0', brand: 'Apple' }),
    getAppBaseInfo: () => ({ version: '8.0.0', SDKVersion: '3.6.2', language: 'en' }),
    getWindowInfo: () => ({ windowWidth: 390, windowHeight: 844 }),
  });
  resetPlatformCache();
});

afterEach(async () => {
  for (const integration of integrations.splice(0)) integration.cleanup();
  for (const client of clients.splice(0)) await client.close(0);
  Sentry.getCurrentScope().clear();
  Sentry.getIsolationScope().clear();
  Sentry.getGlobalScope().clear();
  Sentry.getCurrentScope().setClient(undefined);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetPlatformCache();
});

function setup(
  integration?: Sentry.TaroReplayIntegration,
  sampleRates = { replaysSessionSampleRate: 1, replaysOnErrorSampleRate: 0 },
) {
  const envelopes: Envelope[] = [];
  const client = Sentry.init({
    dsn: 'https://public@example.test/1',
    defaultIntegrations: false,
    integrations: integration ? [integration] : [],
    enableAutoSessionTracking: false,
    enableNavigationBreadcrumbs: false,
    enableUserInteractionBreadcrumbs: false,
    enableNetworkStatusMonitoring: false,
    enableOfflineCache: false,
    ...sampleRates,
    transport: () => ({
      send: async (envelope) => {
        envelopes.push(envelope);
        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
  });
  if (!client) throw new Error('Synthetic mini program client did not initialize');
  clients.push(client);
  if (integration) integrations.push(integration);
  const items = (): Array<[{ type: string }, unknown]> => {
    const result: Array<[{ type: string }, unknown]> = [];
    for (const envelope of envelopes) for (const item of envelope[1]) result.push(item);
    return result;
  };
  return {
    client,
    errors: () =>
      items()
        .filter(([header]) => header.type === 'event')
        .map(([, body]) => body as Event),
    replays: () =>
      items()
        .filter(([header]) => header.type === 'replay_event')
        .map(([, body]) => body as ReplayEvent),
    recordings: () =>
      items()
        .filter(([header]) => header.type === 'replay_recording')
        .map(([, body]) => String(body)),
  };
}

function runtime() {
  const observe = vi.fn();
  const disconnect = vi.fn();
  const value = makeRuntime({
    nodeType: 1,
    nodeName: 'view',
    attributes: [],
    childNodes: [{ nodeType: 3, textContent: 'synthetic private label' }],
  });
  value.MutationObserver = class {
    observe = observe;
    disconnect = disconnect;
  };
  return { value, observe, disconnect };
}

describe('unified public SDK with real client and recorder', () => {
  test.each(['default SDK', 'explicit compatibility SDK'] as const)(
    '%s reports errors and recordings through the same client',
    async (mode) => {
      const integration =
        mode === 'default SDK'
          ? Sentry.replayIntegration({ minReplayDuration: 0 })
          : Sentry.taroReplayIntegration({ minReplayDuration: 0, sdk: Sentry });
      const f = setup(integration);
      const page = runtime();
      expect(Sentry.getClient()).toBe(f.client);
      expect(integration.bridge.attachRoot(page.value)).toBe(true);
      expect(page.observe).toHaveBeenCalledOnce();
      const id = integration.bridge.getReplayId?.();
      expect(id).toMatch(/^[a-f0-9]{32}$/);

      const errorId = Sentry.captureException(new Error('synthetic unified API error'));
      await f.client.flush(1000);
      await integration.bridge.flush();

      expect(f.errors()).toHaveLength(1);
      expect(f.errors()[0]).toMatchObject({
        event_id: errorId,
        contexts: { replay: { replay_id: id } },
      });
      expect(f.replays()[0]).toMatchObject({ replay_id: id, error_ids: [errorId] });
      expect(f.recordings().join('')).toContain('"type":2');
      expect(f.recordings().join('')).not.toContain('synthetic private label');
      integration.bridge.detachRoot();
      expect(page.disconnect).toHaveBeenCalledOnce();
    },
  );

  test('client sampling keeps a buffer local until an accepted error promotes it', async () => {
    const integration = Sentry.replayIntegration({ minReplayDuration: 0 });
    const f = setup(integration, { replaysSessionSampleRate: 0, replaysOnErrorSampleRate: 1 });
    const page = runtime();
    expect(integration.bridge.attachRoot(page.value)).toBe(true);
    expect(integration.bridge.getSnapshot().state).toBe('buffer');
    await integration.bridge.flush();
    expect(f.replays()).toHaveLength(0);

    const id = integration.bridge.getReplayId?.();
    const errorId = Sentry.captureException(new Error('synthetic promotion error'));
    await f.client.flush(1000);
    await integration.bridge.flush();
    expect(f.errors()[0]?.contexts?.replay?.replay_id).toBe(id);
    expect(f.replays()[0]).toMatchObject({ replay_id: id, error_ids: [errorId] });
    expect(page.observe).toHaveBeenCalledOnce();
    expect(integration.bridge.getSnapshot().state).toBe('session');
  });

  test.each(['integration omitted', 'sampled out'] as const)(
    '%s preserves error reporting without starting recording',
    async (mode) => {
      const integration = Sentry.replayIntegration({ minReplayDuration: 0 });
      const f =
        mode === 'integration omitted'
          ? setup()
          : setup(integration, { replaysSessionSampleRate: 0, replaysOnErrorSampleRate: 0 });
      const page = runtime();
      expect(integration.bridge.attachRoot(page.value)).toBe(false);
      Sentry.captureException(new Error('synthetic error without recording'));
      await f.client.flush(1000);
      await integration.bridge.flush();
      expect(f.errors()).toHaveLength(1);
      expect(f.errors()[0]?.contexts?.replay).toBeUndefined();
      expect(f.replays()).toHaveLength(0);
      expect(page.observe).not.toHaveBeenCalled();
    },
  );

  test('synthetic iOS frames distinguish the unified SDK from application code', () => {
    const frames = Sentry.miniappStackParser(
      'Error: synthetic stack\n' +
        'capture@lib/sentry-taro.js:10:2\n' +
        'tap@pages/demo/index.js:20:3',
    );
    expect(frames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ filename: 'lib/sentry-taro.js', in_app: false }),
        expect.objectContaining({ filename: 'pages/demo/index.js', in_app: true }),
      ]),
    );
  });
});
