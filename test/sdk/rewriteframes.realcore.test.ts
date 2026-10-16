import { afterEach, beforeEach, expect, test } from 'vite-plus/test';
import * as Sentry from '../../src/sdk/index';
import { installedIntegrations } from '@sentry/core';
import type { Envelope } from '@sentry/core';
import { resetPlatformCache } from '../../src/sdk/crossPlatform';

let envelopes: Envelope[];

beforeEach(() => {
  envelopes = [];
  installedIntegrations.length = 0;
  Sentry.getCurrentScope().clear();
  Sentry.getCurrentScope().setClient(undefined);
  resetPlatformCache();
});
afterEach(async () => {
  await Sentry.getClient()?.close(0);
  Sentry.getCurrentScope().setClient(undefined);
});

test('default init sends parsed WeChat frames under the taro-plugin upload prefix', async () => {
  const client = Sentry.init({
    dsn: 'https://public@ingest.example.test/1',
    enableAutoSessionTracking: false,
    enableNavigationBreadcrumbs: false,
    enableUserInteractionBreadcrumbs: false,
    enableNetworkStatusMonitoring: false,
    enableOfflineCache: false,
    transport: () => ({
      send: async (envelope) => {
        envelopes.push(envelope);
        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
  })!;
  const devtools = 'http://127.0.0.1:47848/appservice/app-service.js';
  const error = new Error('frames');
  error.stack = [
    'Error: frames',
    '    at onLoad (https://usr/packageA/app-service.js:1:20)',
    '    at render (appservice/app-service.js:2:30)',
    `    at tap (${devtools}:3:40)`,
  ].join('\n');
  Sentry.captureException(error);
  await client.flush(2000);
  const events: any[] = [];
  for (const envelope of envelopes)
    for (const item of envelope[1]) if (item[0].type === 'event') events.push(item[1]);
  expect(events).toHaveLength(1);
  const frames: Array<{ filename: string }> = events[0].exception.values[0].stacktrace.frames;
  const filenames = frames.map((frame) => frame.filename);
  expect(filenames.sort()).toEqual(
    [devtools, 'https://usr/app-service.js', 'https://usr/packageA/app-service.js'].sort(),
  );
});
