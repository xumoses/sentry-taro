import { hooks } from '@tarojs/runtime';

import type { TaroReplayEventSource } from '../types';

type DispatchListener = Parameters<TaroReplayEventSource>[0];
const DISPATCH_FINISH = 'dispatchTaroEventFinish';

/**
 * Observes Taro DOM dispatch after application handlers ran. Taro only dispatches
 * on nodes with a native binding and never bubbles through the virtual DOM.
 */
export const observeTaroEvents: TaroReplayEventSource = (listener) => {
  const callback: DispatchListener = (event, node) => {
    try {
      listener(event, node);
    } catch {
      // Replay is diagnostic-only and must never alter Taro event dispatch.
    }
  };
  try {
    hooks.tap(DISPATCH_FINISH, callback);
  } catch {
    // Older runtimes without this hook record no interactions.
    return () => {};
  }
  return () => {
    try {
      hooks.off(DISPATCH_FINISH, callback);
    } catch {
      /* Best-effort cleanup. */
    }
  };
};
