import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  startTaroDomReplayPoc,
  type TaroDomReplayPocController,
} from '../../src/replay/recorder/recorder';

const recordings: TaroDomReplayPocController[] = [];
const root = { nodeType: 1, nodeName: 'view', childNodes: [], attributes: [] };
class Observer {
  observe() {}
  disconnect() {}
}

afterEach(() => {
  for (const controller of recordings.splice(0)) controller.stop();
  vi.useRealTimers();
});

describe('recorder policy used by the Replay adapter', () => {
  it('keeps a default recording alive beyond the former POC window and stops at one hour', () => {
    vi.useFakeTimers();
    const onStop = vi.fn();
    const controller = startTaroDomReplayPoc({ root, MutationObserver: Observer, onStop });
    recordings.push(controller);

    vi.advanceTimersByTime(60 * 60_000 - 1);
    expect(controller.getCapture().stopReason).toBeNull();
    expect(onStop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(controller.getCapture().stopReason).toBe('duration');
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('honors a smaller explicit duration and releases its timer on manual stop', () => {
    vi.useFakeTimers();
    const onStop = vi.fn();
    const controller = startTaroDomReplayPoc({
      root,
      MutationObserver: Observer,
      maxDurationMs: 1000,
      onStop,
    });
    recordings.push(controller);
    vi.advanceTimersByTime(999);
    expect(controller.getCapture().stopReason).toBeNull();
    controller.stop('manual');
    vi.advanceTimersByTime(60 * 60_000);
    expect(controller.getCapture().stopReason).toBe('manual');
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('falls back to a 60-second rolling window without losing bounded history', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const controller = startTaroDomReplayPoc({
      root,
      MutationObserver: Observer,
      rollingWindowMs: NaN,
      maskAllText: false,
    });
    recordings.push(controller);
    controller.addBreadcrumb({ category: 'test', message: 'synthetic-before' });
    vi.advanceTimersByTime(45_000);
    controller.addBreadcrumb({ category: 'test', message: 'synthetic-middle' });
    expect(JSON.stringify(controller.getCapture())).toContain('synthetic-before');
    vi.advanceTimersByTime(16_000);
    controller.addBreadcrumb({ category: 'test', message: 'synthetic-after' });
    const capture = controller.getCapture();
    expect(JSON.stringify(capture)).not.toContain('synthetic-before');
    expect(JSON.stringify(capture)).toContain('synthetic-middle');
    expect(capture.events.length).toBeLessThanOrEqual(500);
    expect(capture.stats.approximateBytes).toBeLessThanOrEqual(512 * 1024);
  });
});
