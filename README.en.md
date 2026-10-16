# Sentry for Taro

[![npm beta](https://img.shields.io/npm/v/%40xumoses%2Fsentry-taro/beta)](https://www.npmjs.com/package/@xumoses/sentry-taro)
[![CI](https://github.com/xumoses/sentry-taro/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/xumoses/sentry-taro/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[中文](./README.md) · [Quick start](#quick-start) · [Documentation](./docs/README.md) · [Example](./examples/taro-react/README.md) · [Report an issue](https://github.com/xumoses/sentry-taro/issues)

`@xumoses/sentry-taro` is a community Sentry SDK for **Taro React WeChat mini-programs**. It provides error monitoring, performance monitoring and optional Session Replay to help you investigate issues with error context and user interactions.

- **Error monitoring**: capture exceptions with page, network and device context, or report application errors explicitly.
- **Performance monitoring**: sample traces for page loads, network requests and custom operations.
- **Session Replay**: record Taro pages through session or error sampling and view associated replays in Sentry. Text and inputs are masked and media is blocked by default.

## Compatibility

| Environment  | Current integration scope                                                                |
| ------------ | ---------------------------------------------------------------------------------------- |
| Framework    | Taro 4.2.x and React 18                                                                  |
| Platform     | WeChat mini-programs; Replay support does not include H5 or other mini-program platforms |
| Installation | Node.js ≥ 20 and an existing Taro React project                                          |

**Currently in beta.** Error ingestion and Replay playback have been verified in WeChat DevTools; device validation is pending.

Verify your service and target devices before adopting. No minimum WeChat base-library version is promised yet.

## Quick start

### 1. Install

```sh
npm install @xumoses/sentry-taro@beta
```

For pnpm, use `pnpm add @xumoses/sentry-taro@beta`. Replace `beta` with an explicit version to pin a release.

### 2. Initialize error monitoring

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

### 3. Capture your first error

Call this from a button handler on a test page:

```ts
import { Sentry } from '../../sentry';

Sentry.captureException(new Error('My first Sentry error'));
```

Look for the error in your Sentry project's Issues. If it is missing, check the DSN, environment filter and mini-program network requests.

See [API and configuration](./docs/guides/api.md) for performance sampling and other options.

## Enable Session Replay

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

Install the lifecycle adapter once in your application entry, before pages are created. Add these statements to your existing entry and keep your App component:

```ts
// src/app.tsx
import { installTaroReplayPageLifecycle } from '@xumoses/sentry-taro/taro/lifecycle';
import { replay } from './sentry';

installTaroReplayPageLifecycle({ bridge: replay.bridge });
```

This example buffers interactions locally and attempts to upload on captured exceptions with 100% error sampling. Adjust sampling for your traffic.

Recordings must last about 5 seconds before delivery, so interact with the page before triggering an error.

Default masking protects page content. Review exception messages and context you attach yourself. Your application supplies replay styles and images.

Use the optional [`taro-plugin`](./docs/guides/taro-plugin.md) build entry for Replay assets, release identity, source-map repair, Worker preparation, and explicit final WeChat sourcemap upload.

See the [Replay guide](./docs/guides/replay.md) for setup, privacy and troubleshooting.

## AI-assisted setup

This repository ships an agent skill for Claude Code, Cursor and other skill-aware tools. It covers new installs, Replay, the build plugin, and migration from `@xumoses/sentry-miniapp` / `@xumoses/sentry-miniapp-replay-taro`:

```sh
npx skills add https://github.com/xumoses/sentry-taro --skill sentry-taro
```

Then ask your agent to "set up Sentry for this Taro app" or "migrate from sentry-miniapp". The skill source is in [`skills/sentry-taro`](./skills/sentry-taro/SKILL.md).

## Documentation

The detailed guides and contribution instructions are currently in Chinese.

| Task                                                                   | Guide                                                                    |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Add context, configure tracing or control Replay                       | [API and configuration](./docs/guides/api.md)                            |
| Attach pages, configure sampling and privacy, or troubleshoot playback | [Replay](./docs/guides/replay.md)                                        |
| Configure Worker compression                                           | [Worker](./docs/guides/worker.md)                                        |
| Integrate a native mini-program with Taro pages                        | [Hybrid applications](./docs/guides/hybrid-apps.md)                      |
| Migrate from the separate SDK and Replay packages                      | [Migration](./docs/migrations/legacy-packages.md)                        |
| Explore integration code or release changes                            | [Example](./examples/taro-react/README.md) · [CHANGELOG](./CHANGELOG.md) |

## Support and contributions

Please [open an issue](https://github.com/xumoses/sentry-taro/issues) with versions, reproduction steps and a minimal example without sensitive data.

Documentation fixes, reproductions and code contributions are welcome. See [CONTRIBUTING](./CONTRIBUTING.md) for the development environment and checks.

## License

Maintained by [xumoses](https://github.com/xumoses) under [MIT](./LICENSE). Built on Sentry core; see [THIRD_PARTY_NOTICES](./THIRD_PARTY_NOTICES) for inherited and bundled dependency notices.
