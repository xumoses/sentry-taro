import { describe, expect, test } from 'vite-plus/test';
import type { StackFrame } from '@sentry/core';
import { MiniappClient } from '../../src/sdk/client';
import { miniappStackParser } from '../../src/sdk/stacktrace';
import { miniappFrameIteratee } from '../../src/sdk/integrations/rewriteframes';

const client = new MiniappClient({
  dsn: 'https://public@ingest.example.test/1',
  transport: () => ({ send: async () => ({}), flush: async () => true }),
  stackParser: miniappStackParser,
  integrations: [],
});

async function frames(stack: string): Promise<string[]> {
  const error = new Error('synthetic');
  error.stack = stack;
  const event = await client.eventFromException(error);
  return (event.exception!.values![0]!.stacktrace?.frames ?? []).map(
    (frame: StackFrame) => `${frame.function}@${frame.filename}:${frame.lineno}:${frame.colno}`,
  );
}

describe('captured stack frames', () => {
  test('keeps the throwing frame of an iOS JavaScriptCore stack', async () => {
    expect(
      await frames(
        'swapProbe@https://usr/taroMiniapp/pages/Swap/app-service.js:9:1\n' +
          'refresh@https://usr/taroMiniapp/pages/Swap/app-service.js:3:7',
      ),
    ).toEqual([
      'refresh@https://usr/taroMiniapp/pages/Swap/app-service.js:3:7',
      'swapProbe@https://usr/taroMiniapp/pages/Swap/app-service.js:9:1',
    ]);
  });

  test('does not turn a V8 message header into a frame', async () => {
    expect(
      await frames(
        'Error: controlled\n    at navigate (https://usr/app-service.js:17:1)\n' +
          '    at optionProbe (https://usr/taroMiniapp/pages/Option4Fund/app-service.js:123:45)',
      ),
    ).toEqual([
      'optionProbe@https://usr/taroMiniapp/pages/Option4Fund/app-service.js:123:45',
      'navigate@https://usr/app-service.js:17:1',
    ]);
  });

  test('parses frames from a wx.onError message used as the stack', async () => {
    const message =
      'Error: swap controlled\n    at swapProbe (https://usr/taroMiniapp/pages/Swap/app-service.js:30:9)\n' +
      '    at refresh (https://usr/taroMiniapp/pages/Swap/app-service.js:20:1)';
    expect(await frames(message)).toEqual([
      'refresh@https://usr/taroMiniapp/pages/Swap/app-service.js:20:1',
      'swapProbe@https://usr/taroMiniapp/pages/Swap/app-service.js:30:9',
    ]);
  });
});

describe('WeChat package frame names', () => {
  test.each([
    [
      'https://usr//taroMiniapp/pages/Option4Fund/app-service.js',
      'https://usr/taroMiniapp/pages/Option4Fund/app-service.js',
    ],
    ['https://usr//app-service.js', 'https://usr/app-service.js'],
    ['http://usr//app-service.js', 'https://usr/app-service.js'],
  ])('names %s like the upload', (filename, expected) => {
    expect(miniappFrameIteratee()({ filename }).filename).toBe(expected);
  });
});
