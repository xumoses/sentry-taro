import { addBreadcrumb, getClient } from '@sentry/core';

import { startTaroReplayRecorder } from '../recorder/recorder';
import { SDK_NAME, SDK_VERSION } from '../../sdk/version';
import type { SentryMiniappReplaySdk } from '../types';

// List only what Replay calls, so opting into Replay does not retain every SDK export.
export const defaultReplaySdk: SentryMiniappReplaySdk = {
  SDK_NAME,
  SDK_VERSION,
  getClient,
  addBreadcrumb,
  startTaroDomReplayPoc: startTaroReplayRecorder,
};
