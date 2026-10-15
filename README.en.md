# @xumoses/sentry-taro

[中文](./README.md)

By xumoses. Error monitoring, performance monitoring and opt-in Session Replay for Taro 4.2.x + React 18 WeChat mini-programs, based on `@sentry/core@10.76.2`.

**This package is in beta. The stage-two 10.76.2 runtime baseline has passed local checks, host tarball integration, real Sentry error ingestion, Replay association and Playback validation.** The first release, `0.1.0-beta.1`, was published to npm on 2026-10-15 and is available through the `beta` tag; see the [release procedure](./docs/releases.md). See the [stage-two record](./docs/implementation/phase-two.md) for the exact checksum, synthetic scenarios and validation limits. These real sends used WeChat DevTools and do not replace device acceptance. Evidence for the original stage-one tarball remains in the [original acceptance record](./docs/implementation/phase-one.md). Formal dependency migration, published-package CI and device acceptance remain staged work. Device verification starts with iOS; Android follows later. No unverified minimum WeChat base-library version is promised. Existing platform capabilities are retained without claiming cross-platform Replay acceptance.

## Initialize once

Use `pnpm add @xumoses/sentry-taro@0.1.0-beta.1` to pin the first release or `pnpm add @xumoses/sentry-taro@beta` to follow beta releases. For local development, run `vp pm pack --pack-destination .artifacts` in this repository and install the resulting tarball with `pnpm add /path/to/candidate.tgz`. This entry snippet targets a standalone Taro application. Replace the DSN with your project configuration. Error monitoring also works independently: omit the Replay integration and page lifecycle setup.

