import { beforeEach, describe, expect, test, vi } from 'vite-plus/test';

const { tap, getCurrentInstance, nextTicks } = vi.hoisted(() => ({
  tap: vi.fn(),
  getCurrentInstance: vi.fn(() => ({ router: { $taroPath: 'pages/stale/index' } })),
  nextTicks: [] as Array<() => void>,
}));

vi.mock('@tarojs/runtime', () => ({
  document: { getElementById: vi.fn() },
  hooks: { tap },
  MutationObserver: class {},
}));

vi.mock('@tarojs/taro', () => ({
  default: {
    getCurrentInstance,
    nextTick: (callback: () => void) => nextTicks.push(callback),
    getWindowInfo: () => ({ windowWidth: 390, windowHeight: 844 }),
    getEnv: () => 'WEAPP',
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }),
    getAppBaseInfo: () => ({ SDKVersion: '3.6.2' }),
  },
}));

import { installTaroReplayPageLifecycle } from '../../src/replay/taro/lifecycle';
import type { TaroReplayRuntime } from '../../src/replay/types';

describe('installTaroReplayPageLifecycle', () => {
  beforeEach(() => {
    tap.mockReset();
    nextTicks.length = 0;
  });

  test('releases sampling-disabled roots without detaching a newer visible page', () => {
    const bridge = {
      attachRoot: vi.fn((_runtime: TaroReplayRuntime) => false),
      detachRoot: vi.fn(),
      flush: async () => {},
      refreshEnabled: () => true,
      getSnapshot: () => ({ state: 'disabled' as const, eventCount: 0, approximateBytes: 0 }),
      subscribe: () => () => {},
    };
    installTaroReplayPageLifecycle({ bridge });
    const page = { onReady: vi.fn(), onHide: vi.fn(), onUnload: vi.fn() };
    (tap.mock.calls[0]![1] as (config: typeof page) => void)(page);
    const first = { route: 'first' };
    const second = { route: 'second' };
    page.onReady.call(first);
    nextTicks.shift()?.();
    page.onReady.call(second);
    nextTicks.shift()?.();
    expect(bridge.attachRoot).toHaveBeenCalledTimes(2);
    page.onHide.call(first);
    expect(bridge.detachRoot).not.toHaveBeenCalled();
    page.onHide.call(second);
    page.onUnload.call(second);
    expect(bridge.detachRoot).toHaveBeenCalledTimes(1);
  });

  test('supplies the host style and static image getters on the attached page runtime', () => {
    const bridge = {
      attachRoot: vi.fn((_runtime: TaroReplayRuntime) => true),
      detachRoot: vi.fn(),
      flush: vi.fn(() => Promise.resolve()),
      refreshEnabled: vi.fn(() => true),
      getSnapshot: vi.fn(() => ({ state: 'buffer' as const, eventCount: 0, approximateBytes: 0 })),
      subscribe: vi.fn(() => () => undefined),
    };
    const getReplayStyles = vi.fn((route: string) => `.page { content: "${route}"; }`);
    const staticImageSources = { '/taroMiniapp/logo.png': 'data:image/png;base64,aGVsbG8=' };
    const getReplayImageSources = vi.fn(() => staticImageSources);
    const page = { onReady: vi.fn() };

    installTaroReplayPageLifecycle({ bridge, getReplayStyles, getReplayImageSources });
    const instrument = tap.mock.calls[0]![1] as (config: typeof page) => void;
    instrument(page);
    page.onReady.call({ route: 'pages/demo/index' });
    nextTicks.shift()?.();

    const runtime = bridge.attachRoot.mock.calls[0]![0];
    expect(runtime.getReplayStyles?.('pages/demo/index')).toBe(
      '.page { content: "pages/demo/index"; }',
    );
    expect(getReplayStyles).toHaveBeenCalledWith('pages/demo/index');
    expect(runtime.getReplayImageSources?.('pages/demo/index')).toBe(staticImageSources);
    expect(getReplayImageSources).toHaveBeenCalledWith('pages/demo/index');
  });

  test('attaches a visible Taro page once and detaches it once', () => {
    const bridge = {
      attachRoot: vi.fn((_runtime: TaroReplayRuntime) => true),
      detachRoot: vi.fn(),
      flush: vi.fn(() => Promise.resolve()),
      refreshEnabled: vi.fn(() => true),
      getSnapshot: vi.fn(() => ({ state: 'buffer' as const, eventCount: 0, approximateBytes: 0 })),
      subscribe: vi.fn(() => () => undefined),
    };
    const callbacks = {
      onReady: vi.fn(),
      onShow: vi.fn(),
      onHide: vi.fn(),
      onUnload: vi.fn(),
    };
    const page = { ...callbacks };

    installTaroReplayPageLifecycle({ bridge });
    expect(tap).toHaveBeenCalledWith('modifyPageObject', expect.any(Function));
    const instrument = tap.mock.calls[0]![1] as (config: typeof page) => void;
    instrument(page);

    const pageInstance = {
      $taroPath: 'pages/demo/index?$taroTimestamp=123',
      route: 'pages/demo/index',
    };
    page.onShow.call(pageInstance);
    expect(bridge.attachRoot).not.toHaveBeenCalled();
    page.onReady.call(pageInstance);
    expect(bridge.attachRoot).not.toHaveBeenCalled();
    nextTicks.shift()?.();
    expect(bridge.attachRoot).toHaveBeenCalledTimes(1);
    const runtime = bridge.attachRoot.mock.calls[0]![0];
    expect(runtime.getCurrentInstance()).toEqual({
      router: {
        $taroPath: 'pages/demo/index?$taroTimestamp=123',
        path: 'pages/demo/index',
      },
    });
    expect(getCurrentInstance).not.toHaveBeenCalled();
    expect(callbacks.onReady).toHaveBeenCalledTimes(1);
    expect(callbacks.onShow).toHaveBeenCalledTimes(1);

    page.onHide.call(pageInstance);
    page.onUnload.call(pageInstance);
    expect(bridge.detachRoot).toHaveBeenCalledTimes(1);
    expect(callbacks.onHide).toHaveBeenCalledTimes(1);
    expect(callbacks.onUnload).toHaveBeenCalledTimes(1);
  });

  test('swallows replay lifecycle failures without changing page lifecycle results', () => {
    const expected = { ok: true };
    const bridge = {
      attachRoot: vi.fn(() => {
        throw new Error('attach failed');
      }),
      detachRoot: vi.fn(() => {
        throw new Error('detach failed');
      }),
      flush: vi.fn(() => Promise.resolve()),
      refreshEnabled: vi.fn(() => true),
      getSnapshot: vi.fn(() => ({ state: 'buffer' as const, eventCount: 0, approximateBytes: 0 })),
      subscribe: vi.fn(() => () => undefined),
    };
    const page = {
      onReady: vi.fn(() => expected),
      onHide: vi.fn(() => expected),
    };

    installTaroReplayPageLifecycle({ bridge });
    const instrument = tap.mock.calls[0]![1] as (config: typeof page) => void;
    instrument(page);

    const pageInstance = {};
    expect(page.onReady.call(pageInstance)).toBe(expected);
    expect(() => nextTicks.shift()?.()).not.toThrow();
    expect(page.onHide.call(pageInstance)).toBe(expected);
  });
  test('forwards visible-page scroll/resize and ignores stale-page cleanup', () => {
    const bridge = {
      attachRoot: vi.fn(() => true),
      detachRoot: vi.fn(),
      flush: vi.fn(() => Promise.resolve()),
      refreshEnabled: vi.fn(() => true),
      getSnapshot: vi.fn(() => ({ state: 'buffer' as const, eventCount: 0, approximateBytes: 0 })),
      subscribe: vi.fn(() => () => undefined),
      recordPageScroll: vi.fn(),
      recordViewport: vi.fn(),
    };
    installTaroReplayPageLifecycle({ bridge });
    const page = {
      onReady: vi.fn(),
      onShow: vi.fn(),
      onHide: vi.fn(),
      onUnload: vi.fn(),
      onPageScroll: vi.fn(),
      onResize: vi.fn(),
    };
    (tap.mock.calls[0]![1] as (config: typeof page) => void)(page);
    const first = { route: 'first' };
    const second = { route: 'second' };
    page.onReady.call(first);
    nextTicks.shift()?.();
    page.onPageScroll.call(first, { scrollTop: 123 });
    page.onResize.call(first, { size: { windowWidth: 844, windowHeight: 390 } });
    expect(bridge.recordPageScroll).toHaveBeenCalledWith({ scrollTop: 123 });
    expect(bridge.recordViewport).toHaveBeenCalledWith({ width: 844, height: 390 });
    page.onReady.call(second);
    nextTicks.shift()?.();
    page.onUnload.call(first);
    expect(bridge.detachRoot).not.toHaveBeenCalled();
    page.onPageScroll.call(first, { scrollTop: 456 });
    expect(bridge.recordPageScroll).toHaveBeenCalledTimes(1);
    page.onHide.call(second);
    expect(bridge.detachRoot).toHaveBeenCalledTimes(1);
  });

  test('a late ready callback cannot record an already hidden page', () => {
    const bridge = {
      attachRoot: vi.fn(() => true),
      detachRoot: vi.fn(),
      flush: vi.fn(() => Promise.resolve()),
      refreshEnabled: vi.fn(() => true),
      getSnapshot: vi.fn(() => ({ state: 'buffer' as const, eventCount: 0, approximateBytes: 0 })),
      subscribe: vi.fn(() => () => undefined),
    };
    installTaroReplayPageLifecycle({ bridge });
    const page = { onReady: vi.fn(), onShow: vi.fn(), onHide: vi.fn() };
    (tap.mock.calls[0]![1] as (config: typeof page) => void)(page);
    const instance = { route: 'hidden' };
    page.onShow.call(instance);
    page.onHide.call(instance);
    page.onReady.call(instance);
    for (const callback of nextTicks.splice(0)) callback();
    expect(bridge.attachRoot).not.toHaveBeenCalled();
    page.onShow.call(instance);
    nextTicks.shift()?.();
    expect(bridge.attachRoot).toHaveBeenCalledTimes(1);
  });

  test('failed root attachment can retry on show and cleanup survives an original hook throw', () => {
    const bridge = {
      attachRoot: vi.fn().mockReturnValueOnce(false).mockReturnValue(true),
      detachRoot: vi.fn(),
      flush: vi.fn(() => Promise.resolve()),
      refreshEnabled: vi.fn(() => true),
      getSnapshot: vi.fn(() => ({ state: 'buffer' as const, eventCount: 0, approximateBytes: 0 })),
      subscribe: vi.fn(() => () => undefined),
    };
    installTaroReplayPageLifecycle({ bridge });
    const failure = new Error('application lifecycle error');
    const page = {
      onReady: vi.fn(),
      onShow: vi.fn(),
      onHide: vi.fn(() => {
        throw failure;
      }),
    };
    (tap.mock.calls[0]![1] as (config: typeof page) => void)(page);
    const instance = { route: 'retry' };
    page.onReady.call(instance);
    nextTicks.shift()?.();
    page.onShow.call(instance);
    nextTicks.shift()?.();
    expect(bridge.attachRoot).toHaveBeenCalledTimes(2);
    expect(() => page.onHide.call(instance)).toThrow(failure);
    expect(bridge.detachRoot).toHaveBeenCalledTimes(1);
  });
});
