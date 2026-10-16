import { beforeEach, describe, expect, test, vi } from 'vite-plus/test';

const callbacks = vi.hoisted(() => ({
  ready: [] as Array<() => void>,
  show: [] as Array<() => void>,
  hide: [] as Array<() => void>,
  unload: [] as Array<() => void>,
  scroll: [] as Array<(value: any) => void>,
  resize: [] as Array<(value: any) => void>,
  cleanup: [] as Array<() => void>,
}));
vi.mock('@tarojs/runtime', () => ({ document: {}, MutationObserver: class {} }));
vi.mock('@tarojs/taro', () => ({
  default: { getCurrentInstance: () => ({ router: { path: 'page' } }) },
  useReady: (callback: () => void) => callbacks.ready.push(callback),
  useDidShow: (callback: () => void) => callbacks.show.push(callback),
  useDidHide: (callback: () => void) => callbacks.hide.push(callback),
  useUnload: (callback: () => void) => callbacks.unload.push(callback),
  usePageScroll: (callback: (value: any) => void) => callbacks.scroll.push(callback),
  useResize: (callback: (value: any) => void) => callbacks.resize.push(callback),
}));
vi.mock('react', () => ({
  useRef: (current: unknown) => ({ current }),
  useState: (initialize: () => unknown) => [initialize(), vi.fn()],
  useEffect: (effect: () => (() => void) | undefined) => {
    const cleanup = effect();
    if (cleanup) callbacks.cleanup.push(cleanup);
  },
}));
import { useTaroReplayRoot } from '../../src/replay/react/root';
function bridge() {
  return {
    attachRoot: vi.fn(() => true),
    detachRoot: vi.fn(),
    flush: async () => {},
    refreshEnabled: () => true,
    recordPageScroll: vi.fn(),
    recordViewport: vi.fn(),
    getSnapshot: () => ({ state: 'buffer' as const, eventCount: 0, approximateBytes: 0 }),
    subscribe: () => () => {},
  };
}
beforeEach(() => {
  for (const list of Object.values(callbacks)) list.length = 0;
});
describe('root hook page ownership', () => {
  test('releases the visible root when automatic recording is disabled', () => {
    const b = bridge();
    b.attachRoot.mockReturnValue(false);
    useTaroReplayRoot({ bridge: b });
    useTaroReplayRoot({ bridge: b });
    callbacks.show[0]!();
    callbacks.show[1]!();
    callbacks.hide[0]!();
    expect(b.detachRoot).not.toHaveBeenCalled();
    callbacks.hide[1]!();
    expect(b.detachRoot).toHaveBeenCalledTimes(1);
    callbacks.unload[1]!();
    expect(b.detachRoot).toHaveBeenCalledTimes(1);
  });
  test('stale cleanup and scroll cannot affect the next visible root', () => {
    const b = bridge();
    useTaroReplayRoot({ bridge: b });
    useTaroReplayRoot({ bridge: b });
    callbacks.show[0]!();
    callbacks.ready[0]!();
    expect(b.attachRoot).toHaveBeenCalledTimes(1);
    callbacks.show[1]!();
    callbacks.unload[0]!();
    callbacks.scroll[0]!({ scrollTop: 10 });
    expect(b.detachRoot).not.toHaveBeenCalled();
    expect(b.recordPageScroll).not.toHaveBeenCalled();
    callbacks.scroll[1]!({ scrollTop: 20 });
    callbacks.resize[1]!({ size: { windowWidth: 500, windowHeight: 300 } });
    expect(b.recordPageScroll).toHaveBeenCalledWith({ scrollTop: 20 });
    expect(b.recordViewport).toHaveBeenCalledWith({ width: 500, height: 300 });
    callbacks.hide[1]!();
    callbacks.ready[1]!();
    expect(b.detachRoot).toHaveBeenCalledTimes(1);
    expect(b.attachRoot).toHaveBeenCalledTimes(2);
  });
  test('missing roots retry on ready and hidden roots wait for show', () => {
    const b = bridge();
    b.attachRoot.mockReturnValueOnce(false);
    useTaroReplayRoot({ bridge: b });
    callbacks.show[0]!();
    callbacks.ready[0]!();
    expect(b.attachRoot).toHaveBeenCalledTimes(2);
    callbacks.hide[0]!();
    callbacks.ready[0]!();
    expect(b.attachRoot).toHaveBeenCalledTimes(2);
    callbacks.show[0]!();
    expect(b.attachRoot).toHaveBeenCalledTimes(3);
  });
});
