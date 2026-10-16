import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { Event, type StackFrame } from '@sentry/core';
import * as Sentry from '../../src/sdk/index';
import {
  RewriteFrames,
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

  it('is omitted when the deprecated enableSourceMap is false', () => {
    expect(
      getDefaultIntegrations({ enableSourceMap: false }).map((integration) => integration.name),
    ).not.toContain('RewriteFrames');
  });
});

describe('deprecated RewriteFrames class', () => {
  let rewriteFrames: RewriteFrames;

  beforeEach(() => {
    rewriteFrames = new RewriteFrames();
  });

  it('should normalize wechat appservice path', () => {
    const event: Event = {
      exception: {
        values: [
          {
            stacktrace: {
              frames: [
                { filename: 'appservice/pages/index/index.js' },
                { filename: 'app-service/app.js' },
                { filename: 'WAService.js' },
              ],
            },
          },
        ],
      },
    };

    const processed = rewriteFrames.processEvent(event);
    const frames = (processed.exception!.values as any)[0].stacktrace.frames;

    expect(frames[0].filename).toBe('app:///pages/index/index.js');
    expect(frames[1].filename).toBe('app:///app.js');
    expect(frames[2].filename).toBe('app:///WAService.js');
  });

  it('should normalize alipay and bytedance paths', () => {
    const event: Event = {
      exception: {
        values: [
          {
            stacktrace: {
              frames: [
                { filename: 'https://appx/app.js' },
                { filename: 'tt://pages/index/index.js' },
                { filename: 'swan://app.js' },
              ],
            },
          },
        ],
      },
    };

    const processed = rewriteFrames.processEvent(event);
    const frames = (processed.exception!.values as any)[0].stacktrace.frames;

    expect(frames[0].filename).toBe('app:///app.js');
    expect(frames[1].filename).toBe('app:///pages/index/index.js');
    expect(frames[2].filename).toBe('app:///app.js');
  });

  it('should prevent double prefixing', () => {
    const event: Event = {
      exception: {
        values: [
          {
            stacktrace: {
              frames: [{ filename: 'app:///pages/index/index.js' }],
            },
          },
        ],
      },
    };

    const processed = rewriteFrames.processEvent(event);
    const frames = (processed.exception!.values as any)[0].stacktrace.frames;

    expect(frames[0].filename).toBe('app:///pages/index/index.js');
  });

  it('should not throw if frames or exception is missing', () => {
    const event: Event = {
      message: 'test',
    };

    const processed = rewriteFrames.processEvent(event);
    expect(processed.message).toBe('test');
  });
});
