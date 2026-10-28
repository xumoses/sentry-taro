import { describe, expect, test, vi } from 'vite-plus/test';

// Taro's build replaces these feature flags; the runtime reads them at import time.
vi.hoisted(() => {
  for (const flag of [
    'ENABLE_ADJACENT_HTML',
    'ENABLE_CLONE_NODE',
    'ENABLE_CONTAINS',
    'ENABLE_INNER_HTML',
    'ENABLE_MUTATION_OBSERVER',
    'ENABLE_SIZE_APIS',
    'ENABLE_TEMPLATE_CONTENT',
  ])
    (globalThis as Record<string, unknown>)[flag] = true;
});

import { document, eventHandler, MutationObserver } from '@tarojs/runtime';

import { observeRootActivity } from '../../src/replay/coordinator/session';
import { startTaroReplayRecorder } from '../../src/replay/recorder/recorder';
import { observeTaroEvents } from '../../src/replay/taro/events';
import type { TaroReplayNodeLike } from '../../src/replay/types';

type TaroNode = TaroReplayNodeLike & {
  sid: string;
  appendChild(node: TaroNode): void;
  addEventListener(type: string, handler: () => void): void;
};

function page() {
  const root = document.createElement('root') as unknown as TaroNode;
  const card = document.createElement('view') as unknown as TaroNode;
  const button = document.createElement('view') as unknown as TaroNode;
  card.appendChild(button);
  root.appendChild(card);
  return { root, card, button };
}

/** Native WXML bubbling calls Taro's handler once per bound element with the same target. */
function nativeTap(target: TaroNode, boundChain: TaroNode[], timeStamp: number): void {
  for (const bound of boundChain)
    eventHandler({
      type: 'tap',
      timeStamp,
      target: { id: target.sid, dataset: {} },
      currentTarget: { id: bound.sid, dataset: {} },
      detail: { x: 12, y: 34 },
      changedTouches: [{ clientX: 12, clientY: 34, pageX: 12, pageY: 34 }],
    } as unknown as Parameters<typeof eventHandler>[0]);
}

describe('Taro DOM event dispatch', () => {
  test('records child taps that never bubble to the page root', () => {
    const { root, card, button } = page();
    const handled: string[] = [];
    card.addEventListener('tap', () => handled.push('card'));
    button.addEventListener('tap', () => handled.push('button'));
    const recorder = startTaroReplayRecorder({
      root,
      MutationObserver: MutationObserver as never,
      observeEvents: observeTaroEvents,
    });

    nativeTap(button, [button, card], 1000);
    nativeTap(button, [button, card], 1500);

    expect(handled).toEqual(['button', 'card', 'button', 'card']);
    const events = recorder.getCapture().events;
    const clicks = events.filter(
      (event) => event.type === 3 && event.data['source'] === 2 && event.data['type'] === 2,
    );
    expect(clicks).toHaveLength(2);
    expect(clicks[0]?.data).toMatchObject({ x: 12, y: 34 });
    const breadcrumbs = events.filter(
      (event) =>
        event.type === 5 &&
        (event.data['payload'] as { category?: string } | undefined)?.category === 'ui.click',
    );
    expect(breadcrumbs).toHaveLength(2);
    expect(breadcrumbs[0]?.data['payload']).toMatchObject({
      data: { nodeId: clicks[0]?.data['id'] },
    });

    recorder.stop();
    nativeTap(button, [button], 2000);
    expect(recorder.getCapture().events.length).toBe(events.length);
  });

  test('counts child taps as session activity only for the observed root', () => {
    const { root, button } = page();
    const other = page();
    button.addEventListener('tap', () => {});
    other.button.addEventListener('tap', () => {});
    const activity = vi.fn();
    const detach = observeRootActivity(root, activity, observeTaroEvents);

    nativeTap(other.button, [other.button], 1000);
    expect(activity).not.toHaveBeenCalled();
    nativeTap(button, [button], 1000);
    expect(activity).toHaveBeenCalledTimes(1);

    detach();
    nativeTap(button, [button], 2000);
    expect(activity).toHaveBeenCalledTimes(1);
  });
});
