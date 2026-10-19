import { describe, expect, it } from 'vite-plus/test';
import { Event, type StackFrame } from '@sentry/core';
import * as Sentry from '../../src/sdk/index';
import { resetPlatformCache } from '../../src/sdk/crossPlatform';
import {
  desktopMainPackageLineOffset,
  miniappFrameIteratee,
  rewriteFramesIntegration,
} from '../../src/sdk/integrations/rewriteframes';
import { getDefaultIntegrations } from '../../src/sdk/sdk';

function rewrite(integration: { processEvent?: unknown }, filenames: string[]): string[] {
  const event: Event = {
    exception: {
      values: [{ stacktrace: { frames: filenames.map((filename) => ({ filename })) } }],
    },
  };
  const process = integration.processEvent as (event: Event, hint: object, client: never) => Event;
  const processed = process(event, {}, undefined as never);
  return processed.exception!.values![0]!.stacktrace!.frames!.map(
    (frame: StackFrame) => frame.filename!,
  );
}

const DEVTOOLS =
  'http://127.0.0.1:47848/appservice/getsubpackagebundle_taroMiniapp%2Fpages%2FDetails%2F.js?t=wechat&s=&v=fixture';

describe('rewriteFramesIntegration', () => {
  it('uses the official integration name and is installed by default', () => {
    expect(rewriteFramesIntegration().name).toBe('RewriteFrames');
    expect(Sentry.rewriteFramesIntegration).toBe(rewriteFramesIntegration);
    expect(Sentry.Integrations.rewriteFramesIntegration).toBe(rewriteFramesIntegration);
    expect(getDefaultIntegrations().map((integration) => integration.name)).toContain(
      'RewriteFrames',
    );
  });

  it('names WeChat device frames like the uploaded artifacts', () => {
    expect(
      rewrite(rewriteFramesIntegration(), [
        'https://usr/app-service.js',
        'appservice/app-service.js',
        'app-service/app-service.js',
        'https://usr/packageA/app-service.js',
        'appservice/packageA/app-service.js',
        'https://usr/taroMiniapp/pages/ReplayPoc/index.js',
        'appservice/pages/home/home.js',
      ]),
    ).toEqual([
      'https://usr/app-service.js',
      'https://usr/app-service.js',
      'https://usr/app-service.js',
      'https://usr/packageA/app-service.js',
      'https://usr/packageA/app-service.js',
      'https://usr/taroMiniapp/pages/ReplayPoc/index.js',
      'https://usr/pages/home/home.js',
    ]);
  });

  it('leaves DevTools HTTP frames, base-library frames and unknown paths unchanged', () => {
    const frames = [
      DEVTOOLS,
      'http://127.0.0.1:47848/appservice/app-service.js',
      'WAService.js',
      'app:///pages/index/index.js',
      'pages/index/index.js',
    ];
    expect(rewrite(rewriteFramesIntegration(), frames)).toEqual(frames);
  });

  it('keeps the legacy app:/// names for frozen platforms', () => {
    expect(
      rewrite(rewriteFramesIntegration(), [
        'https://appx/app.js',
        'tt://pages/index/index.js',
        'swan://app.js',
      ]),
    ).toEqual(['app:///app.js', 'app:///pages/index/index.js', 'app:///app.js']);
  });

  it('follows a custom upload prefix with or without a trailing slash', () => {
    for (const prefix of ['https://runtime.example.test', 'https://runtime.example.test/']) {
      expect(
        rewrite(rewriteFramesIntegration({ prefix }), [
          'https://usr/app-service.js',
          'appservice/packageA/app-service.js',
          DEVTOOLS,
        ]),
      ).toEqual([
        'https://runtime.example.test/app-service.js',
        'https://runtime.example.test/packageA/app-service.js',
        DEVTOOLS,
      ]);
    }
  });

  it('replaces root with prefix, as the official browser option does', () => {
    expect(
      rewrite(rewriteFramesIntegration({ root: 'http://127.0.0.1:47848/appservice/' }), [
        'http://127.0.0.1:47848/appservice/app-service.js',
      ]),
    ).toEqual(['https://usr/app-service.js']);
  });

  it('uses a custom iteratee in place of the default', () => {
    const iteratee = (frame: StackFrame) => ({ ...frame, filename: 'custom.js' });
    expect(rewrite(rewriteFramesIntegration({ iteratee }), ['https://usr/a.js'])).toEqual([
      'custom.js',
    ]);
  });

  it('exposes the default iteratee for composition', () => {
    expect(miniappFrameIteratee()({ filename: 'appservice/a.js' }).filename).toBe(
      'https://usr/a.js',
    );
    expect(miniappFrameIteratee()({ function: 'noFile' })).toEqual({ function: 'noFile' });
  });
});

