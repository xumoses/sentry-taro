# Session Replay

Replay records the Taro runtime DOM (structure, mutations, interactions, scroll, viewport) and links it to errors. It is opt-in, beta, and limited to Taro 4.2 + React 18 + WeChat. It is not a pixel video: native component internals, computed browser styles, and final view-layer timing are not captured.

## 1. Add the integration

Extend the existing init module (`src/sentry.ts`):

```ts
import * as Sentry from '@xumoses/sentry-taro';

export const replay = Sentry.replayIntegration();

Sentry.init({
  dsn: 'https://PUBLIC_KEY@YOUR_SENTRY_HOST/PROJECT_ID',
  sendDefaultPii: false,
  traceNetworkBody: false,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 1,
  integrations: [replay],
});

export { Sentry };
```

- `replayIntegration()` uses this package's SDK automatically; do not pass `sdk`.
- `taroReplayIntegration` is a compatibility alias of `replayIntegration`.
- The integration is registered under the name `Replay`; get it anywhere with `Sentry.getReplay()` (returns `undefined` if not registered).

## 2. Attach pages (required)

Preferred: install the global lifecycle adapter once in the app entry, **before pages are created**:

```tsx
// src/app.tsx
import type { PropsWithChildren } from 'react';
import { installTaroReplayPageLifecycle } from '@xumoses/sentry-taro/taro/lifecycle';
import { replay } from './sentry';

installTaroReplayPageLifecycle({ bridge: replay.bridge });

export default function App({ children }: PropsWithChildren) {
  return children;
}
```

Keep the app's existing `App` component; only add the import and the call.

Alternative, per page (do not combine with the global adapter on the same page):

```tsx
import { useTaroReplayRoot } from '@xumoses/sentry-taro/react/root';
import { replay } from '../../sentry';

export default function CheckoutPage() {
  const snapshot = useTaroReplayRoot({ bridge: replay.bridge });
  // ...
}
```

Status-only display (no lifecycle ownership): `useTaroReplaySnapshot({ bridge: replay.bridge })` from `/react/root`.

`useTaroReplay` from `@xumoses/sentry-taro/react` is a low-level one-shot recorder that does not resume after hide/unload — don't use it for normal sessions.

## 3. Sampling

| `replaysSessionSampleRate` | `replaysOnErrorSampleRate` | Behavior                                                             |
| -------------------------- | -------------------------- | -------------------------------------------------------------------- |
| `0`                        | `1`                        | Buffer locally; upload only when an error is captured. Good default. |
| `0.1`                      | `1`                        | ~10% full sessions; the rest keep an error buffer.                   |
| `0`                        | `0`                        | No automatic recording; manual `start()` still works.                |

Both default to off when omitted. `beforeErrorSampling(event)` returning `false` prevents that error from promoting the buffer. The error buffer keeps up to ~60 s, bounded by event/byte budgets (default 500 events, 512 KiB).

## 4. Privacy

Defaults: `maskAllText: true`, `maskAllInputs: true`, `blockAllMedia: true`. Use these top-level options, plus `maskAttributes` for attribute names to mask. Replay events carry the scope user (`Sentry.setUser`) at send time, as official Replay does; clear it on logout. The legacy `privacy.*` object was removed in `0.1.0-rc.1` and is silently ignored, so any loosened setting left there reverts to the masked default. Password inputs are always masked.

Local markers (class or `data-` attribute; they apply to descendants; mask beats unmask):

```tsx
<Text className="sentry-unmask">Help center</Text>     {/* static copy only */}
<View className="sentry-mask">…</View>
<View className="sentry-block">…</View>                {/* placeholder only */}
<Image className="sentry-unblock" src={staticLogo} />  {/* query/fragment still stripped */}
```

`data-sentry-unmask`, `data-sentry-mask`, `data-sentry-block`, `data-sentry-unblock` also work. Never unmask user-generated content. Turning `maskAllText: false` globally is only acceptable for synthetic demo pages — warn the user if they ask for it.

Canvas is off by default; it needs `recordCanvas: true`, a unique `id` plus `data-sentry-canvas` on the node, and a host-supplied frame reader via `replay.bridge.recordCanvas?.(id, () => dataUri)`. Pixels cannot be masked — only enable for approved charts.

