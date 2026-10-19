# Hybrid native + Taro apps

In a hybrid app, the native entry should own the only SDK client and Replay integration, then hand `replay.bridge` to Taro pages. Errors, Replay identity and page switches are then managed by a single state.

This guide applies to Taro 4.2.x and React 18 WeChat mini programs. Native pages have no Taro DOM, so passing the bridge does not give them visual recording.

## Initialize once in the host

Initialize the package in the native host entry, configured as in [Session Replay](./replay). Native builds using CommonJS can also `require('@xumoses/sentry-taro')`.

```ts
// monitoring.ts, owned by the host
import * as Sentry from '@xumoses/sentry-taro';

const replay = Sentry.replayIntegration();

Sentry.init({
  dsn: 'https://PUBLIC_KEY@YOUR_SENTRY_HOST/PROJECT_ID',
  sendDefaultPii: false,
  traceNetworkBody: false,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 1,
  integrations: [replay],
});

export const monitoring = {
  replayBridge: replay.bridge,
  captureException: (error: unknown) => Sentry.captureException(error),
};
```

Expose `monitoring` through your app's existing host communication layer. It must return the same object from the host; never initialize the SDK again in a Taro subpackage. `getHostMonitoring` below is implemented by your app; it is not a package API.

## Use the lightweight entries on the Taro side

```tsx
// Taro app entry, installed before pages are created.
import type { PropsWithChildren } from 'react';
import { installTaroReplayPageLifecycle } from '@xumoses/sentry-taro/taro/lifecycle';
import { getHostMonitoring } from './host-bridge';

const { replayBridge } = getHostMonitoring();
installTaroReplayPageLifecycle({ bridge: replayBridge });

export default function App({ children }: PropsWithChildren) {
  return children;
}
```

`/taro/lifecycle` and `/react/root` are the page adapter entries. The Taro side gets the bridge through the communication layer rather than importing the host module that contains `Sentry.init()`, which would make the bundler package the full SDK again.

To display recording state, import `useTaroReplaySnapshot` from `@xumoses/sentry-taro/react/root` and pass the same bridge. For per-page lifecycles use `useTaroReplayRoot` instead; never install both the global adapter and the root hook on the same page.

Inspect the final build output of the host, main package and subpackages to confirm only the intended SDK runtime remains. Using the same package name in source does not prove the host build avoids duplicate copies. The root entry ships both ESM and CJS; deduplication and subpackage behavior are decided by the host build.

## Provide page styles and static images

This section applies to pure Taro apps too. The package never reads app CSS, scans app images or generates asset manifests at runtime. The recommended path is the [Taro build plugin](./taro-plugin), which collects shared styles, page styles and static images and hands them to the lifecycle adapter; existing custom builds can keep providing the callbacks below.

Both callbacks are synchronous:

```ts
getReplayStyles(route: string): string | undefined;
getReplayImageSources(route: string): Readonly<Record<string, string>> | undefined;
```

`route` has the leading `/`, query and fragment removed. For example, `/pages/home/index?source=demo` maps to `pages/home/index`. Image map keys must match the `src` that the page's `Image` nodes actually use; don't use the page route in place of image paths.

This shows the shape of the asset data; `replay-assets.ts` is maintained by your app or generated at build time:

```ts
// replay-assets.ts, provided by the app
export const sharedStyles = '[data-taro-node="view"]{box-sizing:border-box}';

export const pageStyles: Record<string, string> = {
  'pages/home/index': '.home-title{font-size:32rpx;font-weight:600}',
};

// Reviewed static image maps per page; without one, media stays blocked by default.
export const pageImages: Record<string, Readonly<Record<string, string>>> = {};
```

Pass the asset callbacks together with the bridge in the Taro app entry:

```ts
import { installTaroReplayPageLifecycle } from '@xumoses/sentry-taro/taro/lifecycle';
import { getHostMonitoring } from './host-bridge';
import { pageImages, pageStyles, sharedStyles } from './replay-assets';

installTaroReplayPageLifecycle({
  bridge: getHostMonitoring().replayBridge,
  getReplayStyles: (route) => `${sharedStyles}\n${pageStyles[route] || ''}`,
  getReplayImageSources: (route) => pageImages[route],
});
```

Pure Taro apps can replace `bridge` with the `replay.bridge` saved during initialization. Asset manifests, callbacks and initialization must all be ready before pages are created.

Styles are used when Replay renders in the browser, so selectors must match recorded nodes. Class names can stay as they are; native tag selectors must be converted to match the recording, for example `[data-taro-node="view"]` for a Taro `View`. The recorder converts `rpx` by viewport width but does not compute the final styles of WeChat native controls. CSS provided at build time is trusted input; review URLs and text such as `content` when generating it.

Image map values are reviewed static image data URIs. A map entry grants explicit permission for that image and may be recorded even with `blockAllMedia: true`, so it should only contain safe assets shipped with the app. The recorder checks supported data URI forms and per-entry size; don't use it for user uploads, identity-bearing resources or dynamic screenshots. Manifests also add to host package size and recording volume, so pick the assets each page needs.

## Build and runtime checks

Make sure the host communication layer is available before Taro pages are created, and that the main package and subpackages reference the same bridge. Then check recording on first entry, navigation, back, hide and show, and the linking between errors and replays.

Check styles and images in real playback. Native component internals, final view-layer timing and browser computed styles are not in the Taro DOM, so these callbacks cannot guarantee pixel-perfect reproduction. After DevTools passes, still check page behavior, privacy and runtime overhead on target devices.

With compression enabled, also put the standalone Worker into the host's final output and configure `app.json`; see [Worker compression](./worker). When migrating from the legacy two-package setup, update the host npm build rules and old runtime artifacts too; see [Migration](./migration).

Read next: [Session Replay](./replay) · [API reference](./api) · [Worker compression](./worker)
