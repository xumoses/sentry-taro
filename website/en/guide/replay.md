# Session Replay

Session Replay links Taro page structure, interactions and errors so you can see how the page changed around a problem. It is opt-in; if you only use error monitoring, you don't need the integration or page lifecycle below.

It currently targets **Taro 4.2.x, React 18 and WeChat mini programs**. Recording is based on the Taro runtime DOM. It is not a screen video and does not cover everything browser Replay does. Delivery and playback verified in DevTools do not replace validation on devices.

## 1. Initialize Replay

Initialize the SDK only once per app. The configuration below disables regular session sampling and sends the buffered recording when an error occurs, which is good for verifying the setup; tune sample rates to your traffic before going live.

```ts
// src/sentry.ts
import * as Sentry from '@xumoses/sentry-taro';

export const replay = Sentry.replayIntegration({
  maskAllText: true,
  maskAllInputs: true,
  blockAllMedia: true,
});

Sentry.init({
  dsn: 'https://PUBLIC_KEY@YOUR_SENTRY_HOST/PROJECT_ID',
  environment: 'production',
  sendDefaultPii: false,
  traceNetworkBody: false,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 1,
  integrations: [replay],
});

export { Sentry };
```

`replayIntegration()` uses this package's SDK automatically and works alongside the default error-monitoring integrations. After initializing the integration you still need to attach pages before the Taro DOM is captured.

## 2. Attach the page lifecycle

Call `installTaroReplayPageLifecycle` once in the Taro app entry, before any page is created:

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

The adapter attaches the current visible root on page ready/show, releases it on hide/unload, and records page scrolling and viewport changes. Switching pages and sending segments do not create a new Replay identity.

Use `useTaroReplaySnapshot` only on pages that display diagnostic state. The hook only subscribes to state; it does not manage the page lifecycle:

```tsx
import { Button, Text, View } from '@tarojs/components';
import { useTaroReplaySnapshot } from '@xumoses/sentry-taro/react/root';
import { replay, Sentry } from '../../sentry';

export default function ExamplePage() {
  const snapshot = useTaroReplaySnapshot({ bridge: replay.bridge });

  return (
    <View>
      <Text>Replay: {snapshot.state}</Text>
      <Button onClick={() => Sentry.captureException(new Error('synthetic example error'))}>
        Trigger a test error
      </Button>
    </View>
  );
}
```

If per-page attachment suits your app better, call this in each page component that should be recorded:

```tsx
import { Text } from '@tarojs/components';
import { useTaroReplayRoot } from '@xumoses/sentry-taro/react/root';
import { replay } from '../../sentry';

export default function ExamplePage() {
  const snapshot = useTaroReplayRoot({ bridge: replay.bridge });
  return <Text>Replay: {snapshot.state}</Text>;
}
```

