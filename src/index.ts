export * from '../packages/sdk/src/index';
export * from '../packages/replay/src/index';

// The recorder's node type retains optional event listener hooks from the SDK
// and remains structurally compatible with the Replay adapter's node boundary.
export type {
  TaroReplayNodeLike,
  TaroReplayMutationObserverConstructor,
  TaroReplayMutationObserverLike,
  TaroReplayMutationRecordLike,
} from '../packages/sdk/src/replay-poc';

export { replayIntegration, taroReplayIntegration } from './replay';
export type { ReplayIntegrationOptions, TaroReplayIntegrationOptions } from './replay';
