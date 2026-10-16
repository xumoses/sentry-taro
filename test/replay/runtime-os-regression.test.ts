import { afterEach, describe, expect, test, vi } from 'vite-plus/test';
import { resetPlatformCache } from '../../src/sdk/crossPlatform';
import { createRuntimeContextProvider } from '../../src/sdk/runtime-contexts';

afterEach(() => {
  vi.unstubAllGlobals();
  resetPlatformCache();
});

async function readSyntheticSystem(platform: string, system: string) {
  vi.stubGlobal('wx', {
    getDeviceInfo: () => ({ platform, system, model: 'Synthetic device' }),
    getAppBaseInfo: () => ({ version: '8.0.0', SDKVersion: '3.0.0' }),
    getWindowInfo: () => ({ screenWidth: 390, screenHeight: 844 }),
  });
  resetPlatformCache();
  return createRuntimeContextProvider(true)();
}

describe('synthetic mini-program OS metadata regression', () => {
  test.each([
    { platform: 'mac', system: 'macOS 15.4.1 arm64', name: 'macOS', version: '15.4.1' },
    { platform: 'mac', system: 'macOS 15.4.1 x86_64', name: 'macOS', version: '15.4.1' },
    { platform: 'windows', system: 'Windows 11 x64', name: 'Windows', version: '11' },
    { platform: 'windows', system: 'Windows 10 x86', name: 'Windows', version: '10' },
    { platform: 'android', system: 'Android 15 aarch64', name: 'Android', version: '15' },
    { platform: 'android', system: 'Android 15 ARM64', name: 'Android', version: '15' },
    { platform: 'ios', system: 'iOS 18.1', name: 'iOS', version: '18.1' },
    { platform: 'mac', system: 'macOS 15.4.1', name: 'macOS', version: '15.4.1' },
    { platform: 'windows', system: 'Windows 11', name: 'Windows', version: '11' },
    { platform: 'android', system: 'Android 15', name: 'Android', version: '15' },
  ])('separates OS name and version for $system', async ({ platform, system, name, version }) => {
    const contexts = await readSyntheticSystem(platform, system);

    expect(contexts.os).toEqual({ name, version });
    expect(contexts.device?.system).toBe(system);
    // Real-device architecture collection remains unchanged; only OS parsing is repaired.
    expect(contexts.device).not.toHaveProperty('arch');
  });

  test.each([
    'unknown',
    'macOS 15.4.1 preview',
    'macOS 15.4.1 arm64 preview',
    'macOS 15.4.1 riscv64',
    'SyntheticOS arm64',
    'SyntheticOS x86_64',
  ])('preserves the complete unknown system string %s', async (system) => {
    const contexts = await readSyntheticSystem('mac', system);

    expect(contexts.os).toEqual({ name: system });
    expect(contexts.device?.system).toBe(system);
  });
});
