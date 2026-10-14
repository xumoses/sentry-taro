import type { Envelope } from '@sentry/core';
import { afterEach, describe, expect, test, vi } from 'vite-plus/test';
import { createTaroReplay } from '../src/createTaroReplay';
import { makeRuntime } from './fixtures';

// The real client and recorder contract is mandatory in the unified workspace.
afterEach(() => vi.unstubAllGlobals());
describe('workspace SDK shared error and Replay metadata', () => {
  test('early Replay and real core error share one bounded provider and never inherit scope identity', async () => {
    const sdk = await import('../../sdk/src/index');
    const platform = await import('../../sdk/src/crossPlatform');
    const device = vi.fn(() => ({
      platform: 'devtools',
      system: 'iOS 10.0.1',
      brand: 'devtools',
      model: 'iPhone12/13(Pro)',
    }));
    const appBase = vi.fn(() => ({ version: '8.0.5', SDKVersion: '3.7.12', language: 'zh_CN' }));
    const account = vi.fn(() => ({ miniProgram: { version: '1.0.0', appId: 'private-app-id' } }));
    let resolve!: (value: unknown) => void;
    const hints = vi.fn(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    vi.stubGlobal('wx', {
      request: vi.fn(),
      getDeviceInfo: device,
      getAppBaseInfo: appBase,
      getAccountInfoSync: account,
      getWindowInfo: () => ({
        windowWidth: 390,
        windowHeight: 844,
        screenWidth: 390,
        screenHeight: 844,
      }),
    });
    vi.stubGlobal('navigator', {
      platform: 'MacIntel',
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) wechatdevtools/2.02.2607271 Chrome/136.0.0.0',
      userAgentData: { platform: 'macOS', getHighEntropyValues: hints },
    });
    platform.resetPlatformCache();
    const envelopes: Envelope[] = [];
    const client = sdk.init({
      dsn: 'https://public@example.com/1',
      defaultIntegrations: false,
      enableAutoSessionTracking: false,
      enableNavigationBreadcrumbs: false,
      enableUserInteractionBreadcrumbs: false,
      enableNetworkStatusMonitoring: false,
      enableSourceMap: false,
      enableOfflineCache: false,
      transport: () => ({
        send: async (envelope: Envelope) => {
          envelopes.push(envelope);
          return { statusCode: 200 };
        },
        flush: async () => true,
      }),
    });
    if (!client) throw new Error('Synthetic mini program client did not initialize');
    sdk.setUser({ id: 'scope-only-user' });
    sdk.setContext('private_scope', { value: 'scope-only-context' });
    const runtime = {
      ...makeRuntime({ nodeType: 1, nodeName: 'view', attributes: [], childNodes: [] }),
      getDeviceInfo: vi.fn(() => {
        throw new Error('adapter must use client provider');
      }),
      getAppBaseInfo: vi.fn(() => {
        throw new Error('adapter must use client provider');
      }),
    };
    const replay = createTaroReplay({ sdk, runtime });
    try {
      expect(replay.start()).toBe(true);
      const stopped = replay.stop();
      sdk.captureException(new Error('synthetic shared runtime parity'));
      await vi.waitFor(() => expect(hints).toHaveBeenCalledOnce());
      expect(envelopes).toHaveLength(0);
      resolve({ platform: 'macOS', platformVersion: '27.0.1', architecture: 'arm', bitness: '64' });
      await stopped;
      await client.flush(2000);
      const items: Array<[{ type: string }, unknown]> = [];
      for (const envelope of envelopes) for (const item of envelope[1]) items.push(item);
      const error = items.find(([header]) => header.type === 'event')?.[1] as any;
      const recording = items.find(([header]) => header.type === 'replay_event')?.[1] as any;
      expect(error).toBeDefined();
      expect(recording).toBeDefined();
      for (const key of [
        'os',
        'device',
        'browser',
        'app',
        'runtime',
        'miniapp_host',
        'miniapp_simulator',
      ]) {
        expect(recording.contexts[key]).toEqual(error.contexts[key]);
      }
      expect(recording.contexts.os).toEqual({ name: 'macOS', version: '27.0.1' });
      expect(recording.contexts.device).toMatchObject({ simulator: true, arch: 'arm64' });
      expect(recording.contexts.device).not.toHaveProperty('model');
      expect(recording.contexts.device).not.toHaveProperty('brand');
      expect(recording.contexts.miniapp_simulator.system).toBe('iOS 10.0.1');
      expect(error.user.id).toBe('scope-only-user');
      expect(JSON.stringify(recording)).not.toMatch(/scope-only|private-app-id/);
      expect(hints).toHaveBeenCalledOnce();
      expect(device).toHaveBeenCalledOnce();
      expect(runtime.getDeviceInfo).not.toHaveBeenCalled();
      expect(runtime.getAppBaseInfo).not.toHaveBeenCalled();
    } finally {
      replay.dispose();
      sdk.getCurrentScope().clear();
      sdk.getIsolationScope().clear();
      await client.close(0);
      sdk.getCurrentScope().setClient(undefined);
      platform.resetPlatformCache();
    }
  });
});