Optional network headers for Replay (off by default) — pass the same policy to `init` and `replayIntegration`:

```ts
const networkDetails = {
  networkDetailAllowUrls: [/^https:\/\/api\.example\.com\//],
  networkRequestHeaders: ['x-request-id'],
  networkResponseHeaders: ['x-request-id'],
};
```

Credential-like headers are always excluded; bodies are never recorded.

## 5. Styles and images

The package does not read app CSS or images at runtime, so playback without assets shows structure only. Use the build plugin (`build-plugin.md`) to generate `replay-assets.json`, then:

```ts
import { createReplayAssetProviders } from '@xumoses/sentry-taro';
import { installTaroReplayPageLifecycle } from '@xumoses/sentry-taro/taro/lifecycle';
import { replay } from './sentry';

const assets = createReplayAssetProviders({
  readAssetFile: () =>
    wx.getFileSystemManager().readFileSync('replay-assets.json', 'utf8') as string,
  readPackagedImage: (path) => wx.getFileSystemManager().readFileSync(path, 'base64') as string,
});

installTaroReplayPageLifecycle({ bridge: replay.bridge, ...assets });
```

Never statically `import` `replay-assets.json` — it exists only after the build finishes. Custom builds may instead pass synchronous `getReplayStyles(route)` / `getReplayImageSources(route)` callbacks (`route` has no leading `/`, query, or fragment).

## 6. Worker compression (optional)

Without `compression`, segments are sent uncompressed. To enable:

1. Copy the Worker into the final mini-program output as `workers/sentry-replay.js` — preferably via the build plugin option `replay: { worker: {} }` (see `build-plugin.md`). Keep `fflate.LICENSE` next to it when copying manually from `require.resolve('@xumoses/sentry-taro/worker')`.
2. Declare the directory in `src/app.config.ts`: `workers: 'workers'`.
3. Configure the integration:

```ts
export const replay = Sentry.replayIntegration({
  compression: { workerPath: 'workers/sentry-replay.js' },
});
```

`workerPath` is relative to the final mini-program root. Failures fall back to uncompressed delivery.

## 7. Manual control

```ts
const r = Sentry.getReplay();
r?.start(); // start a session
r?.startBuffering(); // start an error buffer
await r?.flush(); // send segment / promote buffer, keep recording
await r?.flush({ continueRecording: false }); // send buffer then stop recorder
await r?.stop(); // stop; buffer discarded
await r?.stop({ flush: true }); // stop and try to send remaining data
r?.getReplayId();
r?.getRecordingMode(); // 'session' | 'buffer' | undefined
```

- Order for "send everything now": `await Sentry.getReplay()?.flush(); await Sentry.flush(2000);`
- Recordings shorter than `minReplayDuration` (default 4,999 ms, configurable 0–50,000) are deferred by `flush()` and dropped by `stop()`.
- `replay.bridge.flush()` (legacy) only sends session segments; `replay.bridge.sendBufferedReplay()` sends a buffer. Prefer the integration methods.
- Call `replay.bridge.reset()` before logging a user out to discard the current capture.
- Control methods never reject on transport errors; use the `onError` option or `replay.bridge.getSnapshot().delivery`.

Session defaults: max 60 min (`maxReplayDuration`), idle pause 5 min (`sessionIdlePauseMs`), expiry 15 min (`sessionIdleExpireMs`).

## Troubleshooting

| Symptom                                 | Check                                                                                        |
| --------------------------------------- | -------------------------------------------------------------------------------------------- |
| Errors arrive, no replay                | Integration registered? Sample rates set? Lifecycle installed before pages? Recording > 5 s? |
| `Sentry.flush()` but no replay          | Call `Sentry.getReplay()?.flush()` first.                                                    |
| Text / images blank in playback         | Expected masking. Unmask only verified static content.                                       |
| Layout or images differ from the device | Provide build-time assets (plugin); native controls/fonts can still differ.                  |
| Recording stops after navigating back   | Using one-shot `useTaroReplay`, or `stop()` was called earlier.                              |
| Nothing from a hybrid native page       | Native pages have no Taro DOM; only Taro pages record.                                       |

Local inspection of capture JSON (not real playback): `pnpm dlx --package=@xumoses/sentry-taro@beta sentry-taro-viewer` → `http://127.0.0.1:4178`. Final playback is verified in Sentry.
