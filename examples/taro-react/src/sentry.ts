import * as Sentry from '@xumoses/sentry-taro';

// Local illustrative collection only; this is not a remote delivery transport.
const envelopes: unknown[] = [];
export const getCollectedEnvelopeCount = (): number => envelopes.length;
export const replay = Sentry.replayIntegration({
  // Only synthetic constants are rendered by this demo.
  privacy: { maskAllText: false },
});

Sentry.init({
  dsn: 'https://public@example.test/1',
  environment: 'synthetic-demo',
  sendDefaultPii: false,
  traceNetworkBody: false,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 1,
  integrations: [...Sentry.getDefaultIntegrations(), replay],
  transport: () => ({
    send: async (envelope) => {
      envelopes.push(envelope);
      return { statusCode: 200 };
    },
    flush: async () => true,
  }),
});

export { Sentry };
