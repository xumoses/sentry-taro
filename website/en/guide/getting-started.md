# Getting started

`@xumoses/sentry-taro` is a community Sentry SDK for **Taro React WeChat mini programs**. It provides error monitoring, performance monitoring and opt-in Session Replay. It is built on the official `@sentry/core`, and its public APIs and defaults keep Sentry's names and semantics. See [Core concepts](./concepts) for the design trade-offs.

## Compatibility

| Environment  | Current integration scope                                                                |
| ------------ | ---------------------------------------------------------------------------------------- |
| Framework    | Taro 4.2.x and React 18                                                                  |
| Platform     | WeChat mini programs; Replay support does not include H5 or other mini-program platforms |
| Installation | Node.js ≥ 20 and an existing Taro React project                                          |

::: warning Pre-release
Error ingestion and Replay playback have been verified in WeChat DevTools; desktop WeChat acceptance is not yet complete and mobile WeChat is unverified. Verify your service and target devices before adopting. No minimum WeChat base-library version is promised yet.
:::

## 1. Install

::: code-group

```sh [npm]
npm install @xumoses/sentry-taro@rc
```

```sh [pnpm]
pnpm add @xumoses/sentry-taro@rc
```

```sh [yarn]
yarn add @xumoses/sentry-taro@rc
```

:::

Replace `rc` with an explicit version to pin a release.

## 2. Initialize error monitoring

Get a DSN from your Sentry project and create this module. Initialize the SDK once per application.

```ts
// src/sentry.ts
import * as Sentry from '@xumoses/sentry-taro';

Sentry.init({
  dsn: 'https://PUBLIC_KEY@YOUR_SENTRY_HOST/PROJECT_ID',
  environment: 'production',
  sendDefaultPii: false,
  traceNetworkBody: false,
});

export { Sentry };
```

Import it at the top of your existing application entry, keeping your styles and startup logic:

```ts
// src/app.tsx
import './sentry';
```

::: tip Trusted domains
On devices, a mini program can only request domains configured in its admin console. Add your Sentry ingest domain to the `request` trusted domains in the WeChat MP console; otherwise events that arrive from DevTools will not be sent from devices.
:::

## 3. Capture your first error

Call this from a button handler on a test page:

```ts
import { Sentry } from '../../sentry';

Sentry.captureException(new Error('My first Sentry error'));
```

Look for the error in your Sentry project's Issues. If it is missing, check the DSN, environment filter and mini-program network requests. See [API and configuration](./api) for performance sampling, context and other options.

## 4. Enable Session Replay (optional)

Replay is opt-in. Replace the `src/sentry.ts` above with:

```ts
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

Then install the lifecycle adapter once in your application entry, before pages are created, and keep your App component:

```ts
// src/app.tsx
import { installTaroReplayPageLifecycle } from '@xumoses/sentry-taro/taro/lifecycle';
import { replay } from './sentry';

installTaroReplayPageLifecycle({ bridge: replay.bridge });
```

This example buffers interactions locally and attempts to upload on captured exceptions with 100% error sampling. Adjust sampling for your traffic. Recordings must last about 5 seconds before delivery, so interact with the page before triggering an error.

Default masking protects page content; review exception messages and context you attach yourself. The [Taro build plugin](./taro-plugin) can prepare replay styles and images. See [Session Replay](./replay) for full configuration, privacy options and troubleshooting.

## AI-assisted setup

This repository ships an agent skill for Claude Code, Cursor and other skill-aware tools. It covers new installs, Replay, the build plugin, and migration from `@xumoses/sentry-miniapp` / `@xumoses/sentry-miniapp-replay-taro`:

```sh
npx skills add https://github.com/xumoses/sentry-taro --skill sentry-taro
```

Then ask your agent to "set up Sentry for this Taro app" or "migrate from sentry-miniapp". The skill source is in [`skills/sentry-taro`](https://github.com/xumoses/sentry-taro/blob/main/skills/sentry-taro/SKILL.md).

## Next steps

| Task                                                                   | Guide                                                                                                |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Understand the design trade-offs and capability boundaries             | [Core concepts](./concepts)                                                                          |
| Add context, configure tracing or control Replay                       | [API and configuration](./api)                                                                       |
| Attach pages, configure sampling and privacy, or troubleshoot playback | [Session Replay](./replay)                                                                           |
| Prepare Replay assets, release identity and sourcemaps                 | [Taro build plugin](./taro-plugin)                                                                   |
| Configure Worker compression                                           | [Worker compression](./worker)                                                                       |
| Integrate a native mini program with Taro pages                        | [Hybrid apps](./hybrid-apps)                                                                         |
| Migrate from the separate SDK and Replay packages                      | [Migration](./migration)                                                                             |
| Explore integration code                                               | [Taro React example](https://github.com/xumoses/sentry-taro/blob/main/examples/taro-react/README.md) |
