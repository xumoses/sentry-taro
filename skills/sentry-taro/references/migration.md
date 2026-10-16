# Migrating from @xumoses/sentry-miniapp and @xumoses/sentry-miniapp-replay-taro

`@xumoses/sentry-taro` merges the SDK (`@xumoses/sentry-miniapp`, last `1.13.1-beta.7`, core 10.66.0) and Taro Replay (`@xumoses/sentry-miniapp-replay-taro`, last `0.1.0-beta.6`) into one package on `@sentry/core` 10.76.2. The public API is largely the same; the work is mostly imports, init wiring, build scripts, and a few behavior changes.

## 0. Check fit before migrating

The new package targets **Taro 4.2 + React 18 + WeChat**. The legacy SDK also advertised Alipay, ByteDance, Baidu, QQ, DingTalk, Kuaishou, mini games, uni-app, and a UMD copy-in build. If the project is one of those (no Taro/React, non-WeChat target, or mini game), tell the user the new package's validated scope is narrower and get confirmation before migrating. Do not silently migrate an out-of-scope project.

## 1. Inventory legacy usage

Search the whole repo (source, build scripts, CI, native host):

```sh
grep -rnE "sentry-miniapp|sentry-miniapp-replay-taro|taroReplayIntegration|getDefaultIntegrations|getIntegrationByName|startTaroDomReplayPoc|TARO_DOM_REPLAY_POC_MARKER|TaroReplayPoc|sendBufferedReplay|bridge\.flush|sentry-replay\.js|replayStyles|replayImages|decodeReplayAssetData|merge-sourcemap|sentry-miniapp-replay-taro-viewer" \
  --exclude-dir=node_modules --exclude-dir=dist .
```

Also look for: a vendored UMD file (e.g. `lib/sentry-miniapp.js`), Worker copy scripts, `packNpmManually` ignore lists, custom style/image asset generators, sourcemap upload scripts, and `getIntegrationByName('TaroReplay')`.

List what you found to the user before changing it.

## 2. Swap dependencies

Install the new package first, update imports, then remove the old ones once nothing references them:

```sh
pnpm add @xumoses/sentry-taro@beta
pnpm remove @xumoses/sentry-miniapp @xumoses/sentry-miniapp-replay-taro
```

