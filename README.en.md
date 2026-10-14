# @xumoses/sentry-taro

[中文](./README.md)

By xumoses. Error monitoring, performance monitoring and opt-in Session Replay for Taro 4.2.x + React 18 WeChat mini-programs, based on `@sentry/core@10.66.0`.

**Stage one local candidate integration acceptance is complete. The package is not published on npm.** The current local candidate version is `0.1.0-beta.1`. Local tarball integration and real Sentry ingestion, association and Playback passed; see the [acceptance record](./docs/implementation/phase-one.md) for the scope and artifact checksum. Publication, formal dependency/lockfile migration and published-package CI move to stage two, with the version and tag decided then. Device acceptance follows the stage-two refactor, starting with iOS; Android verification comes later. No unverified minimum WeChat base-library version is promised. Existing platform capabilities are retained without claiming cross-platform Replay acceptance.

## Initialize once

For stage one, run `pnpm pack --pack-destination .artifacts` in this repository and install the resulting local tarball with `pnpm add /path/to/candidate.tgz` in your application. No public publication is required. Future release notes will specify the npm version and tag. This entry snippet targets a standalone Taro application. Replace the DSN with your project configuration. Error monitoring also works independently: omit the Replay integration and page lifecycle setup.

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
  integrations: [...Sentry.getDefaultIntegrations(), replay],
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
  return <View>
    <Text>{snapshot.state}</Text>
    <Button onClick={() => Sentry.captureException(new Error('synthetic example error'))}>
      Capture synthetic error
    </Button>
  </View>;
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

Official API alignment is staged; this package does not claim full compatibility with browser/React Replay. `replay.bridge.flush()` does not send an error buffer; use the explicit `sendBufferedReplay()` operation to promote and send it. `Sentry.flush(timeout)` waits for the SDK transport without cutting recorder segments. To drain a current session segment, call bridge.flush before Sentry.flush. `bridge.stop({ flush })` stops recording and should not be assumed to match every official control method.

The included viewer displays capture summaries, events and JSON, not rendered playback. The [lightweight demo](./examples/taro-react/README.md) illustrates integration and is not a stage-one acceptance suite. Service ingestion, real Playback, CI and device behavior require separate evidence.

## Development and license

Stage one uses pnpm while retaining SDK Jest and Replay Vitest. The final toolchain is Vite, Vitest, Oxlint and Oxfmt. Consult root `package.json` for executable commands and [project documents](./docs/README.md) for the plan.

Use Node.js `24.21.0` from `.node-version` and pnpm `9.15.9` for development. The consumer package declares Node.js `>=20`; development tools have a separate requirement. The root build uses Vite `6.4.1` / TypeScript `5.8.3`, and SDK tests use Jest `29.7.0`. Replay temporarily retains Vite+ `0.2.6`, Vitest `4.1.10` and TypeScript `7.0.2`.

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm run verify:package
pnpm pack --pack-destination .artifacts
pnpm run verify:consumer --online
```

`pnpm pack` rebuilds and verifies the artifacts, then creates a local tarball. `verify:consumer` defaults to `.artifacts/xumoses-sentry-taro-0.1.0-beta.1.tgz` and accepts another `.tgz` path as an argument. It checks strict types and real SDK behavior in a temporary consumer without React/Taro. The script defaults to offline mode; omit `--online` when the cache is complete. On a fresh machine, `--online` fetches dependencies from the public npm registry and does not publish the package.

The [stage-one progress record](./docs/implementation/phase-one.md) separates completed local checks, pending candidate integration acceptance, and the publication/device work planned for stage two.

Released under [MIT](./LICENSE). Inherited and bundled dependencies are documented in [THIRD_PARTY_NOTICES](./THIRD_PARTY_NOTICES).
