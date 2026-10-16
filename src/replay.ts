import { getClient } from '@sentry/core';
import { taroReplayIntegration as createIntegration } from './replay/coordinator/integration';
import type {
  TaroReplayIntegration,
  TaroReplayIntegrationOptions,
} from './replay/coordinator/integration';

export type ReplayIntegrationOptions = TaroReplayIntegrationOptions;
export type { TaroReplayIntegrationOptions };

/** Opt-in Replay using official controls and the Taro recording/delivery adapters. */
export function replayIntegration(options: ReplayIntegrationOptions = {}): TaroReplayIntegration {
  return createIntegration(options);
}

/** Returns the Replay integration attached to the currently active client. */
export function getReplay(): TaroReplayIntegration | undefined {
  return getClient()?.getIntegrationByName<TaroReplayIntegration>('Replay');
}

/** Compatibility spelling retained during the beta migration. */
export const taroReplayIntegration = replayIntegration;