(Use the project's package manager; update the lockfile.) If the project used the vendored UMD file instead of npm, delete it and switch to the npm package — UMD is no longer published; ESM and self-contained CJS are.

## 3. Rewrite imports

| Old                                                   | New                                    |
| ----------------------------------------------------- | -------------------------------------- |
| `@xumoses/sentry-miniapp`                             | `@xumoses/sentry-taro`                 |
| `@xumoses/sentry-miniapp-replay-taro`                 | `@xumoses/sentry-taro`                 |
| `@xumoses/sentry-miniapp-replay-taro/react`           | `@xumoses/sentry-taro/react`           |
| `@xumoses/sentry-miniapp-replay-taro/react/root`      | `@xumoses/sentry-taro/react/root`      |
| `@xumoses/sentry-miniapp-replay-taro/taro/lifecycle`  | `@xumoses/sentry-taro/taro/lifecycle`  |
| `@xumoses/sentry-miniapp-replay-taro/worker`          | `@xumoses/sentry-taro/worker`          |
| `@xumoses/sentry-miniapp-replay-taro/devtools/server` | `@xumoses/sentry-taro/devtools/server` |
| bin `sentry-miniapp-replay-taro-viewer`               | bin `sentry-taro-viewer`               |

Two namespace imports usually collapse into one (`import * as Sentry from '@xumoses/sentry-taro'`).

Renamed recorder APIs (old names are deprecated aliases scheduled for removal in the next beta):

| Old                                           | New                                                            |
| --------------------------------------------- | -------------------------------------------------------------- |
| `startTaroDomReplayPoc`                       | `startTaroReplayRecorder`                                      |
| `TARO_DOM_REPLAY_POC_MARKER`                  | `TARO_REPLAY_CAPTURE_MARKER`                                   |
| `TaroDomReplayPocController`                  | `TaroReplayRecorder`                                           |
| `StartTaroDomReplayPocOptions`                | `StartTaroReplayRecorderOptions`                               |
| `TaroReplayPocCapture` / `Event` / `Metadata` | `TaroReplayCapture` / `TaroReplayEvent` / `TaroReplayMetadata` |

## 4. Rewrite init

Before:

```ts
import * as Sentry from '@xumoses/sentry-miniapp';
import { taroReplayIntegration } from '@xumoses/sentry-miniapp-replay-taro';

const replay = taroReplayIntegration({ sdk: Sentry });
Sentry.init({
  dsn,
  replaysSessionSampleRate: 0.01,
  replaysOnErrorSampleRate: 1,
  integrations: [...Sentry.getDefaultIntegrations(), replay],
});
```

After:

```ts
import * as Sentry from '@xumoses/sentry-taro';

export const replay = Sentry.replayIntegration();
Sentry.init({
  dsn,
  sendDefaultPii: false,
  traceNetworkBody: false,
  replaysSessionSampleRate: 0.01,
  replaysOnErrorSampleRate: 1,
  integrations: [replay],
});
```

- Drop `sdk: Sentry` — the integration uses the same-package SDK. (Still accepted, but passing a namespace from the old package would create two SDKs.)
- Drop the `...Sentry.getDefaultIntegrations()` spread: an `integrations` **array now merges with defaults**. `getDefaultIntegrations(options)` now depends on options, so calling it without the real options can produce a different default set. Use the callback form `integrations: (defaults) => [...]` to filter.
- If the old code passed an `integrations` array deliberately to **replace** defaults, that no longer happens — use the callback form or `defaultIntegrations: false` to keep that behavior, and confirm with the user.
- Preserve every other existing option (DSN, release, environment, consent, offline cache, filters, network detail options, `beforeSend`, …); their names are unchanged.
- Move privacy settings to the official top-level options `maskAllText` / `maskAllInputs` / `blockAllMedia` now. Legacy `privacy.*` (including `privacy.maskInputValues` and `privacy.allowUser`) still works in `0.1.0-beta.6`, with top-level values taking precedence, but it is scheduled for removal without a deprecation period.

Lifecycle/page code keeps the same API: `installTaroReplayPageLifecycle({ bridge: replay.bridge, getReplayStyles, getReplayImageSources })`, `useTaroReplayRoot`, `useTaroReplaySnapshot`. Only the import path changes. Still one lifecycle owner per page.

## 5. Update Replay control code

| Legacy pattern                                                    | Now                                                                                                              |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `client.getIntegrationByName('TaroReplay')` / module-level caches | `Sentry.getReplay()` — integration name is now `Replay`                                                          |
| `bridge.flush()` to send data                                     | `await Sentry.getReplay()?.flush()` — sends session segments **and** promotes a buffer, then continues recording |
| `bridge.sendBufferedReplay()`                                     | `Sentry.getReplay()?.flush()` (or `flush({ continueRecording: false })`)                                         |
| `bridge.start()` / `startBuffering()` / `stop()`                  | Same names on the integration: `replay.start()`, `replay.startBuffering()`, `await replay.stop({ flush? })`      |

`bridge.flush()` and `bridge.sendBufferedReplay()` still exist with their old semantics (session-only / buffer-only); prefer the integration methods for new code. `bridge.reset()`, `subscribe`, `getSnapshot`, `recordCanvas`, `refreshEnabled`, `destroy` are unchanged.

## 6. Update build scripts

- **Worker:** point copy scripts at `require.resolve('@xumoses/sentry-taro/worker')` and copy `fflate.LICENSE` alongside, or replace the script with the build plugin (`replay: { worker: {} }`) / `writeReplayWorker()` — see `build-plugin.md`. Keep `app.json` `workers` and `compression.workerPath` as they were. Clean old output before rebuilding.
- **Native npm packing:** replace hand-written ignore lists for the old packages with `getSentryMiniProgramNpmIgnores()` where appropriate, and make sure the old `miniprogram_npm/@xumoses/sentry-miniapp*` output is gone.
- **Replay styles/images:** hand-maintained `replayStyles.generated` / `replayImages.generated` generators can keep working (same callback contract, same `decodeReplayAssetData`). Offer to replace them with the `/taro-plugin` (pure Taro) or `generateReplayAssets()` (hybrid).
- **Sourcemaps:** the legacy two-layer merge script / manual `sentry-cli` invocations can be replaced with `uploadSourceMaps()` over WeChat's final sourcemap ZIP; release identity comes from the plugin's `sentry-build.json`. Keep the old flow if the user prefers — just make sure `release`/`dist` match.

## 7. Behavior changes to tell the user about

- **`event.platform`** is now the Sentry protocol value `javascript`; the mini-program platform moved to `contexts.miniapp.platform`. Saved searches, alerts, or dashboards filtering on the old platform value must be updated.
- **Error buffer window** is 60 s (was 30 s), still bounded by event/byte budgets.
- **Minimum replay duration**: 4,999 ms by default (`minReplayDuration`, 0–50,000). Shorter recordings are deferred by `flush()` and discarded by `stop()`. Quick smoke tests must interact for > 5 s first.
- **Session policy**: max 60 min, idle pause 5 min, expiry 15 min; page switches and segment flushes keep the same Replay ID.
- **`enableLogs` / `enableMetrics`** are explicitly `false` by default.
- **`Sentry.flush()`** waits only for the SDK transport; it does not drain Replay — call `replay.flush()` first.
- **Core 10.66 → 10.76.2**: new exports (`setCurrentClient`, `createTransport`, `parameterize`, `dedupeIntegration`, `captureConsoleIntegration`, `httpClientIntegration`). If the app hand-wrapped `console.error` or 5xx responses to capture errors, offer to switch to the opt-in integrations and remove the wrappers to avoid duplicates.

## 8. Verify

1. `grep` again — no `sentry-miniapp` references remain (except changelog/docs if the user wants them kept); lockfile contains only `@xumoses/sentry-taro`.
2. Run the project's typecheck and build; inspect the final mini-program output (main package and subpackages) for a single SDK runtime and, if used, `workers/sentry-replay.js`.
3. In WeChat DevTools: synthetic error arrives in Sentry; with Replay, interact > 5 s, trigger an error, confirm the issue links a playable replay, page switching and back navigation still record, and masking looks right.
4. Repeat on a target device before production rollout.
