# Migrating from the legacy SDK and Replay packages

`@xumoses/sentry-taro` puts the error-monitoring SDK and Taro Replay in one package. New projects should start from [Getting started](./getting-started); this page is for apps using the legacy packages below.

With Claude Code, Cursor or similar tools, you can install the repository's [agent skill](./getting-started#ai-assisted-setup) and have the agent follow the [migration checklist](https://github.com/xumoses/sentry-taro/blob/main/skills/sentry-taro/references/migration.md) to search, replace and check. Still verify the result as described in the last section.

## Replace dependencies and imports

| Old import                                            | New import                             |
| ----------------------------------------------------- | -------------------------------------- |
| `@xumoses/sentry-miniapp`                             | `@xumoses/sentry-taro`                 |
| `@xumoses/sentry-miniapp-replay-taro`                 | `@xumoses/sentry-taro`                 |
| `@xumoses/sentry-miniapp-replay-taro/react`           | `@xumoses/sentry-taro/react`           |
| `@xumoses/sentry-miniapp-replay-taro/react/root`      | `@xumoses/sentry-taro/react/root`      |
| `@xumoses/sentry-miniapp-replay-taro/taro/lifecycle`  | `@xumoses/sentry-taro/taro/lifecycle`  |
| `@xumoses/sentry-miniapp-replay-taro/worker`          | `@xumoses/sentry-taro/worker`          |
| `@xumoses/sentry-miniapp-replay-taro/devtools/server` | `@xumoses/sentry-taro/devtools/server` |

Install the new package in the app directory. Remove the old packages only after replacing imports and confirming no other code uses them:

```sh
pnpm add @xumoses/sentry-taro@beta
```

```sh
pnpm remove @xumoses/sentry-miniapp @xumoses/sentry-miniapp-replay-taro
```

Update the manifest and lockfile with the package manager you actually use. Also update Worker copy scripts, native npm build rules and subpath imports, then clean old build output and rebuild.

## Merge initialization

Use `replayIntegration()` from the root entry. It uses the SDK from the same package by default, so there is no need to pass `sdk`:

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
```

`taroReplayIntegration` remains as a compatibility name and can also omit `sdk`. Low-level recorder and React APIs keep their own options; don't assume every entry injects the SDK automatically.

Keep a single initialization for the whole app. If the native host owns the SDK, pass its `replay.bridge` to Taro; see [Hybrid apps](./hybrid-apps).

## Check pages and control logic

- Install `installTaroReplayPageLifecycle({ bridge: replay.bridge })` in the app entry, or use `useTaroReplayRoot` per page; choose one lifecycle owner per page.
- Pages that only display state use `useTaroReplaySnapshot`. The low-level `useTaroReplay` is a single-recording API and does not resume after hide/unload.
- Get the current integration with `Sentry.getReplay()`. It is registered under the name `Replay`, so lookups by the old name need updating.
- New code should use `replay.flush()` to send the buffer and continue as a session; the old `bridge.flush()` still only sends session segments.
- The default minimum send duration is about 5 seconds, so short recordings may be delayed or discarded on explicit stop. See [API and configuration](./api) for full semantics.

## Check the build and upgrade result

ESM is the recommended format; the package also keeps CJS and the standalone Worker. UMD is no longer provided. Apps with Worker compression must copy the asset again from the new package and keep its license notice; see [Worker compression](./worker).

After upgrading, use a synthetic page to check error ingestion, Replay linking, page switching, text masking and Worker delivery; verify the build and size in your own CI, on target devices and in the uploaded package.

When upgrading from an earlier beta, also review the config types, default integrations, session policy and platform field changes in the [runtime migration notes](https://github.com/xumoses/sentry-taro/blob/main/docs/migrations/phase-two-runtime.md) (Chinese) and the [CHANGELOG](https://github.com/xumoses/sentry-taro/blob/main/CHANGELOG.md).
