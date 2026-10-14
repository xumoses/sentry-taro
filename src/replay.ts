import * as sdk from '../packages/sdk/src/index';
import { taroReplayIntegration as createIntegration } from '../packages/replay/src/coordinator/integration';
import type {
  TaroReplayIntegration,
  TaroReplayIntegrationOptions as LegacyOptions,
} from '../packages/replay/src/coordinator/integration';

export type ReplayIntegrationOptions = Omit<LegacyOptions, 'sdk'> & {
  /** Optional compatibility override. The unified SDK is used by default. */
  sdk?: LegacyOptions['sdk'];
};
export type TaroReplayIntegrationOptions = ReplayIntegrationOptions;

/** Opt-in Replay with the existing mini program recording and delivery behavior. */
export function replayIntegration(options: ReplayIntegrationOptions = {}): TaroReplayIntegration {
  return createIntegration({ ...options, sdk: options.sdk ?? sdk });
}

/** Compatibility spelling retained during the beta migration. */
export const taroReplayIntegration = replayIntegration;
