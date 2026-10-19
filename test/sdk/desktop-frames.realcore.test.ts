import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';
import * as Sentry from '../../src/sdk/index';
import { installedIntegrations, type Envelope, type ErrorEvent } from '@sentry/core';
import { resetPlatformCache } from '../../src/sdk/crossPlatform';
import { _resetAppLifecycle } from '../../src/sdk/appLifecycle';

// Raw lines from paired trial events of one build: Mac WeChat 4.1.15.55 runs the main package
// 1406 lines below the final map; a subpackage frame is never shifted.
const STACK = [
  'Error: synthetic desktop error',
  '    at u (https://usr/app-service.js:10640:3046)',
  '    at t.onClick (https://usr/taroMiniapp/pages/ReplayPoc/app-service.js:1097:6656)',
].join('\n');

const g = globalThis as any;
let envelopes: Envelope[];

function host(platform: string, version: string): void {
  g.wx.getDeviceInfo = () => ({ platform, system: 'synthetic', brand: 'synthetic', model: 'x' });
  g.wx.getAppBaseInfo = () => ({ version, SDKVersion: '3.17.4' });
  resetPlatformCache();
}

function sent(): any {
  for (const envelope of envelopes)
    for (const item of envelope[1]) if (item[0].type === 'event') return item[1];
  throw new Error('no event sent');
}

async function capture(beforeSend?: Sentry.MiniappOptions['beforeSend']) {
  Sentry.init({
    dsn: 'https://public@ingest.example.test/1',
    enableAutoSessionTracking: false,
    enableNavigationBreadcrumbs: false,
    enableUserInteractionBreadcrumbs: false,
    enableNetworkStatusMonitoring: false,
    enableOfflineCache: false,
    ...(beforeSend ? { beforeSend } : {}),
    transport: () => ({
      send: async (envelope) => {
        envelopes.push(envelope);
        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
  });
  const error = new Error('synthetic desktop error');
  error.stack = STACK;
  Sentry.captureException(error);
  await Sentry.flush(2000);
  const event = sent();
  return {
    frames: event.exception.values[0].stacktrace.frames.map((frame: any) => [
      frame.filename,
      frame.lineno,
      frame.colno,
    ]),
    marker: event.contexts?.miniapp?.main_package_line_offset,
  };
}

// The host pattern that undid rc.3: replace every frame by re-parsing the original stack.
function reparse(event: ErrorEvent, hint: Sentry.EventHint): ErrorEvent {
  const stack = (hint.originalException as Error).stack!;
  event.exception!.values![0]!.stacktrace = { frames: Sentry.miniappStackParser(stack) };
  return event;
}

beforeEach(() => {
  envelopes = [];
  installedIntegrations.length = 0;
  Sentry.getCurrentScope().clear();
  Sentry.getIsolationScope().clear();
  Sentry.getCurrentScope().setClient(undefined);
  _resetAppLifecycle();
});

afterEach(async () => {
  await Sentry.getClient()?.close(0);
  Sentry.getCurrentScope().setClient(undefined);
  resetPlatformCache();
});

describe('desktop WeChat main-package lines in sent events', () => {
  const corrected = [
    ['https://usr/taroMiniapp/pages/ReplayPoc/app-service.js', 1097, 6656],
    ['https://usr/app-service.js', 9234, 3046],
  ];

  test('corrects once on a listed Mac client', async () => {
    host('mac', '4.1.15.55');
    expect(await capture()).toEqual({ frames: corrected, marker: 1406 });
  });

  test('survives a beforeSend that re-parses the original stack', async () => {
    host('mac', '4.1.15.55');
    expect(await capture(reparse)).toEqual({ frames: corrected, marker: 1406 });
  });

  test('lets beforeSend see runtime lines', async () => {
    host('mac', '4.1.15.55');
    let seen: unknown;
    await capture((event) => {
      seen = event.exception!.values![0]!.stacktrace!.frames!.at(-1)!.lineno;
      return event;
    });
    expect(seen).toBe(10640);
  });

  test.each([
    ['ios', '8.0.79'],
    ['mac', '4.1.16.0'],
  ])('leaves %s %s unchanged and unmarked', async (platform, version) => {
    host(platform, version);
    expect(await capture(reparse)).toEqual({
      frames: [
        ['https://usr/taroMiniapp/pages/ReplayPoc/app-service.js', 1097, 6656],
        ['https://usr/app-service.js', 10640, 3046],
      ],
      marker: undefined,
    });
  });
});
