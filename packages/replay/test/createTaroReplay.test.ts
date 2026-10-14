import { describe, expect, test, vi } from 'vite-plus/test';

import { createTaroReplay } from '../src/createTaroReplay';
import { makeRuntime, makeSdk } from './fixtures';

describe('createTaroReplay', () => {
  test('passes only the normalized route static images to the recorder', () => {
    const fixture = makeSdk();
    const staticImageSources = { '/taroMiniapp/logo.png': 'data:image/png;base64,aGVsbG8=' };
    const getReplayImageSources = vi.fn(() => staticImageSources);
    const replay = createTaroReplay({
      sdk: fixture.sdk,
      runtime: { ...makeRuntime(), getReplayImageSources },
    });

    expect(replay.start()).toBe(true);
    expect(getReplayImageSources).toHaveBeenCalledExactlyOnceWith('pages/replay');
    expect(fixture.getStartOptions()?.staticImageSources).toBe(staticImageSources);
  });

  test('keeps recording when the host static image getter is unavailable or fails', () => {
    for (const getReplayImageSources of [
      undefined,
      () => {
        throw new Error('assets unavailable');
      },
    ]) {
      const fixture = makeSdk();
      const onError = vi.fn();
      const replay = createTaroReplay({
        sdk: fixture.sdk,
        runtime: { ...makeRuntime(), ...(getReplayImageSources ? { getReplayImageSources } : {}) },
        onError,
      });

      expect(replay.start()).toBe(true);
      expect(fixture.getStartOptions()).not.toHaveProperty('staticImageSources');
      expect(onError).not.toHaveBeenCalled();
    }
  });

  test('passes the normalized route stylesheet to the recorder', () => {
    const fixture = makeSdk();
    const stylesheet = '.checkout { padding: 24rpx; }';
    const getReplayStyles = vi.fn(() => stylesheet);
    const replay = createTaroReplay({
      sdk: fixture.sdk,
      runtime: { ...makeRuntime(), getReplayStyles },
    });

    expect(replay.start()).toBe(true);
    expect(getReplayStyles).toHaveBeenCalledOnce();
    expect(getReplayStyles).toHaveBeenCalledWith('pages/replay');
    expect(fixture.getStartOptions()).toMatchObject({ stylesheet });
  });

  test('records without stylesheet injection when the runtime has no style getter', () => {
    const fixture = makeSdk();
    const replay = createTaroReplay({ sdk: fixture.sdk, runtime: makeRuntime() });

    expect(replay.start()).toBe(true);
    expect(fixture.getStartOptions()).not.toHaveProperty('stylesheet');
  });

  test('ignores a failing style getter without disrupting recording', () => {
    const fixture = makeSdk();
    const onError = vi.fn();
    const getReplayStyles = vi.fn(() => {
      throw new Error('compiled styles unavailable');
    });
    const replay = createTaroReplay({
      sdk: fixture.sdk,
      runtime: { ...makeRuntime(), getReplayStyles },
      onError,
    });

    expect(replay.start()).toBe(true);
    expect(getReplayStyles).toHaveBeenCalledWith('pages/replay');
    expect(fixture.getStartOptions()).not.toHaveProperty('stylesheet');
    expect(onError).not.toHaveBeenCalled();
  });

  test('starts against the mounted Taro root with safe platform metadata', () => {
    const fixture = makeSdk();
    const runtime = makeRuntime();
    const replay = createTaroReplay({
      sdk: fixture.sdk,
      runtime,
      frameworkVersion: '4.2.0',
      getMetadata: () => ({
        user: { id: 'private-user', email: 'alice@example.test' },
        tags: { token: 'private', cohort: 'synthetic' },
      }),
    });

    expect(replay.start()).toBe(true);
    expect(replay.start()).toBe(true);
    expect(runtime.document.getElementById).toHaveBeenCalledWith('pages/replay?secret=yes');
    expect(fixture.getStartOptions()).toMatchObject({
      href: 'https://miniapp.local/pages/replay',
      width: 390,
      height: 844,
      maskAllText: true,
      maskInputValues: true,
      metadata: {
        environment: 'staging',
        release: 'app@2.3.4',
        tags: {
          'replay.adapter': 'taro',
          'miniapp.platform': 'wechat',
          'page.route': 'pages/replay',
          'taro.version': '4.2.0',
          'miniapp.env_version': 'develop',
          'miniapp.version': '2.3.4',
          'miniapp.base_library': '3.6.2',
          token: '[Filtered]',
          cohort: 'synthetic',
        },
      },
    });
    expect(fixture.getStartOptions().metadata?.user).toBeUndefined();
    expect(replay.getController()?.replayId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('sanitizes SDK breadcrumbs before adding them to the recorder', () => {
    const fixture = makeSdk();
    const replay = createTaroReplay({ sdk: fixture.sdk, runtime: makeRuntime() });
    replay.start();

    fixture.emitBreadcrumb({
      category: 'fetch',
      message: 'Alice profile',
      data: {
        url: 'https://example.test/profile?token=private',
        headers: { Authorization: 'Bearer private' },
        status_code: 200,
      },
    });

    expect(fixture.addRecordedBreadcrumb).toHaveBeenLastCalledWith({
      category: 'fetch',
      message: '[Filtered]',
      data: {
        url: 'https://example.test/profile',
        headers: '[Filtered]',
        status_code: 200,
      },
    });
  });

  test('finalizes and sends exactly once through Client.sendEnvelope', async () => {
    const fixture = makeSdk();
    const onCapture = vi.fn();
    const replay = createTaroReplay({
      sdk: fixture.sdk,
      runtime: makeRuntime(),
      onCapture,
    });
    replay.start();

    const first = await replay.stop('manual');
    const second = await replay.stop('manual');

    expect(first?.stopReason).toBe('manual');
    expect(second?.replayId).toBe(first?.replayId);
    expect(onCapture).toHaveBeenCalledTimes(1);
    expect(fixture.sendEnvelope).toHaveBeenCalledTimes(1);
    expect(fixture.getDetachCount()).toBe(1);
  });

  test('does not send page-unload captures unless explicitly enabled', async () => {
    const fixture = makeSdk();
    const replay = createTaroReplay({ sdk: fixture.sdk, runtime: makeRuntime() });
    replay.start();
    replay.dispose();
    await replay.stop();

    expect(fixture.sendEnvelope).not.toHaveBeenCalled();
    expect(replay.getController()?.getCapture().stopReason).toBe('page-unload');
  });

  test('reports a missing mounted root without throwing from lifecycle hooks', () => {
    const fixture = makeSdk();
    const onError = vi.fn();
    const replay = createTaroReplay({
      sdk: fixture.sdk,
      runtime: makeRuntime(null),
      onError,
    });

    expect(replay.start()).toBe(false);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('Mounted Taro root not found') }),
    );
    expect(fixture.sendEnvelope).not.toHaveBeenCalled();
  });

  test('only includes an explicitly allowed, sanitized custom user', () => {
    const fixture = makeSdk();
    const replay = createTaroReplay({
      sdk: fixture.sdk,
      runtime: makeRuntime(),
      privacy: { allowUser: true },
      getMetadata: () => ({
        user: { id: 'anonymous-42', email: 'alice@example.test' },
      }),
    });
    replay.start();

    expect(fixture.getStartOptions().metadata?.user).toEqual({
      id: 'anonymous-42',
      email: '[Filtered]',
    });
  });
  test('uses actual OS/device and WeChat versions rather than confusing app and OS versions', () => {
    const f = makeSdk();
    const replay = createTaroReplay({
      sdk: f.sdk,
      runtime: {
        ...makeRuntime(),
        getDeviceInfo: () => ({
          brand: 'Apple',
          model: 'iPhone 16',
          system: 'iOS 18.3',
          platform: 'ios',
        }),
        getAppBaseInfo: () => ({ version: '8.0.79', SDKVersion: '3.6.2', language: 'zh_CN' }),
      },
      privacy: {
        maskAllInputs: true,
        maskInputValues: false,
        blockAllMedia: false,
        maskAttributes: ['title'],
      },
    });
    replay.start();
    expect(f.getStartOptions()).toMatchObject({
      maskInputValues: true,
      maskAllInputs: true,
      blockAllMedia: false,
      maskAttributes: ['title'],
      metadata: {
        contexts: {
          os: { name: 'iOS', version: '18.3' },
          browser: { name: 'WeChat', version: '8.0.79' },
          device: { brand: 'Apple', model: 'iPhone 16' },
        },
      },
    });
    replay.dispose();
  });
});
