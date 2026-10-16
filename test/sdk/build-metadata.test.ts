import { getClient } from '@sentry/core';
import { afterEach, describe, expect, test, vi } from 'vite-plus/test';
import { applyBuildMetadataDefaults } from '../../src/sdk/build-metadata';
import { init } from '../../src/sdk/sdk';
import type { MiniappOptions } from '../../src/sdk/types';

afterEach(async () => {
  await getClient()?.close(0);
  vi.unstubAllGlobals();
});

describe('Taro build metadata defaults', () => {
  test('keeps the same options without plugin injection, without creating a runtime global', () => {
    const options: MiniappOptions = { dsn: 'https://example@sentry.invalid/1' };
    expect(applyBuildMetadataDefaults(options)).toBe(options);
    expect(options).not.toHaveProperty('release');
    expect(options).not.toHaveProperty('dist');
    expect(Object.prototype.hasOwnProperty.call(globalThis, '__SENTRY_TARO_BUILD__')).toBe(false);
  });

  test('uses injected values independently and does not mutate caller options', () => {
    vi.stubGlobal('__SENTRY_TARO_BUILD__', { release: 'example@build-1', dist: 'upload-1' });
    const options = Object.freeze({ dsn: 'https://example@sentry.invalid/1' });
    expect(applyBuildMetadataDefaults(options)).toEqual({
      dsn: options.dsn,
      release: 'example@build-1',
      dist: 'upload-1',
    });
    expect(options).not.toHaveProperty('release');
    expect(options).not.toHaveProperty('dist');
  });

  test('explicit init values, including empty strings, take precedence', () => {
    vi.stubGlobal('__SENTRY_TARO_BUILD__', { release: 'example@build-1', dist: 'upload-1' });
    const options = { release: 'custom-release', dist: '' };
    expect(applyBuildMetadataDefaults(options)).toBe(options);
    expect(applyBuildMetadataDefaults({ release: '' })).toEqual({ release: '', dist: 'upload-1' });
    expect(applyBuildMetadataDefaults({ dist: 'custom-dist' })).toEqual({
      release: 'example@build-1',
      dist: 'custom-dist',
    });
  });

  test('explicit undefined retains normal defaulting semantics', () => {
    vi.stubGlobal('__SENTRY_TARO_BUILD__', { release: 'example@build-1', dist: 'upload-1' });
    const options: MiniappOptions = {};
    Object.defineProperties(options, {
      release: { value: undefined, enumerable: true },
      dist: { value: undefined, enumerable: true },
    });
    expect(applyBuildMetadataDefaults(options)).toEqual({
      release: 'example@build-1',
      dist: 'upload-1',
    });
  });

  test.each([null, undefined, false, 'build-1', {}, { release: 42, dist: false }])(
    'ignores absent or invalid injected fields without creating option keys: %j',
    (metadata) => {
      vi.stubGlobal('__SENTRY_TARO_BUILD__', metadata);
      const options = {};
      expect(applyBuildMetadataDefaults(options)).toBe(options);
    },
  );

  test('does not invent a dist when only a release was injected', () => {
    vi.stubGlobal('__SENTRY_TARO_BUILD__', { release: 'example@build-1' });
    expect(applyBuildMetadataDefaults({})).toEqual({ release: 'example@build-1' });
  });

  test('init passes injected release and dist into the client', () => {
    vi.stubGlobal('__SENTRY_TARO_BUILD__', { release: 'example@build-1', dist: 'upload-1' });
    const client = init({
      dsn: 'https://example@sentry.invalid/1',
      defaultIntegrations: [],
      enableOfflineCache: false,
      transport: () => ({ send: async () => ({ statusCode: 200 }), flush: async () => true }),
    });
    expect(client?.getOptions()).toMatchObject({ release: 'example@build-1', dist: 'upload-1' });
  });

  test('init keeps native-host metadata overrides and leaves unspecified fields absent without a plugin', () => {
    const native = init({
      release: 'native-release',
      dist: 'native-dist',
      defaultIntegrations: [],
    });
    expect(native?.getOptions()).toMatchObject({ release: 'native-release', dist: 'native-dist' });
    const unconfigured = init({ defaultIntegrations: [] });
    expect(unconfigured?.getOptions()).not.toHaveProperty('release');
    expect(unconfigured?.getOptions()).not.toHaveProperty('dist');
  });
});
