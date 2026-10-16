export * from './sdk/index';
export * from './replay/index';

// The recorder's node type retains optional event listener hooks from the SDK
// and remains structurally compatible with the Replay adapter's node boundary.
export type {
  TaroReplayNodeLike,
  TaroReplayMutationObserverConstructor,
  TaroReplayMutationObserverLike,
  TaroReplayMutationRecordLike,
} from './sdk/replay-poc';

export { getReplay, replayIntegration, taroReplayIntegration } from './replay';
export type { ReplayIntegrationOptions, TaroReplayIntegrationOptions } from './replay';
export type { ReplayRecordingMode, SendBufferedReplayOptions } from './replay/coordinator/types';
