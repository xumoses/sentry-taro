import type { ReplayEnvelope } from '@sentry/core';
import { describe, expect, test, vi } from 'vite-plus/test';

import { ReplayCoordinator } from '../src/coordinator/ReplayCoordinator';
import { ReplayDelivery } from '../src/coordinator/delivery';
import { createTaroReplay } from '../src/createTaroReplay';
import { sendReplayCapture } from '../src/envelope';
import type { SentryReplayClient } from '../src/types';
import { makeCapture, makeRuntime, makeSdk } from './fixtures';

type Contexts = Record<string, Record<string, unknown>>;
const defaults: Contexts = {
  os: { name: 'macOS', version: '27.0.1' },
  device: { simulator: true, arch: 'arm64' },
  browser: { name: 'WeChat DevTools', version: '2.02.2607271' },
  miniapp_simulator: { system: 'iOS 10.0.1', model: 'iPhone 12/13 (Pro)' },
  runtime: { name: 'miniapp', version: '3.7.12' },
};
const contexts = (envelope: ReplayEnvelope) => envelope[1][0][1].contexts;
const settle = async () => {
  for (let index = 0; index < 25; index++) await Promise.resolve();
};
function deferred() {
  let resolve!: (value: Contexts) => void;
  const promise = new Promise<Contexts>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(provider?: () => PromiseLike<Contexts>, enabled = true) {
  const f = makeSdk();
  const client: SentryReplayClient = {
    ...f.sdk.getClient()!,
    getOptions: () => ({ enableSystemInfo: enabled, release: 'example@1.0.0' }),
    ...(provider ? { getRuntimeContexts: provider } : {}),
  };
  f.sdk.getClient = () => client;
  const runtime = {
    ...makeRuntime(),
    getDeviceInfo: vi.fn(() => ({
      platform: 'devtools',
      system: 'iOS 10.0.1',
      brand: 'devtools',
      model: 'iPhone 12/13 (Pro)',
    })),
    getAppBaseInfo: vi.fn(() => ({ version: '8.0.5', SDKVersion: '3.7.12' })),
    getAccountInfoSync: vi.fn(() => ({ miniProgram: { version: '1.0.0', envVersion: 'develop' } })),
  };
  return { ...f, client, runtime };
}

describe('Replay runtime context parity', () => {
  test('waits for shared defaults before an early send and merges explicit fields without mutation', async () => {
    const pending = deferred();
    const f = fixture(() => pending.promise);
    const capture = makeCapture({ metadata: { contexts: { os: { build: 'synthetic' } } } });
    const original = JSON.stringify(capture);
    const sent = sendReplayCapture(f.client, capture);
    expect(f.sendEnvelope).not.toHaveBeenCalled();
    pending.resolve(defaults);
    await sent;
    expect(contexts(f.sendEnvelope.mock.calls[0]![0])).toMatchObject({
      ...defaults,
      os: { ...defaults['os'], build: 'synthetic' },
    });
    expect(JSON.stringify(capture)).toBe(original);
    expect(defaults['os']).toEqual({ name: 'macOS', version: '27.0.1' });
  });

  test('synchronous start never stores stale wx defaults over the shared provider', async () => {
    const f = fixture(async () => defaults);
    const replay = createTaroReplay({
      sdk: f.sdk,
      runtime: f.runtime,
      getMetadata: () => ({ contexts: { os: { build: 'custom' }, device: { model: 'explicit' } } }),
    });
    expect(replay.start()).toBe(true);
    expect(f.runtime.getDeviceInfo).not.toHaveBeenCalled();
    expect(f.runtime.getAppBaseInfo).not.toHaveBeenCalled();
    expect(f.runtime.getAccountInfoSync).not.toHaveBeenCalled();
    await replay.stop();
    expect(contexts(f.sendEnvelope.mock.calls[0]![0])).toMatchObject({
      os: { name: 'macOS', version: '27.0.1', build: 'custom' },
      device: { simulator: true, model: 'explicit', arch: 'arm64' },
      browser: defaults['browser'],
    });
  });

  test('untyped JavaScript null contexts suppress shared defaults and are omitted from the envelope', async () => {
    const f = fixture(async () => defaults);
    const overrides = { contexts: { os: {} } };
    Reflect.set(overrides.contexts, 'os', null);
    const replay = createTaroReplay({
      sdk: f.sdk,
      runtime: f.runtime,
      getMetadata: () => overrides,
    });
    replay.start();
    await replay.stop();
    expect(contexts(f.sendEnvelope.mock.calls[0]![0])).not.toHaveProperty('os');
    expect(contexts(f.sendEnvelope.mock.calls[0]![0])?.['device']).toEqual(defaults['device']);
  });

  test.each([false, true])(
    'disabled system collection skips native metadata with provider=%s',
    async (provider) => {
      const f = fixture(provider ? async () => ({}) : undefined, false);
      const replay = createTaroReplay({ sdk: f.sdk, runtime: f.runtime });
      expect(replay.start()).toBe(true);
      await replay.stop();
      expect(f.runtime.getDeviceInfo).not.toHaveBeenCalled();
      expect(f.runtime.getAppBaseInfo).not.toHaveBeenCalled();
      expect(f.runtime.getAccountInfoSync).not.toHaveBeenCalled();
      const value = contexts(f.sendEnvelope.mock.calls[0]![0]);
      expect(value).not.toHaveProperty('os');
      expect(value).not.toHaveProperty('device');
      expect(value).not.toHaveProperty('browser');
      expect(f.getStartOptions()).toMatchObject({ width: 390, height: 844 });
    },
  );

  test.each(['empty', 'reject', 'throw'])(
    'a provider %s never falls back to simulated native metadata',
    async (mode) => {
      const f = fixture(() => {
        if (mode === 'throw') throw new Error('unavailable');
        return mode === 'reject' ? Promise.reject(new Error('unavailable')) : Promise.resolve({});
      });
      const replay = createTaroReplay({ sdk: f.sdk, runtime: f.runtime });
      replay.start();
      await replay.stop();
      expect(f.sendEnvelope).toHaveBeenCalledOnce();
      expect(contexts(f.sendEnvelope.mock.calls[0]![0])).not.toHaveProperty('os');
      expect(f.runtime.getDeviceInfo).not.toHaveBeenCalled();
    },
  );

  test('older SDK fallback keeps emulated device metadata separate without browser probing', async () => {
    const f = fixture();
    const replay = createTaroReplay({ sdk: f.sdk, runtime: f.runtime });
    replay.start();
    await replay.stop();
    expect(contexts(f.sendEnvelope.mock.calls[0]![0])).toMatchObject({
      os: { name: 'unknown' },
      device: { simulator: true },
      miniapp_simulator: { system: 'iOS 10.0.1', model: 'iPhone 12/13 (Pro)' },
    });
    expect(contexts(f.sendEnvelope.mock.calls[0]![0])?.['device']).not.toHaveProperty(
      'model',
      'iPhone 12/13 (Pro)',
    );
    expect(contexts(f.sendEnvelope.mock.calls[0]![0])?.['device']).not.toHaveProperty('model');
    expect(contexts(f.sendEnvelope.mock.calls[0]![0])?.['device']).not.toHaveProperty('brand');
  });

  test('standalone finalization stays bound to its original client after SDK reinitialization', async () => {
    const f = fixture(async () => defaults);
    const replay = createTaroReplay({ sdk: f.sdk, runtime: f.runtime });
    replay.start();
    const replacement = fixture(async () => ({ os: { name: 'replacement' } }));
    f.sdk.getClient = () => replacement.client;
    await replay.stop();
    expect(f.sendEnvelope).toHaveBeenCalledOnce();
    expect(replacement.sendEnvelope).not.toHaveBeenCalled();
    expect(contexts(f.sendEnvelope.mock.calls[0]![0])?.['os']).toEqual(defaults['os']);
  });

  test.each(['cancel', 'disable'])(
    'a pending provider cannot send after delivery %s',
    async (reason) => {
      const pending = deferred();
      const f = fixture(() => pending.promise);
      let enabled = true;
      const queue = new ReplayDelivery(f.client, { isEnabled: () => enabled, onChange() {} });
      const completion = queue.enqueue(makeCapture(), {});
      if (reason === 'cancel') queue.cancel();
      else enabled = false;
      pending.resolve(defaults);
      await completion;
      expect(f.sendEnvelope).not.toHaveBeenCalled();
      expect(queue.getSnapshot()).toMatchObject({
        pendingSegments: 0,
        acceptedSegments: 0,
        handedOffSegments: 0,
      });
    },
  );

  test('buffer rollover, promotion and later segments all use the same client defaults', async () => {
    const pending = deferred();
    const f = fixture(() => pending.promise);
    const coordinator = new ReplayCoordinator({
      sdk: f.sdk,
      client: f.client,
      replaysOnErrorSampleRate: 1,
      now: () => 1_700_000_002_000,
    });
    coordinator.attachRoot(f.runtime);
    f.getStartOptions().onStop?.(makeCapture({ ...f.getStartOptions(), stopReason: 'duration' }));
    await settle();
    f.emitBeforeSend({ event_id: 'synthetic-error', exception: { values: [{ type: 'Error' }] } });
    await settle();
    expect(f.sendEnvelope).not.toHaveBeenCalled();
    pending.resolve(defaults);
    await coordinator.flush();
    coordinator.detachRoot();
    await settle();
    coordinator.attachRoot(f.runtime);
    await coordinator.flush();
    expect(f.sendEnvelope.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [envelope] of f.sendEnvelope.mock.calls) {
      expect(contexts(envelope)?.['os']).toEqual(defaults['os']);
      expect(contexts(envelope)?.['device']).toEqual(defaults['device']);
    }
    coordinator.destroy();
  });
});
