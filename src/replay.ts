import { addBreadcrumb, getClient } from '@sentry/core';
import { startTaroDomReplayPoc } from './sdk/replay-poc';
import { SDK_NAME, SDK_VERSION } from './sdk/version';
import { taroReplayIntegration as createIntegration } from './replay/coordinator/integration';
import type {
  TaroReplayIntegration,
  TaroReplayIntegrationOptions as LegacyOptions,
} from './replay/coordinator/integration';

export type ReplayIntegrationOptions = Omit<LegacyOptions, 'sdk'> & {
  /** Optional compatibility override. The unified SDK is used by default. */
  sdk?: LegacyOptions['sdk'];
};
export type TaroReplayIntegrationOptions = ReplayIntegrationOptions;

// Keep the recorder boundary explicit: passing an SDK namespace here retains
// every public SDK export in consumers that opt into Replay.
const replaySdk: LegacyOptions['sdk'] = {
  SDK_NAME,
  SDK_VERSION,
  getClient,
  addBreadcrumb,
  startTaroDomReplayPoc,
};

/** Opt-in Replay using official controls and the Taro recording/delivery adapters. */
export function replayIntegration(options: ReplayIntegrationOptions = {}): TaroReplayIntegration {
  return createIntegration({ ...options, sdk: options.sdk ?? replaySdk });
}

/** Returns the Replay integration attached to the currently active client. */
export function getReplay(): TaroReplayIntegration | undefined {
  return getClient()?.getIntegrationByName<TaroReplayIntegration>('Replay');
}

/** Compatibility spelling retained during the beta migration. */
export const taroReplayIntegration = replayIntegration;
