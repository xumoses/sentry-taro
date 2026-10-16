import { afterEach, expect, it } from 'vite-plus/test';
import {
  startTaroDomReplayPoc,
  type TaroReplayNodeLike,
  type TaroReplayMutationRecordLike,
  type TaroReplayScrollEventLike,
} from '../src/replay-poc';

let serial = 0;
type TestNode = TaroReplayNodeLike & {
  props: Record<string, unknown>;
  emit: (event: TaroReplayScrollEventLike) => void;
};
function node(
  name: string,
  props: Record<string, unknown> = {},
  children: TestNode[] = [],
): TestNode {
  const listeners = new Set<(event: TaroReplayScrollEventLike) => void>();
  const result = {
    nodeType: 1,
    nodeName: name,
    sid: String(++serial),
    props,
    childNodes: children,
    get attributes() {
      return Object.entries(props).map(([name, value]) => ({ name, value }));
    },
    getAttribute: (name: string) => props[name],
    hasAttribute: (name: string) => name in props,
    addEventListener: (name: string, listener: (event: TaroReplayScrollEventLike) => void) => {
      if (name === 'change') listeners.add(listener);
    },
    removeEventListener: (_name: string, listener: (event: TaroReplayScrollEventLike) => void) => {
      listeners.delete(listener);
    },
    emit: (event: TaroReplayScrollEventLike) => listeners.forEach((listener) => listener(event)),
  };
  children.forEach((child) => {
    child.parentNode = result;
  });
  return result;
}
const controllers: ReturnType<typeof startTaroDomReplayPoc>[] = [];
afterEach(() => controllers.splice(0).forEach((controller) => controller.stop()));
it('preserves a two-page 3+2 carousel and records native and controlled page changes', () => {
  const pages = [3, 2].map((count) =>
    node(
      'swiper-item',
      {},
      Array.from({ length: count }, () => node('view', { 'data-sentry-canvas': true })),
    ),
  );
  const swiper = node('swiper', { current: 0, style: 'height:400rpx' }, pages);
  const root = node('root', {}, [swiper]);
  let mutate = (_records: TaroReplayMutationRecordLike[]) => {};
  const controller = startTaroDomReplayPoc({
    root,
    width: 375,
    height: 800,
    MutationObserver: class {
      constructor(callback: typeof mutate) {
        mutate = callback;
      }
      observe() {}
      disconnect() {}
    },
  });
  controllers.push(controller);
  const snapshot = () =>
    JSON.stringify(
      controller
        .getCapture()
        .events.filter((event) => event.type === 2)
        .at(-1),
    );
  expect(snapshot()).toContain('--taro-replay-swiper-current:0');
  expect(snapshot()).toContain('--taro-replay-swiper-index:1');
  expect(snapshot()).toContain('translateX(calc(');
  const before = controller.getCapture().events.length;
  swiper.emit({ detail: { current: 1 } });
  const native = JSON.stringify(controller.getCapture().events.slice(before));
  expect(native).toContain('--taro-replay-swiper-current:1');
  expect(native).not.toContain('"type":2');
  swiper.props.current = 1;
  mutate([{ type: 'attributes', target: swiper, attributeName: 'current' }]);
  swiper.props.current = 0;
  mutate([{ type: 'attributes', target: swiper, attributeName: 'current' }]);
  expect(snapshot()).toContain('--taro-replay-swiper-current:0');
  controller.stop();
  const stoppedCount = controller.getCapture().events.length;
  swiper.emit({ detail: { current: 1 } });
  expect(controller.getCapture().events).toHaveLength(stoppedCount);
});
it('retains page indexes after reordering and normalizes an initial page beyond the page count', () => {
  const pages = [node('swiper-item', { style: 'background:red' }), node('swiper-item')];
  const swiper = node('swiper', { current: 99, vertical: true }, pages);
  let mutate = (_records: TaroReplayMutationRecordLike[]) => {};
  const controller = startTaroDomReplayPoc({
    root: swiper,
    MutationObserver: class {
      constructor(callback: typeof mutate) {
        mutate = callback;
      }
      observe() {}
      disconnect() {}
    },
  });
  controllers.push(controller);
  const snapshot = () =>
    JSON.stringify(
      controller
        .getCapture()
        .events.filter((event) => event.type === 2)
        .at(-1),
    );
  expect(snapshot()).toContain('--taro-replay-swiper-current:1');
  expect(snapshot()).toContain('background:red;--taro-replay-swiper-index:0');
  swiper.childNodes = [...pages].reverse();
  mutate([
    { type: 'childList', target: swiper, addedNodes: [pages[0]!], removedNodes: [pages[0]!] },
  ]);
  expect(snapshot()).toContain('background:red;--taro-replay-swiper-index:1');
  swiper.props.style = 'height:500rpx';
  mutate([{ type: 'attributes', target: swiper, attributeName: 'style' }]);
  expect(JSON.stringify(controller.getCapture().events.at(-1))).toContain(
    'height:250px;--taro-replay-swiper-current:1',
  );
});
