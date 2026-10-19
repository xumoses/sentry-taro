import { afterEach, describe, expect, test, vi } from 'vite-plus/test';
import { startTaroReplayRecorder } from '../../src/replay/recorder/recorder';
import {
  taroReplayIntegration,
  type TaroReplayIntegrationOptions,
} from '../../src/replay/coordinator/integration';
import type { TaroReplayNodeLike, StartTaroReplayRecorderOptions } from '../../src/replay/types';
import { makeRuntime, makeSdk } from './fixtures';

const cleanups: Array<() => void> = [];
const MINUTE = 60_000;
const settle = async () => {
  for (let index = 0; index < 20; index++) await Promise.resolve();
};
const error = () => ({
  event_id: 'e'.repeat(32),
  exception: { values: [{ type: 'Error', value: 'synthetic' }] },
});

function fixture(
  options: Omit<TaroReplayIntegrationOptions, 'sdk'> = {},
  useDefaultMinimum = false,
) {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  const f = makeSdk();
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const root: TaroReplayNodeLike = {
    nodeType: 1,
    nodeName: 'view',
    childNodes: [],
    attributes: [],
    addEventListener(name: string, listener: (event: unknown) => void) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(listener);
    },
    removeEventListener(name: string, listener: (event: unknown) => void) {
      listeners.get(name)?.delete(listener);
    },
  };
  const runtime = makeRuntime(root);
  let activeObservers = 0;
  runtime.MutationObserver = class {
    #active = false;
    observe() {
      if (!this.#active) activeObservers++;
      this.#active = true;
    }
    disconnect() {
      if (this.#active) activeObservers--;
      this.#active = false;
    }
  };
  const starts: StartTaroReplayRecorderOptions[] = [];
  f.sdk.startTaroReplayRecorder = (recordingOptions) => {
    starts.push(recordingOptions);
    return startTaroReplayRecorder(recordingOptions);
  };
  const integration = taroReplayIntegration({
    sdk: f.sdk,
    ...(useDefaultMinimum ? {} : { minReplayDuration: 0 }),
    ...options,
  });
  integration.setup?.(f.sdk.getClient() as never);
  cleanups.push(() => integration.cleanup());
  return {
    ...f,
    integration,
    runtime,
    starts,
    active: () => activeObservers,
    attach: () => integration.bridge.attachRoot(runtime),
    activity(
      name = 'tap',
      event: unknown = { target: root, changedTouches: [{ clientX: 1, clientY: 1 }] },
    ) {
      for (const listener of [...(listeners.get(name) || [])]) listener(event);
    },
  };
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

describe('minimum replay duration before the first send', () => {
  test('a short session flush retains data and resolves before the default 4999 ms send', async () => {
    const f = fixture({ replaysSessionSampleRate: 1 }, true);
    f.attach();
    const id = f.integration.getReplayId();
    await f.integration.flush();
    expect(f.sendEnvelope).not.toHaveBeenCalled();
    expect(f.integration.bridge.getSnapshot().delivery?.pendingSegments).toBe(1);
    await vi.advanceTimersByTimeAsync(4998);
    expect(f.sendEnvelope).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.sendEnvelope).toHaveBeenCalledTimes(1);
    expect(f.sendEnvelope.mock.calls[0]![0][1][0][1]).toMatchObject({
      replay_id: id,
      segment_id: 0,
      replay_type: 'session',
      timestamp: Date.now() / 1000,
    });
    f.emitBreadcrumb({ category: 'synthetic.followup', message: 'after minimum' });
    await f.integration.flush();
    expect(f.sendEnvelope).toHaveBeenCalledTimes(2);
    expect(f.sendEnvelope.mock.calls[1]![0][1][0][1].segment_id).toBe(1);
  });

  test('a short error buffer promotes immediately and preserves association until sending', async () => {
    const f = fixture({ replaysOnErrorSampleRate: 1 }, true);
    f.attach();
    const id = f.integration.getReplayId();
    const event = error();
    f.emitBeforeSend(event);
    expect(f.integration.getRecordingMode()).toBe('session');
    expect(f.active()).toBe(1);
    expect(event).toMatchObject({ contexts: { replay: { replay_id: id } } });
    expect(f.sendEnvelope).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4999);
    expect(f.sendEnvelope).toHaveBeenCalledTimes(1);
    expect(f.sendEnvelope.mock.calls[0]![0][1][0][1]).toMatchObject({
      replay_id: id,
      replay_type: 'buffer',
      error_ids: [event.event_id],
      segment_id: 0,
    });
  });

  test('continueRecording false retains a short buffer until its scheduled send', async () => {
    const f = fixture({ replaysOnErrorSampleRate: 1 }, true);
    f.attach();
    const id = f.integration.getReplayId();
    await f.integration.flush({ continueRecording: false });
    expect(f.active()).toBe(0);
    expect(f.integration.getRecordingMode()).toBe('buffer');
    expect(f.sendEnvelope).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4999);
    expect(f.sendEnvelope).toHaveBeenCalledTimes(1);
    expect(f.integration.getReplayId()).toBe(id);
    f.activity();
    expect(f.attach()).toBe(false);
    expect(f.active()).toBe(0);
  });

  test.each(['session', 'buffer'] as const)(
    'explicit stop discards a short %s recording even when flush is requested',
    async (mode) => {
      const f = fixture(
        mode === 'session' ? { replaysSessionSampleRate: 1 } : { replaysOnErrorSampleRate: 1 },
        true,
      );
      f.attach();
      if (mode === 'session') await f.integration.flush();
      await vi.advanceTimersByTimeAsync(4998);
      await f.integration.stop({ flush: true });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(f.sendEnvelope).not.toHaveBeenCalled();
      expect(f.integration.bridge.getSnapshot().delivery?.pendingSegments).toBe(0);
      expect(f.integration.getReplayId()).toBeUndefined();
      expect(f.active()).toBe(0);
    },
  );

  test('hide preserves a short session until replay age reaches the minimum without restarting its root', async () => {
    const f = fixture({ replaysSessionSampleRate: 1 }, true);
    f.attach();
    const id = f.integration.getReplayId();
    await vi.advanceTimersByTimeAsync(1000);
    f.integration.bridge.detachRoot();
    expect(f.active()).toBe(0);
    expect(f.sendEnvelope).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3998);
    expect(f.sendEnvelope).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.sendEnvelope).toHaveBeenCalledTimes(1);
    expect(f.sendEnvelope.mock.calls[0]![0][1][0][1]).toMatchObject({
      replay_id: id,
      timestamp: Date.now() / 1000,
    });
    expect(f.active()).toBe(0);
    expect(f.starts).toHaveLength(1);
    expect(f.attach()).toBe(true);
    expect(f.integration.getReplayId()).toBe(id);
  });

  test('reset clears the scheduled first send and does not send an abandoned replay', async () => {
    const f = fixture({ replaysSessionSampleRate: 1 }, true);
    f.attach();
    await f.integration.flush();
    const oldId = f.integration.getReplayId();
    f.integration.bridge.reset?.();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.sendEnvelope).not.toHaveBeenCalled();
    expect(f.integration.getReplayId()).not.toBe(oldId);
    expect(f.active()).toBe(0);
  });

  test('queued data before the minimum shares the bounded delivery capacity', async () => {
    const f = fixture(
      {
        replaysSessionSampleRate: 1,
        delivery: { maxPendingSegments: 1 },
        limits: { maxEvents: 2 },
      },
      true,
    );
    f.attach();
    await f.integration.flush();
    for (let index = 0; index < 3; index++)
      f.emitBreadcrumb({ category: 'synthetic.followup', message: 'bounded pending data' });
    expect(f.integration.bridge.getSnapshot()).toMatchObject({
      state: 'error',
      recording: false,
      delivery: { pendingSegments: 0, pendingBytes: 0 },
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.sendEnvelope).not.toHaveBeenCalled();
  });

  test('a promoted recording cannot restart after its initial pending data exceeds the byte limit', async () => {
    const f = fixture({ replaysOnErrorSampleRate: 1, delivery: { maxPendingBytes: 1 } }, true);
    f.attach();
    f.emitBeforeSend(error());
    expect(f.integration.bridge.getSnapshot()).toMatchObject({ state: 'error', recording: false });
    expect(f.active()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.sendEnvelope).not.toHaveBeenCalled();
  });

  test('the 50-second minimum collects periodic activity without consuming a segment per flush interval', async () => {
    const f = fixture({ replaysSessionSampleRate: 1, minReplayDuration: 50_000 });
    f.attach();
    await f.integration.flush();
    for (let index = 0; index < 9; index++) {
      await vi.advanceTimersByTimeAsync(5000);
      f.emitBreadcrumb({ category: 'synthetic.followup', message: `activity-${index}` });
      expect(f.integration.bridge.getSnapshot()).toMatchObject({
        state: 'session',
        recording: true,
      });
      expect(f.integration.bridge.getSnapshot().delivery?.pendingSegments).toBe(1);
    }
    expect(f.sendEnvelope).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.sendEnvelope.mock.calls.map((call) => call[0][1][0][1].segment_id)).toEqual([0, 1]);
    const recordings = f.sendEnvelope.mock.calls.map((call) =>
      JSON.parse(call[0][1][1][1].split('\n')[1]),
    );
    expect(
      recordings
        .flat()
        .filter(
          (event: { data?: { payload?: { category?: string } } }) =>
            event.data?.payload?.category === 'synthetic.followup',
        )
        .map((event: { data: { payload: { message: string } } }) => event.data.payload.message),
    ).toEqual(Array(9).fill('[Filtered]'));
    expect(f.active()).toBe(1);
  });

  test('a hidden replay expiring before the minimum drops its pending data without restarting a root', async () => {
    const f = fixture({ replaysSessionSampleRate: 1, maxReplayDuration: 2000 }, true);
    f.attach();
    const id = f.integration.getReplayId();
    await vi.advanceTimersByTimeAsync(1000);
    f.integration.bridge.detachRoot();
    await vi.advanceTimersByTimeAsync(3999);
    expect(f.sendEnvelope).not.toHaveBeenCalled();
    expect(f.integration.bridge.getSnapshot().delivery?.pendingSegments).toBe(0);
    expect(f.integration.getReplayId()).not.toBe(id);
    expect(f.active()).toBe(0);
    expect(f.starts).toHaveLength(1);
  });

  test('the initial send timer respects an inactivity pause until the user resumes', async () => {
    const f = fixture({ replaysSessionSampleRate: 1, sessionIdlePauseMs: 1000 }, true);
    f.attach();
    await f.integration.flush();
    await vi.advanceTimersByTimeAsync(4999);
    expect(f.sendEnvelope).not.toHaveBeenCalled();
    expect(f.active()).toBe(0);
    f.activity();
    await f.integration.flush();
    expect(f.sendEnvelope).toHaveBeenCalledTimes(2);
    expect(f.active()).toBe(1);
  });

  test('an unsent stopped buffer is not uploaded when its minimum exceeds the maximum duration grace', async () => {
    const f = fixture({
      replaysOnErrorSampleRate: 1,
      maxReplayDuration: 1000,
      minReplayDuration: 10_000,
    });
    const pending: number[] = [];
    f.integration.bridge.subscribe((snapshot) =>
      pending.push(snapshot.delivery?.pendingSegments ?? 0),
    );
    f.attach();
    await f.integration.flush({ continueRecording: false });
    expect(pending[pending.length - 1]).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pending[pending.length - 1]).toBe(0);
    expect(f.sendEnvelope).not.toHaveBeenCalled();
    expect(f.integration.bridge.getSnapshot().delivery?.pendingSegments).toBe(0);
    expect(f.active()).toBe(0);
  });

  test.each([
    [NaN, 4999],
    [Infinity, 4999],
    [100_000, 50_000],
    [0, 0],
  ])('normalizes minimum %s to %s ms', async (minimum, expected) => {
    const f = fixture({ replaysSessionSampleRate: 1, minReplayDuration: minimum });
    f.attach();
    await f.integration.flush();
    if (expected > 0) {
      expect(f.sendEnvelope).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(expected - 1);
      expect(f.sendEnvelope).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(f.sendEnvelope).toHaveBeenCalledTimes(1);
  });
});

