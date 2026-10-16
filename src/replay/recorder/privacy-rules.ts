/** Mask, block and unmask decisions derived from recorder options and node privacy markers. */

import type { StartTaroReplayRecorderOptions, TaroReplayNodeLike } from '../types';
import { hasMaskingFlag, privacyMarker } from './attributes';
import { hasNodeAncestor, isInputNode, rawAttributeValue, sensitiveInputs } from './nodes';

export interface PrivacyRules {
  readonly maskAttributes: ReadonlySet<string>;
  shouldMaskInputValues(node: TaroReplayNodeLike): boolean;
  isBlocked(node: TaroReplayNodeLike): boolean;
  isMasked(node: TaroReplayNodeLike): boolean;
  isUnmasked(node: TaroReplayNodeLike): boolean;
  shouldMaskText(node: TaroReplayNodeLike): boolean;
  shouldBlockMedia(node: TaroReplayNodeLike): boolean;
}

export function createPrivacyRules(options: StartTaroReplayRecorderOptions): PrivacyRules {
  const maskAllText = options.maskAllText !== false;
  const maskInputValues = options.maskAllInputs ?? options.maskInputValues !== false;
  const blockAllMedia = options.blockAllMedia !== false;
  const maskAttributes = new Set(
    (options.maskAttributes ?? ['title', 'placeholder', 'aria-label']).map((name) =>
      name.toLowerCase(),
    ),
  );

  function shouldMaskInputValues(node: TaroReplayNodeLike): boolean {
    if (!isInputNode(node)) return false;
    if (
      hasMaskingFlag(node, 'password') ||
      String(rawAttributeValue(node, 'type') ?? '').toLowerCase() === 'password' ||
      hasNodeAncestor(node, (ancestor) => privacyMarker(ancestor, 'mask'))
    ) {
      // A password reveal toggle must not turn this mounted input into clear text.
      sensitiveInputs.add(node);
    }
    return maskInputValues || sensitiveInputs.has(node);
  }
  const isBlocked = (node: TaroReplayNodeLike): boolean =>
    hasNodeAncestor(node, (ancestor) => privacyMarker(ancestor, 'block'));
  const isMasked = (node: TaroReplayNodeLike): boolean =>
    hasNodeAncestor(node, (ancestor) => privacyMarker(ancestor, 'mask'));
  const isUnmasked = (node: TaroReplayNodeLike): boolean =>
    hasNodeAncestor(node, (ancestor) => privacyMarker(ancestor, 'unmask'));
  const shouldMaskText = (node: TaroReplayNodeLike): boolean =>
    isMasked(node) || (maskAllText && !isUnmasked(node));
  const shouldBlockMedia = (node: TaroReplayNodeLike): boolean =>
    blockAllMedia && !hasNodeAncestor(node, (ancestor) => privacyMarker(ancestor, 'unblock'));

  return {
    maskAttributes,
    shouldMaskInputValues,
    isBlocked,
    isMasked,
    isUnmasked,
    shouldMaskText,
    shouldBlockMedia,
  };
}