```ts
// src/sentry.ts
import * as Sentry from '@xumoses/sentry-taro';
export const replay = Sentry.replayIntegration();
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

`replayIntegration()` uses the SDK from the same package. Text and inputs are masked and media is blocked by default. Adjust sampling for your production traffic.

## Attach Taro pages

Install the lifecycle adapter once, before pages are created:

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

```tsx
// A page subscribes without owning the root lifecycle.
import { Button, Text, View } from '@tarojs/components';
import { useTaroReplaySnapshot } from '@xumoses/sentry-taro/react/root';
import { replay, Sentry } from '../../sentry';
export default function ExamplePage() {
  const snapshot = useTaroReplaySnapshot({ bridge: replay.bridge });
  return (
    <View>
      <Text>{snapshot.state}</Text>
      <Button onClick={() => Sentry.captureException(new Error('synthetic example error'))}>
        Capture synthetic error
      </Button>
    </View>
  );
}
```

Alternatively use `useTaroReplayRoot({ bridge })` on individual pages. Do not combine it with the global lifecycle adapter on the same page. The low-level `/react` `useTaroReplay` hook records once and does not automatically resume after hide/unload.

In native-host/Taro hybrid applications, keep one SDK/client/coordinator in the native entry. Pass `replay.bridge` through your application's bridge and import only lightweight `/taro/lifecycle` and `/react/root` entries in Taro. Host-generated styles and images can be supplied through `getReplayStyles` and `getReplayImageSources`; the package does not automatically read application CSS or bundle business assets.

## Optional Worker compression

Copy the standalone asset during the host build with a CommonJS script:

```js
const { copyFileSync, mkdirSync } = require('node:fs');
mkdirSync('workers', { recursive: true });
copyFileSync(require.resolve('@xumoses/sentry-taro/worker'), 'workers/sentry-replay.js');
```

Add `"workers": "workers"` to WeChat `app.json`, then initialize the integration with:

```ts
const replay = Sentry.replayIntegration({
  compression: { workerPath: 'workers/sentry-replay.js' },
});
```

Worker creation, compression or communication failure falls back to raw recordings. Recording and delivery limits still apply. Retain the standalone script's license notices when distributing it.

## Migration and API semantics

Replace both `@xumoses/sentry-miniapp` and `@xumoses/sentry-miniapp-replay-taro` imports with `@xumoses/sentry-taro`. Replay subpaths `/react`, `/react/root`, `/taro/lifecycle`, `/worker` and `/devtools/server` keep their names under the new package. Update manifests, locks, Worker copy scripts and host npm build rules, and remove stale runtime artifacts.

`taroReplayIntegration` remains a compatibility entry with an optional `sdk` argument. Low-level recorder/React APIs retain their existing options; automatic SDK injection is not promised for every entry.

`Sentry.getReplay()` returns the current client's Replay integration, exposing `start()`, `startBuffering()`, `flush()`, `stop()`, `getReplayId()` and `getRecordingMode()`. `replay.flush()` sends the error buffer and continues session recording by default. `stop()` flushes the remaining session by default and discards an unsent buffer. Manual recording also works on an attached visible page when automatic sampling is zero.

The `bridge` remains the Taro page/viewport adapter. Its compatibility `flush()` only drains session segments; `bridge.sendBufferedReplay()` remains available for explicit buffer delivery. `Sentry.flush(timeout)` only waits for the SDK transport. To send recordings explicitly, first `await Sentry.getReplay()?.flush()`, then `await Sentry.flush(timeout)`.

The default minimum duration is 4,999 ms: an earlier `flush()` schedules delivery and resolves immediately; stopping before this threshold discards the short recording. Other defaults are a 60-second rolling buffer, a 60-minute replay limit, and full-session idle pause/expiry after 5/15 minutes. Byte and event budgets may shorten the retained window. Logs/Metrics stay disabled by default and are unsupported on the current target service. See the [runtime migration notes](./docs/migrations/phase-two-runtime.md) for platform extensions, beta behavior changes and unimplemented browser options. Full browser Replay compatibility is not claimed.

The included viewer displays capture summaries, events and JSON, not rendered playback. The [lightweight demo](./examples/taro-react/README.md) illustrates integration and is not a stage-one acceptance suite. Service ingestion, real Playback, CI and device behavior require separate evidence.

## Development and license

Stage two uses Vite Plus `1.2.0` to manage Vite, Vitest, Oxlint, Oxfmt and library builds. SDK and Replay tests share Vitest. Development uses Node.js `26.12.0` from `.node-version`, pnpm `12.13.0` from root `package.json`, and TypeScript `7.0.2`. The consumer package still declares Node.js `>=20`; development tool versions do not change the mini-program output syntax target.

After installing the global `vp` CLI, run `vp env install`, then verify the executed versions with `vp env current --json`, `vp exec node --version` and `vp exec pnpm --version`. If an existing Vite Plus installation uses `system_first`, project pins do not override system tools on PATH. See the [environment instructions](./docs/implementation/phase-two.md#开发环境复现) for a process-scoped setup that preserves global preferences.

```sh
vp install --frozen-lockfile
vp check
vp run typecheck
vp test run
vp run build
vp run verify:package
vp pm pack --pack-destination .artifacts
vp run verify:bundles
vp run verify:consumer --online
```

`vp pack` builds the library. `vp pm pack` invokes pnpm and its `prepack` hook, rebuilding and verifying the artifacts before creating a local tarball. `verify:consumer` defaults to `.artifacts/xumoses-sentry-taro-0.1.0-beta.1.tgz` and accepts another `.tgz` path as an argument. It checks strict types and real SDK behavior in a temporary consumer without React/Taro. The script defaults to offline mode; omit `--online` when the cache is complete. On a fresh machine, `--online` fetches dependencies from the public npm registry and does not publish the package.

The [stage-two progress record](./docs/implementation/phase-two.md) tracks current validation; the [stage-one record](./docs/implementation/phase-one.md) preserves evidence for its original candidate. **Pause before publishing to npm and wait for user confirmation.**

Released under [MIT](./LICENSE). Inherited and bundled dependencies are documented in [THIRD_PARTY_NOTICES](./THIRD_PARTY_NOTICES).