describe('official Replay controls and independent session clocks', () => {
  test.each(['flush', 'stop'] as const)(
    'public %s reports delivery failure without rejecting the host call',
    async (control) => {
      const onError = vi.fn();
      const f = fixture({ replaysSessionSampleRate: 1, onError });
      f.sendEnvelope.mockResolvedValue({ statusCode: 400 });
      f.attach();
      await expect(f.integration[control]()).resolves.toBeUndefined();
      await settle();
      expect(onError).toHaveBeenCalledTimes(1);
      expect(f.active()).toBe(0);
      expect(f.integration.getRecordingMode()).toBeUndefined();
    },
  );
  test('uses a 60-second error window and a 60-minute recorder limit by default', () => {
    const f = fixture({ replaysOnErrorSampleRate: 1 });
    expect(f.attach()).toBe(true);
    expect(f.starts[0]).toMatchObject({ rollingWindowMs: MINUTE, maxDurationMs: 60 * MINUTE });
    expect(f.integration.name).toBe('Replay');
    expect(f.integration.getRecordingMode()).toBe('buffer');
    expect(f.integration.getReplayId(true)).toBe(f.integration.getReplayId());
  });

  test('pauses at five idle minutes and resumes on a payload-free activity listener with the same identity', async () => {
    const f = fixture({ replaysSessionSampleRate: 1 });
    f.attach();
    const id = f.integration.getReplayId();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(f.active()).toBe(0);
    expect(f.integration.bridge.getSnapshot()).toMatchObject({
      paused: true,
      state: 'session',
      recording: false,
    });
    expect(f.integration.getReplayId()).toBe(id);
    await vi.advanceTimersByTimeAsync(MINUTE);
    const readPayload = vi.fn(() => {
      throw new Error('must not read user input');
    });
    f.activity('input', Object.defineProperty({}, 'detail', { get: readPayload }));
    expect(readPayload).not.toHaveBeenCalled();
    expect(f.active()).toBe(1);
    expect(f.integration.getReplayId()).toBe(id);
    expect(f.starts).toHaveLength(2);
    expect(f.integration.bridge.getSnapshot().paused).toBe(false);
  });

  test('expires a paused session after fifteen idle minutes only when activity returns', async () => {
    const f = fixture({ replaysSessionSampleRate: 1 });
    f.attach();
    const id = f.integration.getReplayId();
    await vi.advanceTimersByTimeAsync(16 * MINUTE);
    expect(f.active()).toBe(0);
    expect(f.integration.getReplayId()).toBe(id);
    f.activity();
    expect(f.active()).toBe(1);
    expect(f.integration.getReplayId()).not.toBe(id);
    await f.integration.flush();
    expect(f.sendEnvelope.mock.calls.at(-1)![0][1][0][1].segment_id).toBe(0);
  });

  test('user interaction keeps recording active but cannot extend the 60-minute replay lifetime', async () => {
    const f = fixture({ replaysSessionSampleRate: 1 });
    f.attach();
    const id = f.integration.getReplayId();
    for (let index = 0; index < 14; index++) {
      await vi.advanceTimersByTimeAsync(4 * MINUTE);
      f.activity();
      expect(f.integration.getReplayId()).toBe(id);
    }
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    expect(f.active()).toBe(1);
    expect(f.integration.getReplayId()).not.toBe(id);
    expect(f.starts).toHaveLength(2);
  });

  test('an unsent buffer survives idle expiry and recorder rollover without changing identity or uploading', async () => {
    const f = fixture({ replaysOnErrorSampleRate: 1 });
    f.attach();
    const id = f.integration.getReplayId();
    await vi.advanceTimersByTimeAsync(70 * MINUTE);
    expect(f.active()).toBe(1);
    expect(f.integration.getReplayId()).toBe(id);
    expect(f.integration.getRecordingMode()).toBe('buffer');
    expect(f.sendEnvelope).not.toHaveBeenCalled();
    await f.integration.flush();
    expect(f.integration.getRecordingMode()).toBe('session');
    expect(f.active()).toBe(1);
    const payload = f.sendEnvelope.mock.calls[0]![0][1][0][1];
    expect(payload.replay_start_timestamp).toBeGreaterThanOrEqual((Date.now() - MINUTE - 1) / 1000);
  });

  test('an error-promoted session skips five-minute idle pause and expires after fifteen minutes', async () => {
    const f = fixture({ replaysOnErrorSampleRate: 1 });
    f.attach();
    const id = f.integration.getReplayId();
    f.emitBeforeSend(error());
    await settle();
    await vi.advanceTimersByTimeAsync(6 * MINUTE);
    expect(f.active()).toBe(1);
    expect(f.integration.getReplayId()).toBe(id);
    expect(f.integration.getRecordingMode()).toBe('session');
    await vi.advanceTimersByTimeAsync(9 * MINUTE);
    expect(f.active()).toBe(1);
    expect(f.integration.getReplayId()).not.toBe(id);
    expect(f.integration.getRecordingMode()).toBe('buffer');
  });

  test('a visible root can start manually with zero sampling and never restarts implicitly after stop', async () => {
    const f = fixture();
    expect(f.attach()).toBe(false);
    expect(f.active()).toBe(0);
    expect(f.integration.start()).toBeUndefined();
    expect(f.active()).toBe(1);
    const id = f.integration.getReplayId();
    await f.integration.stop({ flush: false });
    expect(f.integration.getRecordingMode()).toBeUndefined();
    expect(f.integration.getReplayId()).toBeUndefined();
    f.activity();
    expect(f.attach()).toBe(false);
    await vi.advanceTimersByTimeAsync(16 * MINUTE);
    expect(f.active()).toBe(0);
    expect(f.sendEnvelope).not.toHaveBeenCalled();
    f.integration.startBuffering();
    expect(f.active()).toBe(1);
    expect(f.integration.getRecordingMode()).toBe('buffer');
    expect(f.integration.getReplayId()).not.toBe(id);
  });

  test('ordinary bridge flush retains a buffer while integration flush sends and promotes it once', async () => {
    const f = fixture({ replaysOnErrorSampleRate: 1 });
    f.attach();
    const id = f.integration.getReplayId();
    await f.integration.bridge.flush();
    expect(f.sendEnvelope).not.toHaveBeenCalled();
    await Promise.all([f.integration.flush(), f.integration.flush()]);
    const replayPayloads = f.sendEnvelope.mock.calls.map((call) => call[0][1][0][1]);
    expect(replayPayloads.filter((payload) => payload.replay_type === 'buffer')).toHaveLength(1);
    expect(replayPayloads.every((payload) => payload.replay_id === id)).toBe(true);
    expect(f.integration.getRecordingMode()).toBe('session');
    expect(f.active()).toBe(1);
  });

  test('flush continueRecording false sends a buffer then keeps recording stopped across activity and root attach', async () => {
    const f = fixture({ replaysOnErrorSampleRate: 1 });
    f.attach();
    const id = f.integration.getReplayId();
    await f.integration.flush({ continueRecording: false });
    expect(f.sendEnvelope).toHaveBeenCalledTimes(1);
    expect(f.active()).toBe(0);
    expect(f.integration.getRecordingMode()).toBe('buffer');
    expect(f.integration.getReplayId()).toBe(id);
    f.activity();
    expect(f.attach()).toBe(false);
    expect(f.active()).toBe(0);
    f.emitBeforeSend(error());
    await f.integration.flush();
    expect(f.sendEnvelope).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(16 * MINUTE);
    f.activity();
    expect(f.active()).toBe(1);
    expect(f.integration.getReplayId()).not.toBe(id);
    await f.integration.stop();
    f.integration.start();
    expect(f.active()).toBe(1);
    expect(f.integration.getReplayId()).not.toBe(id);
  });

  test.each([undefined, false, true])(
    'buffer stop with flush=%s sends only on explicit true',
    async (flush) => {
      const f = fixture({ replaysOnErrorSampleRate: 1 });
      f.attach();
      await f.integration.stop(flush === undefined ? undefined : { flush });
      expect(f.sendEnvelope).toHaveBeenCalledTimes(flush === true ? 1 : 0);
      expect(f.active()).toBe(0);
      expect(f.integration.getReplayId()).toBeUndefined();
    },
  );

  test('explicit integration flush starts a stopped replay; start and startBuffering do not change an active mode', async () => {
    const f = fixture();
    f.attach();
    await f.integration.flush();
    expect(f.active()).toBe(1);
    const id = f.integration.getReplayId();
    f.integration.startBuffering();
    f.integration.start();
    expect(f.integration.getRecordingMode()).toBe('session');
    expect(f.integration.getReplayId()).toBe(id);
  });

  test('navigation preserves the duration deadline and detached roots cannot wake recording', async () => {
    const f = fixture({ replaysSessionSampleRate: 1, maxReplayDuration: 10_000 });
    f.attach();
    const id = f.integration.getReplayId();
    await vi.advanceTimersByTimeAsync(8000);
    f.integration.bridge.detachRoot();
    f.activity();
    expect(f.active()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    f.attach();
    expect(f.starts.at(-1)?.maxDurationMs).toBe(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.integration.getReplayId()).not.toBe(id);
    expect(f.active()).toBe(1);
  });

  test('passes top-level official privacy options to the recorder', () => {
    const f = fixture({
      replaysOnErrorSampleRate: 1,
      maskAttributes: ['title'],
      maskAllText: false,
      maskAllInputs: false,
      blockAllMedia: true,
    });
    f.attach();
    expect(f.starts[0]).toMatchObject({
      maskAllText: false,
      maskAllInputs: false,
      blockAllMedia: true,
      maskAttributes: ['title'],
    });
  });

  test('ignores the removed privacy object', () => {
    const f = fixture({
      replaysOnErrorSampleRate: 1,
      ...({ privacy: { maskAllText: false, allowUser: true } } as object),
    });
    f.attach();
    expect(f.starts[0]).toMatchObject({ maskAllText: true });
  });

  test('public controls before client setup do not allocate a recording', async () => {
    const integration = taroReplayIntegration({ sdk: makeSdk().sdk });
    integration.start();
    integration.startBuffering();
    await integration.flush();
    await integration.stop();
    expect(integration.getReplayId()).toBeUndefined();
    expect(integration.getRecordingMode()).toBeUndefined();
    integration.cleanup();
  });
});