describe('desktop WeChat main-package line correction', () => {
  function host(platform: string, version: string): void {
    const wx = (globalThis as unknown as { wx: Record<string, unknown> }).wx;
    wx['getDeviceInfo'] = () => ({ platform, system: 'synthetic', brand: 'synthetic', model: 'x' });
    wx['getAppBaseInfo'] = () => ({ version, SDKVersion: '3.17.4' });
    resetPlatformCache();
  }

  function capture(frames: StackFrame[], options = {}): Event {
    const event: Event = {
      contexts: { miniapp: { platform: 'wechat' } },
      exception: { values: [{ stacktrace: { frames } }] },
    };
    const integration = rewriteFramesIntegration(options);
    const process = integration.processEvent as (e: Event, h: object, c: never) => Event;
    return process(event, {}, undefined as never);
  }
  const lines = (event: Event) =>
    event.exception!.values![0]!.stacktrace!.frames!.map((frame) => [frame.filename, frame.lineno]);

  // Paired trial events of one build: Android ran the SDK handler at 9187, Mac 4.1.15.55 at 10593.
  it('shifts only main-package frames on a listed Mac client and marks the event', () => {
    host('mac', '4.1.15.55');
    expect(desktopMainPackageLineOffset()).toBe(1406);
    const event = capture([
      { filename: 'https://usr/app-service.js', lineno: 10593, colno: 84273 },
      { filename: 'https://usr/taroMiniapp/pages/ReplayPoc/app-service.js', lineno: 1097 },
      { filename: 'https://lib/WAServiceMainContext.js', lineno: 2 },
      { filename: 'https://usr/app-service.js', lineno: 12 },
    ]);
    expect(lines(event)).toEqual([
      ['https://usr/app-service.js', 9187],
      ['https://usr/taroMiniapp/pages/ReplayPoc/app-service.js', 1097],
      ['https://lib/WAServiceMainContext.js', 2],
      ['https://usr/app-service.js', 12],
    ]);
    expect(event.exception!.values![0]!.stacktrace!.frames![0]!.colno).toBe(84273);
    expect(event.contexts!['miniapp']).toEqual({
      platform: 'wechat',
      main_package_line_offset: 1406,
    });
  });

  it('applies before a custom iteratee', () => {
    host('mac', '4.1.15.55');
    const seen: number[] = [];
    capture([{ filename: 'https://usr/app-service.js', lineno: 10640 }], {
      iteratee: (frame: StackFrame) => (seen.push(frame.lineno!), frame),
    });
    expect(seen).toEqual([9234]);
  });

  it.each([
    ['ios', '8.0.79'],
    ['android', '8.0.78'],
    ['devtools', '4.1.15.55'],
    ['mac', '4.1.16.0'],
    ['windows', '4.1.15.55'],
  ])('leaves %s %s unchanged', (platform, version) => {
    host(platform, version);
    expect(desktopMainPackageLineOffset()).toBeUndefined();
    const event = capture([{ filename: 'https://usr/app-service.js', lineno: 9187 }]);
    expect(lines(event)).toEqual([['https://usr/app-service.js', 9187]]);
    expect(event.contexts!['miniapp']).toEqual({ platform: 'wechat' });
  });
});
