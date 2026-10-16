import type { Event } from '@sentry/core';
import { describe, expect, test, vi } from 'vite-plus/test';

import { ReplayCoordinator } from '../../src/replay/coordinator/ReplayCoordinator';
import { makeCapture, makeRuntime, makeSdk } from './fixtures';

describe('ReplayCoordinator', () => {
  test('a missed session sample still buffers when error sampling is enabled', () => {
    const fixture = makeSdk();
    const random = vi.fn(() => 0.5);
    const coordinator = new ReplayCoordinator({
      minReplayDuration: 0,
      sdk: fixture.sdk,
      client: fixture.sdk.getClient()!,
      replaysSessionSampleRate: 0.5,
      replaysOnErrorSampleRate: 0.5,
      random,
    });

    expect(coordinator.getSnapshot().state).toBe('buffer');
    expect(random).toHaveBeenCalledTimes(33);
    coordinator.destroy();
  });

  test('makes one stable prioritized sampling decision', () => {
    const fixture = makeSdk();
    const random = vi.fn().mockReturnValueOnce(0.9).mockReturnValueOnce(0.2).mockReturnValue(0.1);
    const coordinator = new ReplayCoordinator({
      minReplayDuration: 0,
      sdk: fixture.sdk,
      client: fixture.sdk.getClient()!,
      replaysSessionSampleRate: 0.5,
      replaysOnErrorSampleRate: 0.5,
      random,
    });

    expect(coordinator.getSnapshot().state).toBe('buffer');
    coordinator.attachRoot(makeRuntime());
    coordinator.detachRoot();
    coordinator.attachRoot(makeRuntime());
    expect(random).toHaveBeenCalledTimes(33);
    expect(coordinator.getSnapshot().replayId).toMatch(/^[0-9a-f]{32}$/);
  });

  test('disabled mode creates no observer, hook, or upload', () => {
    const fixture = makeSdk();
    const runtime = makeRuntime();
    const coordinator = new ReplayCoordinator({
      minReplayDuration: 0,
      sdk: fixture.sdk,
      client: fixture.sdk.getClient()!,
      enabled: false,
      replaysSessionSampleRate: 1,
    });

    expect(coordinator.attachRoot(runtime)).toBe(false);
    expect(runtime.document.getElementById).not.toHaveBeenCalled();
    expect(fixture.sendEnvelope).not.toHaveBeenCalled();
  });

  test('buffer never uploads without an accepted error', async () => {
    const fixture = makeSdk();
    const coordinator = new ReplayCoordinator({
      minReplayDuration: 0,
      sdk: fixture.sdk,
      client: fixture.sdk.getClient()!,
      replaysOnErrorSampleRate: 1,
      random: () => 0.5,
    });
    coordinator.attachRoot(makeRuntime());
    coordinator.detachRoot();
    await coordinator.flush();

    expect(coordinator.getSnapshot().state).toBe('buffer');
    expect(fixture.sendEnvelope).not.toHaveBeenCalled();
  });

  test('full-session root switches send ordered segments with one replay id', async () => {
    const fixture = makeSdk();
    const coordinator = new ReplayCoordinator({
      minReplayDuration: 0,
      sdk: fixture.sdk,
      client: fixture.sdk.getClient()!,
      replaysSessionSampleRate: 1,
      random: () => 0.25,
    });
    coordinator.attachRoot(makeRuntime());
    const replayId = coordinator.getSnapshot().replayId;
    coordinator.detachRoot();
    await vi.waitFor(() => expect(fixture.sendEnvelope).toHaveBeenCalledTimes(1));
    coordinator.attachRoot(makeRuntime());
    coordinator.detachRoot();
    await vi.waitFor(() => expect(fixture.sendEnvelope).toHaveBeenCalledTimes(2));

    const first = fixture.sendEnvelope.mock.calls[0]![0] as any;
    const second = fixture.sendEnvelope.mock.calls[1]![0] as any;
    expect(first[1][0][1]).toMatchObject({ replay_id: replayId, segment_id: 0 });
    expect(second[1][0][1]).toMatchObject({ replay_id: replayId, segment_id: 1 });
    expect(coordinator.getSnapshot()).toMatchObject({
      state: 'session',
      replayId,
      sentReplayId: replayId,
    });
  });

  test('accepted exceptions share one replay and continue in ordered segments', async () => {
    const fixture = makeSdk();
    const coordinator = new ReplayCoordinator({
      minReplayDuration: 0,
      sdk: fixture.sdk,
      client: fixture.sdk.getClient()!,
      replaysOnErrorSampleRate: 1,
      random: () => 0.25,
      now: () => 1_700_000_002_000,
    });
    coordinator.attachRoot(makeRuntime());
    const first: Event = {
      event_id: 'e'.repeat(32),
      exception: { values: [{ type: 'Error', value: 'boom' }] },
    };
    const second: Event = {
      event_id: 'f'.repeat(32),
      exception: { values: [{ type: 'Error', value: 'again' }] },
    };

    fixture.emitBeforeSend(first);
    await vi.waitFor(() => expect(coordinator.getSnapshot().state).toBe('session'));
    expect(fixture.getStartOptions()).toMatchObject({
      maxDurationMs: 60 * 60_000 - 2000,
      maxEvents: 500,
      maxBytes: 512 * 1024,
    });
    expect(fixture.getStartOptions().rollingWindowMs).toBeUndefined();

    expect(first.contexts?.replay).toEqual({
      replay_id: coordinator.getSnapshot().replayId,
    });
    expect(fixture.sendEnvelope).toHaveBeenCalledTimes(1);
    const firstEnvelope = fixture.sendEnvelope.mock.calls[0]![0] as any;
    expect(firstEnvelope[1][0][1]).toMatchObject({
      replay_id: coordinator.getSnapshot().replayId,
      segment_id: 0,
      replay_type: 'buffer',
      error_ids: ['e'.repeat(32)],
    });

    fixture.emitBeforeSend(second);
    expect(second.contexts?.replay).toEqual({
      replay_id: coordinator.getSnapshot().replayId,
    });
    coordinator.detachRoot();
    await vi.waitFor(() => expect(fixture.sendEnvelope).toHaveBeenCalledTimes(2));

    const secondEnvelope = fixture.sendEnvelope.mock.calls[1]![0] as any;
    expect(secondEnvelope[1][0][1]).toMatchObject({
      replay_id: coordinator.getSnapshot().replayId,
      segment_id: 1,
      replay_type: 'session',
      error_ids: ['f'.repeat(32)],
    });
    expect(coordinator.getSnapshot()).toMatchObject({
      sentReplayId: coordinator.getSnapshot().replayId,
      errorEventId: 'f'.repeat(32),
      state: 'session',
    });
  });

  test('starts a fresh error buffer after the promoted session reaches its limit', async () => {
    const fixture = makeSdk();
    let randomCalls = 0;
    const coordinator = new ReplayCoordinator({
      minReplayDuration: 0,
      sdk: fixture.sdk,
      client: fixture.sdk.getClient()!,
      replaysOnErrorSampleRate: 1,
      random: () => (randomCalls++ < 32 ? 0.25 : 0.5),
    });
    coordinator.attachRoot(makeRuntime());
    fixture.emitBeforeSend({
      event_id: 'e'.repeat(32),
      exception: { values: [{ type: 'Error', value: 'boom' }] },
    });
    await vi.waitFor(() => expect(coordinator.getSnapshot().state).toBe('session'));
    const firstReplayId = coordinator.getSnapshot().replayId;
    if (!firstReplayId) throw new Error('expected a replay id');

    fixture
      .getStartOptions()
      .onStop?.(makeCapture({ replayId: firstReplayId, stopReason: 'duration' }));
    await vi.waitFor(() => expect(coordinator.getSnapshot().state).toBe('buffer'));

    expect(coordinator.getSnapshot().replayId).not.toBe(firstReplayId);
    expect(coordinator.getSnapshot().eventCount).toBeGreaterThan(0);
  });

  test('non-error events cannot promote the buffer', () => {
    const fixture = makeSdk();
    const coordinator = new ReplayCoordinator({
      minReplayDuration: 0,
      sdk: fixture.sdk,
      client: fixture.sdk.getClient()!,
      replaysOnErrorSampleRate: 1,
      random: () => 0.5,
    });
    coordinator.attachRoot(makeRuntime());
    fixture.emitBeforeSend({ event_id: 'a'.repeat(32), message: 'info' });

    expect(coordinator.getSnapshot().state).toBe('buffer');
    expect(fixture.sendEnvelope).not.toHaveBeenCalled();
  });

  test('native-only errors remain unassociated when no Taro root was recorded', () => {
    const fixture = makeSdk();
    const coordinator = new ReplayCoordinator({
      minReplayDuration: 0,
      sdk: fixture.sdk,
      client: fixture.sdk.getClient()!,
      replaysOnErrorSampleRate: 1,
      random: () => 0.5,
    });
    const event: Event = {
      event_id: 'a'.repeat(32),
      exception: { values: [{ type: 'Error', value: 'native page' }] },
    };

    fixture.emitBeforeSend(event);

    expect(event.contexts?.replay).toBeUndefined();
    expect(coordinator.getSnapshot().state).toBe('buffer');
    expect(fixture.sendEnvelope).not.toHaveBeenCalled();
  });

  test('errors while a Taro root is detached do not promote its retained buffer', () => {
    const fixture = makeSdk();
    const coordinator = new ReplayCoordinator({
      minReplayDuration: 0,
      sdk: fixture.sdk,
      client: fixture.sdk.getClient()!,
      replaysOnErrorSampleRate: 1,
      random: () => 0.5,
    });
    coordinator.attachRoot(makeRuntime());
    coordinator.detachRoot();
    const event: Event = {
      event_id: 'a'.repeat(32),
      exception: { values: [{ type: 'Error', value: 'native page' }] },
    };

    fixture.emitBeforeSend(event);

    expect(event.contexts?.replay).toBeUndefined();
    expect(coordinator.getSnapshot().state).toBe('buffer');
    expect(coordinator.getSnapshot().eventCount).toBeGreaterThan(0);
    expect(fixture.sendEnvelope).not.toHaveBeenCalled();
  });

  test('does not notify React subscribers for each recorded event', () => {
    const fixture = makeSdk();
    const coordinator = new ReplayCoordinator({
      minReplayDuration: 0,
      sdk: fixture.sdk,
      client: fixture.sdk.getClient()!,
      replaysOnErrorSampleRate: 1,
      random: () => 0.5,
    });
    const snapshots: Array<{ eventCount: number; approximateBytes: number }> = [];
    coordinator.subscribe((snapshot) => snapshots.push(snapshot));
    coordinator.attachRoot(makeRuntime());
    const notificationsAfterAttach = snapshots.length;
    fixture.emitBreadcrumb({ category: 'ui', message: 'mutation' });

    expect(snapshots).toHaveLength(notificationsAfterAttach);
    expect(coordinator.getSnapshot()).toMatchObject({
      eventCount: 4,
      approximateBytes: expect.any(Number),
    });
  });

  test('compacts detached roots continuously and runtime kill switch tears down', () => {
    const fixture = makeSdk();
    let enabled = true;
    const coordinator = new ReplayCoordinator({
      minReplayDuration: 0,
      sdk: fixture.sdk,
      client: fixture.sdk.getClient()!,
      enabled: () => enabled,
      replaysOnErrorSampleRate: 1,
      random: () => 0.5,
    });
    coordinator.attachRoot(makeRuntime());
    coordinator.detachRoot();
    coordinator.attachRoot(makeRuntime());
    coordinator.detachRoot();
    expect(coordinator.getSnapshot().eventCount).toBe(2);

    enabled = false;
    expect(coordinator.refreshEnabled()).toBe(false);
    expect(coordinator.getSnapshot()).toMatchObject({
      state: 'disabled',
      eventCount: 0,
      approximateBytes: 0,
    });
    expect(coordinator.attachRoot(makeRuntime())).toBe(false);
  });
});
