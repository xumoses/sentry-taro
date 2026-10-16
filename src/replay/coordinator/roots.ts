/** Locates the visible Taro page root and checks that a node still belongs to it. */

import { sanitizeUrl } from '../privacy';
import type { TaroReplayNodeLike, TaroReplayRuntime } from '../types';

export function currentRoot(runtime: TaroReplayRuntime): TaroReplayNodeLike | undefined {
  const router = runtime.getCurrentInstance().router;
  const id = router?.$taroPath || router?.path;
  return id
    ? runtime.document.getElementById(id) ||
        runtime.document.getElementById(sanitizeUrl(id).replace(/^\/+/, '')) ||
        undefined
    : undefined;
}

export function belongsToRoot(node: TaroReplayNodeLike, root: TaroReplayNodeLike): boolean {
  const visited = new Set<TaroReplayNodeLike>();
  let ancestor: TaroReplayNodeLike | null | undefined = node;
  while (ancestor && !visited.has(ancestor)) {
    if (ancestor === root) return true;
    visited.add(ancestor);
    const parent: TaroReplayNodeLike | null | undefined = ancestor.parentNode;
    if (parent?.childNodes && !parent.childNodes.includes(ancestor)) return false;
    ancestor = parent;
  }
  return false;
}
