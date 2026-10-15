import { captureException, init } from '@xumoses/sentry-taro';

// Retain the same error APIs in both synthetic consumers without sending data.
globalThis.__SENTRY_SYNTHETIC_CONSUMER__ = { captureException, init };
