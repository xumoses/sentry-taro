export { createTaroReplay } from './createTaroReplay';
export {
  startTaroReplayRecorder,
  TARO_REPLAY_CAPTURE_MARKER,
  type TaroReplayScrollEventLike,
} from './recorder/recorder';
export { ReplayCoordinator } from './coordinator/ReplayCoordinator';
export { taroReplayIntegration } from './coordinator/integration';
export type {
  TaroReplayIntegration,
  TaroReplayIntegrationOptions,
} from './coordinator/integration';
export type {
  ReplayCoordinatorOptions,
  ReplayCoordinatorSnapshot,
  ReplayCoordinatorState,
  TaroReplayBridge,
} from './coordinator/types';
export type {
  CreateTaroReplayOptions,
  SentryMiniappReplaySdk,
  SentryReplayClient,
  StartTaroReplayRecorderOptions,
  TaroReplayCapture,
  TaroReplayContext,
  TaroReplayControllerView,
  TaroReplayEvent,
  TaroReplayHandle,
  TaroReplayLimitOptions,
  TaroReplayMetadata,
  TaroReplayAttributeLike,
  TaroReplayMutationObserverConstructor,
  TaroReplayMutationObserverLike,
  TaroReplayMutationRecordLike,
  TaroReplayNodeLike,
  TaroReplayNetworkOptions,
  TaroReplayPrivacyOptions,
  TaroReplayRecorder,
  TaroReplayRecorderController,
  TaroReplayRuntime,
  TaroReplayState,
  UseTaroReplayOptions,
  UseTaroReplayResult,
} from './types';

export type { ReplayDeliveryOptions, ReplayDeliverySnapshot } from './coordinator/delivery';

export type {
  ReplayCompressionOptions,
  ReplayCompressionSnapshot,
  ReplayWorker,
} from './compression';

export { decodeReplayAssetData } from './replay-assets';
export { createReplayAssetProviders } from './replay-asset-providers';
export type { ReplayAssetProviderOptions, ReplayAssetProviders } from './replay-asset-providers';
