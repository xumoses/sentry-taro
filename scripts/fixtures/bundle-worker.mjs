import { captureException, getReplay, init, replayIntegration } from '@xumoses/sentry-taro';

// The host packages this separate Worker and creates the integration at runtime.
globalThis.__SENTRY_SYNTHETIC_CONSUMER__ = {
  captureException,
  getReplay,
  init,
  createReplay: () =>
    replayIntegration({ compression: { workerPath: 'workers/replay-compression.js' } }),
};
