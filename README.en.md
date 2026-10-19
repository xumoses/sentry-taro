# Sentry for Taro

[![npm beta](https://img.shields.io/npm/v/%40xumoses%2Fsentry-taro/beta)](https://www.npmjs.com/package/@xumoses/sentry-taro)
[![CI](https://github.com/xumoses/sentry-taro/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/xumoses/sentry-taro/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[中文](./README.md) · [Documentation](./website/en/guide/getting-started.md) · [Core concepts](./website/en/guide/concepts.md) · [Report an issue](https://github.com/xumoses/sentry-taro/issues)

`@xumoses/sentry-taro` is a community Sentry SDK for **Taro React WeChat mini programs**. Built on the official `@sentry/core`, it provides error monitoring, performance monitoring and opt-in Session Replay.

- **Error monitoring**: capture exceptions with page, network and device context.
- **Performance monitoring**: sample traces for page loads, network requests and custom operations.
- **Session Replay**: opt-in recording of Taro pages linked to errors. Text and inputs are masked and media is blocked by default.

It currently supports Taro 4.2.x + React 18 + WeChat mini programs and is in **beta**: error ingestion and Replay playback have been verified in WeChat DevTools; device validation is pending.

## Quick start

```sh
npm install @xumoses/sentry-taro@beta
```

```ts
// src/sentry.ts — import './sentry' at the top of src/app.tsx
import * as Sentry from '@xumoses/sentry-taro';

Sentry.init({
  dsn: 'https://PUBLIC_KEY@YOUR_SENTRY_HOST/PROJECT_ID',
  sendDefaultPii: false,
  traceNetworkBody: false,
});
```

See the [documentation](./website/en/guide/getting-started.md) for the full steps, Replay setup and configuration. You can also install the [agent skill](./skills/sentry-taro/SKILL.md) and let Claude Code, Cursor and similar tools handle setup or legacy migration:

```sh
npx skills add https://github.com/xumoses/sentry-taro --skill sentry-taro
```

## Documentation

| Topic                                                    | Covers                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------- |
| [Getting started](./website/en/guide/getting-started.md) | Install, initialize, first error, enable Replay               |
| [Core concepts](./website/en/guide/concepts.md)          | Design principles, key terms and capability boundaries        |
| [Session Replay](./website/en/guide/replay.md)           | Page attachment, sampling, privacy, controls, troubleshooting |
| [Taro build plugin](./website/en/guide/taro-plugin.md)   | Replay assets, release identity and sourcemap upload          |
| [API and configuration](./website/en/guide/api.md)       | Init options, integrations, tracing, Replay controls          |
| [Migration](./website/en/guide/migration.md)             | Moving from the `@xumoses/sentry-miniapp` packages            |

The documentation site lives in [`website/`](./website/). See the [CHANGELOG](./CHANGELOG.md) for release changes.

## Support and contributions

Please [open an issue](https://github.com/xumoses/sentry-taro/issues) with versions, reproduction steps and a minimal example without sensitive data. See [CONTRIBUTING](./CONTRIBUTING.md) for the development environment and checks.

## License

Maintained by [xumoses](https://github.com/xumoses) under [MIT](./LICENSE). See [THIRD_PARTY_NOTICES](./THIRD_PARTY_NOTICES) for inherited and bundled dependency notices.