`useTaroReplayRoot` manages the page lifecycle and subscribes to state. Pick one lifecycle owner per page so it is not attached twice by the global adapter. To provide page styles and static images through callbacks, use the global adapter; see [styles and images](./hybrid-apps#provide-page-styles-and-static-images).

`useTaroReplay` from `@xumoses/sentry-taro/react` is a low-level single-recording API and does not resume after page hide/unload. For continuous sessions use the lifecycle adapter or `useTaroReplayRoot` above.

## 3. Choose sampling

Both sample rates range from `0` to `1`; when omitted, nothing is recorded automatically.

| Option                     | Behavior                                                                                                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `replaysSessionSampleRate` | Selects a share of sessions, records them and sends segments periodically                                                                                                                 |
| `replaysOnErrorSampleRate` | When above `0`, keeps a local rolling buffer for pages not selected as regular sessions and decides at this rate whether to upload when an error occurs; `0` disables automatic buffering |
| Both `0`                   | Automatic sampling is off; you can still start recording manually                                                                                                                         |

For example, `0` / `1` sends only on errors; `0.1` / `1` records about 10% of sessions as regular sessions and keeps an error buffer for the rest. Recording continues after a buffer is uploaded. Configure `beforeErrorSampling(event)` on `replayIntegration` and return `false` to prevent that error from triggering a buffer upload; see [ReplayCoordinatorOptions](https://github.com/xumoses/sentry-taro/blob/main/src/replay/coordinator/types.ts) for the definition.

The default pre-error window is **60 seconds**. Event-count and byte budgets may make the retained window shorter, so a full 60 seconds is not guaranteed for every error.

## 4. Configure privacy

Text and input values are masked and media is blocked by default. Adjust them with the top-level `maskAllText`, `maskAllInputs` and `blockAllMedia`, and list attribute names to mask in `maskAttributes`; the `privacy.*` object is no longer accepted since `0.1.0-rc.1`. As in official Replay, recordings carry the user set with `Sentry.setUser` when they are sent; call `Sentry.setUser(null)` on logout. Password inputs and inputs explicitly marked for masking always stay masked.

You can use local markers for static copy that clearly contains no user data while still protecting sensitive regions:

```tsx
<View>
  <Text className="sentry-unmask">Help center</Text>
  <View className="sentry-mask">Content to mask</View>
  <View className="sentry-block">Region whose content is not captured</View>
</View>
```

The equivalent `data-sentry-unmask`, `data-sentry-mask` and `data-sentry-block` markers also work. Markers apply to descendants; mask markers win over unmask, and blocked regions keep only a placeholder node. `sentry-unmask` does not override the global masking policy for input values.

Media can be allowed locally with `sentry-unblock` / `data-sentry-unblock`, but URLs still have query strings and fragments removed. A trusted static image map provided at build time is another per-image allowance and may show images even with `blockAllMedia: true`; see [static assets](./hybrid-apps#provide-page-styles-and-static-images). Never put user uploads or runtime screenshots in that map.

Canvas is off by default. Enabling it also requires explicit node markers and a frame reader. Pixels cannot be handled by text-masking rules. For custom integrations, see the [TaroReplayBridge.recordCanvas type](https://github.com/xumoses/sentry-taro/blob/main/src/replay/coordinator/types.ts) and the [synthetic Canvas test](https://github.com/xumoses/sentry-taro/blob/main/test/replay/canvas.test.ts).

Replay masking does not filter every SDK event field. Keep sensitive content out of error messages, manually added context and logs as well; the examples keep `sendDefaultPii: false` and `traceNetworkBody: false`. Review recordings and events from a synthetic scenario before deciding to loosen the default privacy settings.

## 5. Manual control and sending

`Sentry.getReplay()` returns the Replay integration registered on the current client, or `undefined` if none is registered. You can also use the `replay` object saved during initialization.

```ts
// Manual start works even when both automatic sample rates are 0.
Sentry.getReplay()?.start();

// To send the current recording, handle Replay first, then wait for SDK transport.
await Sentry.getReplay()?.flush();
await Sentry.flush(2000);

// After stopping, showing the page again does not restart recording.
await Sentry.getReplay()?.stop();
```

| Method                                       | Behavior                                                                                                               |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `replay.start()`                             | Starts a session; does not create a new identity if already recording                                                  |
| `replay.startBuffering()`                    | Starts local buffering; does not switch modes if already recording                                                     |
| `replay.flush()`                             | Session sends current segments; buffer sends and continues as a session by default; tries to start a session when idle |
| `replay.flush({ continueRecording: false })` | Sends the buffer and stops the recorder, keeping the identity; see the [API reference](./api) for full state semantics |
| `replay.stop()`                              | Sends remaining session data by default and discards an unsent buffer                                                  |
| `replay.stop({ flush: true })`               | Also tries to send the buffer before stopping, still subject to the minimum duration                                   |
| `replay.bridge.flush()`                      | Compatibility entry that only sends session segments                                                                   |
| `replay.bridge.sendBufferedReplay()`         | Compatibility entry that explicitly sends a buffer                                                                     |
| `Sentry.flush(timeout)`                      | Waits for SDK transport; does not cut or send data held in the Replay recorder                                         |

`continueRecording: false` only affects buffers; session mode ignores it and keeps recording. Use `stop()` to stop a session.

The default minimum send duration is **4,999 ms**, adjustable with `minReplayDuration` between `0` and `50,000` ms. Before a recording reaches it, `replay.flush()` schedules a delayed send and resolves immediately; a following `Sentry.flush()` cannot bypass the threshold. An explicit `stop()` discards data that has not reached the minimum duration.

A resolved `flush()` does not mean the service has ingested the replay or that it can play back. The integration's direct control methods never throw delivery errors to the caller; diagnose with `onError`, state snapshots and what actually arrives on the server. Without a visible Taro page, even a manual start cannot capture page DOM.

## Session and resource limits

| Item                                  | Default behavior                                                                             |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| Maximum length of a sent replay       | 60 minutes; shorten with `maxReplayDuration`                                                 |
| Regular session without user activity | Recording pauses after 5 minutes and expires after 15; later activity resamples              |
| Unsent error buffer                   | Keeps a bounded rolling window; does not expire by identity age or inactivity                |
| After an error buffer is sent         | Not subject to the regular session's 5-minute idle pause; still bound by duration and expiry |
| Recording buffer                      | Up to 500 events and 512 KiB by default; mutation guard threshold 10,000                     |
| Delivery queue                        | Up to 4 segments and 2 MiB by default, at most 2 retries                                     |

These limits bound recording and delivery resources; they do not guarantee host package size or device performance. Measure your host's build size and runtime behavior before changing them. Optional [Worker compression](./worker) does not lift these limits.

## Troubleshooting

| Symptom                                    | What to check                                                                                                                                                   |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Errors arrive but no replay                | The integration is registered, sample rates are set, the lifecycle is installed before pages are created, plus the visible-page state and minimum send duration |
| Still no recording after `Sentry.flush()`  | Call the integration's `replay.flush()` first; the compatibility `bridge.flush()` does not send buffers                                                         |
| Text and images missing in playback        | Check the default masking and media policy first; only unmask content you have confirmed is safe                                                                |
| Layout or images differ from the real page | The package does not read app CSS or collect images automatically; provide [build-time assets](./hybrid-apps#provide-page-styles-and-static-images)             |
| Recording stops after navigating back      | Check whether the single-recording `useTaroReplay` is used, or whether `stop()` was called earlier                                                              |
| Native components or Canvas missing        | The Taro DOM does not include native component internals; unsupported nodes may show as placeholders, and Canvas needs explicit setup                           |

Recordings do not include browser computed styles or the final render timing of the native view layer. Styles, fonts, native controls and animations may differ from what devices show, so check in real Sentry playback and on target devices.

The bundled `sentry-taro-viewer` only shows capture summaries, events and JSON and does not render replays. The [Taro React example](https://github.com/xumoses/sentry-taro/blob/main/examples/taro-react/README.md) uses a local collecting transport and does not upload to Sentry.

Read next: [API reference](./api) · [Worker compression](./worker) · [Hybrid apps](./hybrid-apps) · [Migration](./migration)
