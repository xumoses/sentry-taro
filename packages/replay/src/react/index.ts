import { document, MutationObserver } from '@tarojs/runtime';
import Taro, { useDidHide, useReady, useUnload } from '@tarojs/taro';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createTaroReplay } from '../createTaroReplay';
import type {
  TaroReplayCapture,
  TaroReplayHandle,
  TaroReplayRuntime,
  TaroReplayState,
  UseTaroReplayOptions,
  UseTaroReplayResult,
} from '../types';

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function createRuntime(): TaroReplayRuntime {
  const taro = Taro as unknown as {
    getCurrentInstance(): ReturnType<TaroReplayRuntime['getCurrentInstance']>;
    getWindowInfo?(): ReturnType<NonNullable<TaroReplayRuntime['getWindowInfo']>>;
    getSystemInfoSync?(): { windowWidth?: number; windowHeight?: number };
    getEnv?(): string;
    getAccountInfoSync?(): ReturnType<NonNullable<TaroReplayRuntime['getAccountInfoSync']>>;
    getAppBaseInfo?(): ReturnType<NonNullable<TaroReplayRuntime['getAppBaseInfo']>>;
    getDeviceInfo?(): ReturnType<NonNullable<TaroReplayRuntime['getDeviceInfo']>>;
  };

  return {
    document,
    MutationObserver: MutationObserver as unknown as TaroReplayRuntime['MutationObserver'],
    getCurrentInstance: () => taro.getCurrentInstance(),
    getWindowInfo: () => taro.getWindowInfo?.() || taro.getSystemInfoSync?.() || {},
    getEnv: () => taro.getEnv?.() || 'unknown',
    getAccountInfoSync: () => taro.getAccountInfoSync?.() || {},
    getAppBaseInfo: () => taro.getAppBaseInfo?.() || {},
    getDeviceInfo: () => taro.getDeviceInfo?.() || {},
  };
}

/**
 * Starts after Taro mounts the page root (`useReady`) and stops synchronously
 * during hide/unload. This low-level one-shot API does not resume; use the root
 * bridge or lifecycle adapter for continuous sessions.
 */
export function useTaroReplay(options: UseTaroReplayOptions): UseTaroReplayResult {
  const [state, setState] = useState<TaroReplayState>('idle');
  const [error, setError] = useState<Error>();
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const handleRef = useRef<TaroReplayHandle>();

  if (!handleRef.current) {
    handleRef.current = createTaroReplay({
      ...options,
      runtime: createRuntime(),
      onCapture: async (capture: TaroReplayCapture) => {
        setState('stopped');
        await optionsRef.current.onCapture?.(capture);
      },
      onError: (cause: unknown) => {
        const nextError = toError(cause);
        setError(nextError);
        optionsRef.current.onError?.(cause);
      },
    });
  }

  const start = useCallback((): boolean => {
    setError(undefined);
    const started = handleRef.current?.start() === true;
    setState(started ? 'recording' : 'stopped');
    return started;
  }, []);

  const stop = useCallback(async (reason?: string) => {
    try {
      const capture = await handleRef.current?.stop(reason);
      setState('stopped');
      return capture;
    } catch (cause) {
      setError(toError(cause));
      setState('stopped');
      throw cause;
    }
  }, []);

  const getController = useCallback(() => handleRef.current?.getController(), []);
  const dispose = useCallback(() => {
    handleRef.current?.dispose();
  }, []);

  useReady(start);
  useDidHide(dispose);
  useUnload(dispose);
  useEffect(() => dispose, [dispose]);

  return useMemo(
    () => ({ start, stop, getController, dispose, state, error }),
    [dispose, error, getController, start, state, stop],
  );
}

export { useTaroReplayRoot, useTaroReplaySnapshot } from './root';
export type { UseTaroReplayRootOptions } from './root';

export type { UseTaroReplayOptions, UseTaroReplayResult } from '../types';
export type { ReplayCoordinatorSnapshot, TaroReplayBridge } from '../coordinator/types';
