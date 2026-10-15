import { captureException, getReplay, init, replayIntegration } from '@xumoses/sentry-taro';

globalThis.__SENTRY_SYNTHETIC_CONSUMER__ = {
  captureException,
  getReplay,
  init,
  createReplay: () => replayIntegration(),
};
