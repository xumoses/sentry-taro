import { afterEach, describe, expect, test, vi } from 'vite-plus/test';
import { ReplayDelivery } from '../src/coordinator/delivery';
import { ReplayCoordinator } from '../src/coordinator/ReplayCoordinator';
import { taroReplayIntegration } from '../src/coordinator/integration';
import { makeRuntime, makeSdk } from './fixtures';
import type { TaroReplayCapture, TaroReplayRecorderController } from '../src/types';

const settle = async () => {
  for (let index = 0; index < 20; index++) await Promise.resolve();
};
const error = (id = 'e') => ({
  event_id: id.repeat(32),
  exception: { values: [{ type: 'Error', value: 'synthetic' }] },
});
function recorderHarness({ drain = true, initialLimit = false, promotion = false } = {}) {
  const f = makeSdk();
  let active = 0;
  const controllers: TaroReplayRecorderController[] = [];
  const onBufferFull: (() => void)[] = [];
  const pageScroll = vi.fn(() => true);
  const viewport = vi.fn(() => true);
  f.sdk.startTaroDomReplayPoc = (options) => {
    onBufferFull.push(() => options.onBufferFull?.());
    const startedAt = Date.now();
    let stopped = false;
    let capture: TaroReplayCapture = {
      marker: 'TARO_DOM_REPLAY_POC',
      version: 1,
      replayId: options.replayId!,
      href: options.href!,
      startedAt,
      endedAt: null,
      stopReason: null,
      events: [
        { type: 4, timestamp: startedAt, data: { href: options.href } },
        { type: 2, timestamp: startedAt + 1, data: { node: { id: 1, childNodes: [] } } },
      ],
      stats: {
        eventCount: 2,
        approximateBytes: 200,
        mutationCount: 0,
        breadcrumbCount: 0,
        networkCount: 0,
      },
      warnings: [],
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const copy = () => ({ ...capture, events: [...capture.events], stats: { ...capture.stats } });
    const controller: TaroReplayRecorderController = {
      getCapture: copy,
      addBreadcrumb: () => {
        if (stopped) return false;
        capture.events.push({ type: 5, timestamp: Date.now() + 2, data: { tag: 'breadcrumb' } });
        return true;
      },
      stop(reason = 'manual') {
        if (!stopped) {
          stopped = true;
          active--;
          clearTimeout(timer);
          capture.endedAt = Date.now();
          capture.stopReason = reason;
          options.onStop?.(copy());
        }
        return copy();
      },
      ...(drain
        ? {
            takeSegment() {
              const segment = { ...copy(), endedAt: Date.now(), stopReason: 'segment' };
              capture = {
                ...capture,
                events: [],
                startedAt: Date.now(),
                stats: { ...capture.stats, eventCount: 0, approximateBytes: 0 },
              };
              return segment;
            },
          }
        : {}),
      ...(promotion
        ? {
            promoteToSession(duration: number) {
              controller.takeSegment!();
              clearTimeout(timer);
              timer = setTimeout(() => controller.stop('duration'), duration);
              return true;
            },
          }
        : {}),
      recordPageScroll: pageScroll,
      recordViewport: viewport,
    };
    active++;
    controllers.push(controller);
    if (initialLimit) {
      capture.events = capture.events.slice(0, 1);
      controller.stop('limit');
    } else timer = setTimeout(() => controller.stop('duration'), options.maxDurationMs);
    return controller;
  };
  return { ...f, controllers, onBufferFull, pageScroll, viewport, active: () => active };
}
afterEach(() => vi.useRealTimers());

describe('Replay recording ownership and controls', () => {
  test('a failed synchronous buffer drain stops the dependent recording chain', () => {
    vi.useFakeTimers();
    const f = recorderHarness();
    const c = new ReplayCoordinator({
      sdk: f.sdk,
      client: f.sdk.getClient()!,
      replaysSessionSampleRate: 1,
    });
    c.attachRoot(makeRuntime());
    f.controllers[0]!.stop('buffer-drain');
    expect(c.getSnapshot()).toMatchObject({ state: 'error', recording: false });
    expect(c.getSnapshot().error?.message).toContain('buffer drain failed');
    expect(f.sendEnvelope).not.toHaveBeenCalled();
    c.destroy();
  });

  test('an old stop completion cannot release a worker belonging to a restarted session', async () => {
    vi.useFakeTimers();
    const f = recorderHarness();
    let finish!: (value: unknown) => void;
    f.sendEnvelope.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const release = vi.spyOn(ReplayDelivery.prototype, 'releaseWorker');
    const c = new ReplayCoordinator({
      sdk: f.sdk,
      client: f.sdk.getClient()!,
      replaysSessionSampleRate: 1,
    });
    c.attachRoot(makeRuntime());
    const stopped = c.stop();
    c.start();
    c.attachRoot(makeRuntime());
    finish({ statusCode: 200 });
    await stopped;
    expect(c.getSnapshot()).toMatchObject({ state: 'session', recording: true });
    expect(release).not.toHaveBeenCalled();
    c.destroy();
    release.mockRestore();
  });

  test('promotes the same observer and sends one full snapshot followed by increments', async () => {
    vi.useFakeTimers();
    const f = recorderHarness({ promotion: true });
    const c = new ReplayCoordinator({
      sdk: f.sdk,
      client: f.sdk.getClient()!,
      replaysOnErrorSampleRate: 1,
    });
    c.attachRoot(makeRuntime());
    f.emitBeforeSend(error());
    await settle();
    expect(f.controllers).toHaveLength(1);
    expect(f.active()).toBe(1);
    f.controllers[0]!.addBreadcrumb({});
    await c.flush();
    const recordings = f.sendEnvelope.mock.calls.map((call) =>
      JSON.parse((call[0][1][1][1] as string).split('\n')[1]!),
    );
    expect(recordings).toHaveLength(2);
    expect(recordings.flat().filter((event: { type: number }) => event.type === 2)).toHaveLength(1);
    expect(recordings[1].every((event: { type: number }) => event.type === 5)).toBe(true);
    expect(f.sendEnvelope.mock.calls.map((call) => call[0][1][0][1].segment_id)).toEqual([0, 1]);
    c.destroy();
  });

  test('drains a full session buffer synchronously without a checkpoint or observer restart', async () => {
    vi.useFakeTimers();
    const f = recorderHarness();
    const c = new ReplayCoordinator({
      sdk: f.sdk,
      client: f.sdk.getClient()!,
      replaysSessionSampleRate: 1,
    });
    c.attachRoot(makeRuntime());
    f.onBufferFull[0]!();
    expect(f.controllers[0]!.getCapture().events).toHaveLength(0);
    f.controllers[0]!.addBreadcrumb({});
    await c.flush();
    expect(f.controllers).toHaveLength(1);
    expect(f.sendEnvelope.mock.calls.map((call) => call[0][1][0][1].segment_id)).toEqual([0, 1]);
    c.destroy();
  });

  test('rolls an error buffer past five minutes without sending and keeps one recorder', async () => {
    vi.useFakeTimers();
    const f = recorderHarness();
    const c = new ReplayCoordinator({
      sdk: f.sdk,
      client: f.sdk.getClient()!,
      replaysOnErrorSampleRate: 1,
    });
    c.attachRoot(makeRuntime());
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(f.active()).toBe(1);
    expect(f.controllers).toHaveLength(2);
    expect(c.getSnapshot().state).toBe('buffer');
    expect(f.sendEnvelope).not.toHaveBeenCalled();
    f.emitBeforeSend(error());
    await settle();
    expect(f.sendEnvelope).toHaveBeenCalledTimes(1);
    expect(f.active()).toBe(1);
    c.destroy();
    expect(f.active()).toBe(0);
  });

  test.each(['flush', 'duration'] as const)(
    'navigation during pending %s delivery never creates two observers',
    async (kind) => {
      vi.useFakeTimers();
      const f = recorderHarness();
      const c = new ReplayCoordinator({
        sdk: f.sdk,
        client: f.sdk.getClient()!,
        replaysOnErrorSampleRate: 1,
        flushIntervalMs: 600_000,
      });
      c.attachRoot(makeRuntime());
      f.emitBeforeSend(error());
      await settle();
      let finish!: (value: unknown) => void;
      f.sendEnvelope.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const flush = kind === 'flush' ? c.flush() : Promise.resolve();
      if (kind === 'duration') await vi.advanceTimersByTimeAsync(300_000);
      await settle();
      c.detachRoot();
      c.attachRoot(makeRuntime());
      expect(f.active()).toBe(1);
      finish({ statusCode: 200 });
      await flush;
      await settle();
      expect(f.active()).toBe(1);
      c.detachRoot();
      expect(f.active()).toBe(0);
      c.destroy();
    },
  );

  test('drains repeated session segments without stopping recording or changing replay start', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const f = recorderHarness();
    const c = new ReplayCoordinator({
      sdk: f.sdk,
      client: f.sdk.getClient()!,
      replaysSessionSampleRate: 1,
    });
    c.attachRoot(makeRuntime());
    const id = c.getReplayId();
    await c.flush();
    await vi.advanceTimersByTimeAsync(1000);
    f.controllers[0]!.addBreadcrumb({});
    await c.flush();
    expect(f.active()).toBe(1);
    expect(f.controllers).toHaveLength(1);
    const payloads = f.sendEnvelope.mock.calls.map((call) => call[0][1][0][1]);
    expect(payloads.map((payload) => payload.segment_id)).toEqual([0, 1]);
    expect(payloads.map((payload) => payload.replay_id)).toEqual([id, id]);
    expect(payloads.map((payload) => payload.replay_start_timestamp)).toEqual([100, 100]);
    c.destroy();
  });

  test('kill switch and reset invalidate pending delivery without resurrecting recording', async () => {
    vi.useFakeTimers();
    const f = recorderHarness();
    let enabled = true;
    let finish!: (value: unknown) => void;
    f.sendEnvelope.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const c = new ReplayCoordinator({
      sdk: f.sdk,
      client: f.sdk.getClient()!,
      replaysOnErrorSampleRate: 1,
      enabled: () => enabled,
    });
    c.attachRoot(makeRuntime());
    f.emitBeforeSend(error());
    await settle();
    enabled = false;
    c.refreshEnabled();
    finish({ statusCode: 200 });
    await settle();
    expect(c.getSnapshot().state).toBe('disabled');
    expect(f.active()).toBe(0);
    enabled = true;
    c.reset();
    expect(c.getSnapshot().state).toBe('buffer');
    expect(f.active()).toBe(0);
    expect(c.attachRoot(makeRuntime())).toBe(true);
    c.reset();
    expect(f.active()).toBe(0);
    expect(c.getSnapshot().errorEventId).toBeUndefined();
    c.destroy();
  });

  test('missing root recovers, while stopped/destroyed never attach implicitly', async () => {
    const f = recorderHarness();
    const c = new ReplayCoordinator({
      sdk: f.sdk,
      client: f.sdk.getClient()!,
      replaysOnErrorSampleRate: 1,
    });
    expect(c.attachRoot(makeRuntime(null))).toBe(false);
    expect(c.attachRoot(makeRuntime())).toBe(true);
    await c.stop({ flush: false });
    expect(c.attachRoot(makeRuntime())).toBe(false);
    expect(c.start()).toBe(true);
    expect(c.attachRoot(makeRuntime())).toBe(true);
    c.destroy();
    expect(c.start()).toBe(false);
    expect(f.active()).toBe(0);
  });

  test('an oversized initial snapshot cannot create a restart loop or invalid envelope', async () => {
    const f = recorderHarness({ initialLimit: true });
    const c = new ReplayCoordinator({
      sdk: f.sdk,
      client: f.sdk.getClient()!,
      replaysSessionSampleRate: 1,
    });
    expect(c.attachRoot(makeRuntime())).toBe(false);
    await settle();
    expect(f.controllers).toHaveLength(1);
    expect(f.active()).toBe(0);
    expect(f.sendEnvelope).not.toHaveBeenCalled();
    c.destroy();
  });

  test('manual buffer sending is explicit and native errors never link', async () => {
    const f = recorderHarness();
    const c = new ReplayCoordinator({
      sdk: f.sdk,
      client: f.sdk.getClient()!,
      replaysOnErrorSampleRate: 1,
    });
    c.attachRoot(makeRuntime());
    await c.flush();
    expect(f.sendEnvelope).not.toHaveBeenCalled();
    await c.sendBufferedReplay();
    expect(f.sendEnvelope).toHaveBeenCalledTimes(1);
    c.detachRoot();
    const native = error('f');
    f.emitBeforeSend(native);
    expect(native).not.toHaveProperty('contexts.replay');
    c.destroy();
  });

  test('filters error sampling and associates trace ids without inheriting users', async () => {
    const f = recorderHarness();
    const c = new ReplayCoordinator({
      sdk: f.sdk,
      client: f.sdk.getClient()!,
      replaysOnErrorSampleRate: 1,
      beforeErrorSampling: (event) => event.event_id !== 'f'.repeat(32),
    });
    c.attachRoot(makeRuntime());
    const rejected = error('f');
    f.emitBeforeSend(rejected);
    expect(rejected).not.toHaveProperty('contexts.replay');
    f.emitBeforeSend({
      ...error(),
      contexts: { trace: { trace_id: '1'.repeat(32), span_id: '2'.repeat(16) } },
    });
    await settle();
    expect(f.sendEnvelope.mock.calls[0]![0][1][0][1].trace_ids).toEqual(['1'.repeat(32)]);
    c.destroy();
  });

  test('integration cleanup and repeated setup release old coordinator resources', () => {
    const f = recorderHarness();
    const integration = taroReplayIntegration({ sdk: f.sdk, replaysSessionSampleRate: 1 });
    const client = { ...f.sdk.getClient()!, getOptions: () => ({}) };
    integration.setup?.(client as any);
    integration.bridge.attachRoot(makeRuntime());
    expect(f.active()).toBe(1);
    integration.setup?.(client as any);
    expect(f.active()).toBe(0);
    integration.bridge.attachRoot(makeRuntime());
    integration.cleanup();
    expect(f.active()).toBe(0);
  });
  test('low error sampling retains the buffer after a miss and samples a later error', async () => {
    const f = recorderHarness();
    const random = vi.fn(() => 0.5);
    const c = new ReplayCoordinator({
      sdk: f.sdk,
      client: f.sdk.getClient()!,
      replaysSessionSampleRate: 0.1,
      replaysOnErrorSampleRate: 0.2,
      random,
    });
    expect(c.getSnapshot().state).toBe('buffer');
    expect(random).toHaveBeenCalledTimes(33);
    c.attachRoot(makeRuntime());
    const missed = error('f');
    f.emitBeforeSend(missed);
    expect(missed).not.toHaveProperty('contexts.replay');
    expect(c.getSnapshot().state).toBe('buffer');
    expect(f.sendEnvelope).not.toHaveBeenCalled();
    random.mockReturnValue(0.1);
    const accepted = error();
    f.emitBeforeSend(accepted);
    await settle();
    expect(accepted).toHaveProperty('contexts.replay.replay_id', c.getReplayId());
    expect(f.sendEnvelope).toHaveBeenCalledTimes(1);
    c.detachRoot();
    c.attachRoot(makeRuntime());
    expect(random).toHaveBeenCalledTimes(35);
    c.destroy();
  });

  test('manual buffer does not auto-promote with error sampling zero but explicit sending does', async () => {
    const f = recorderHarness();
    const c = new ReplayCoordinator({
      sdk: f.sdk,
      client: f.sdk.getClient()!,
      replaysOnErrorSampleRate: 0,
    });
    expect(c.startBuffering()).toBe(true);
    c.attachRoot(makeRuntime());
    const ignored = error();
    f.emitBeforeSend(ignored);
    expect(ignored).not.toHaveProperty('contexts.replay');
    await c.sendBufferedReplay();
    expect(f.sendEnvelope).toHaveBeenCalledTimes(1);
    c.destroy();
  });

  test('non-finite recorder and flush limits preserve bounded defaults', async () => {
    vi.useFakeTimers();
    const f = makeSdk();
    const c = new ReplayCoordinator({
      sdk: f.sdk,
      client: f.sdk.getClient()!,
      replaysSessionSampleRate: 1,
      flushIntervalMs: NaN,
      limits: { maxBytes: Infinity, maxEvents: NaN, maxDurationMs: Infinity, rollingWindowMs: NaN },
    });
    c.attachRoot(makeRuntime());
    expect(f.getStartOptions()).toMatchObject({
      maxBytes: 512 * 1024,
      maxEvents: 500,
      maxDurationMs: 300_000,
    });
    await vi.advanceTimersByTimeAsync(4999);
    expect(f.sendEnvelope).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.sendEnvelope).toHaveBeenCalledTimes(1);
    c.destroy();
  });
});
