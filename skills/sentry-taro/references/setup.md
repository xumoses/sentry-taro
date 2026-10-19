# Setup: errors and tracing

## Install

```sh
pnpm add @xumoses/sentry-taro@beta
# npm install @xumoses/sentry-taro@beta
# yarn add @xumoses/sentry-taro@beta
```

Use the project's package manager. Always install `@beta` or an exact version (e.g. `@xumoses/sentry-taro@0.1.0-beta.6`): the npm `latest` tag still points to the old `0.1.0-beta.1`, so a bare `@xumoses/sentry-taro` installs an outdated build.

Peer dependencies (`@tarojs/taro` / `@tarojs/runtime` `~4.2.0`, `react` `^18`) are optional and come from the Taro project. `@sentry/cli` is only needed for sourcemap upload (see `build-plugin.md`).

## Init module

Create one module that owns initialization, e.g. `src/sentry.ts`:

```ts
import * as Sentry from '@xumoses/sentry-taro';

Sentry.init({
  dsn: 'https://PUBLIC_KEY@YOUR_SENTRY_HOST/PROJECT_ID',
  environment: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  sendDefaultPii: false,
  traceNetworkBody: false,
});

export { Sentry };
```

Import it as the **first** statement of the Taro app entry, keeping all existing entry code:

```ts
// src/app.ts or src/app.tsx
import './sentry';
```

Do not call `init` inside `onLaunch` / a component — the SDK must wrap `App`/`Page` registration to get lifecycle breadcrumbs, the first session, and startup timing.

If the project already defines env-based config (`defineConstants`, `.env` files), read the DSN from there rather than hard-coding it.

## Common options

| Option                                                          | Notes                                                                                                 |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `dsn`                                                           | Sentry project DSN. Without it nothing is sent.                                                       |
| `environment`, `release`, `dist`                                | `release` must match the release used for sourcemap upload. The build plugin can inject it.           |
| `sampleRate`                                                    | Error event sampling (0–1).                                                                           |
| `tracesSampleRate` / `tracesSampler`                            | Enables tracing; `tracesSampler` wins if both are set.                                                |
| `tracePropagationTargets`                                       | Which request URLs receive `sentry-trace`/`baggage`. Use anchored regexes; `[]` disables propagation. |
| `enablePageTracing`                                             | Page load/navigation spans when tracing is on (default on).                                           |
| `beforeSend`, `beforeBreadcrumb`                                | Return `null` to drop.                                                                                |
| `sendDefaultPii`                                                | Write `false` explicitly.                                                                             |
| `traceNetworkBody`                                              | Request/response bodies in breadcrumbs. Default off; keep off.                                        |
| `enableConsoleBreadcrumbs`                                      | Default off.                                                                                          |
| `enableOfflineCache`, `offlineCacheLimit`, `offlineCacheMaxAge` | Weak-network offline queue.                                                                           |
| `requireConsent`                                                | Buffer events until `Sentry.setConsent(true)`.                                                        |
| `ignoreErrors`, `allowUrls`, `denyUrls`                         | Event filtering.                                                                                      |
| `enableLogs`, `enableMetrics`                                   | Default `false`. Exported but not validated against all Sentry servers.                               |

Default integrations (global errors, unhandled rejections, page and network breadcrumbs, sessions, system info, dedupe, …) are added automatically. Passing an `integrations` **array** merges with defaults. To remove some defaults use the callback form:

```ts
integrations: (defaults) => defaults.filter((i) => i.name !== 'NetworkStatus'),
```

`defaultIntegrations: false` removes all defaults — avoid unless the user explicitly wants a minimal SDK.

## Opt-in integrations

Both are off by default and match the official `@sentry/browser` 10.76.2 names and options:

```ts
Sentry.init({
  // ...
  integrations: [
    Sentry.captureConsoleIntegration({ levels: ['error'] }),
    Sentry.httpClientIntegration({ failedRequestStatusCodes: [[500, 599]] }),
  ],
});
```

- Use these instead of hand-wrapping `console.error` or request callbacks. If the project already has such wrappers, offer to remove them to avoid duplicate events.
- `httpClientIntegration` only reports requests that received an HTTP response; timeouts/offline failures do not produce events. It depends on the default `NetworkBreadcrumbs` integration — with `defaultIntegrations: false`, also add `new Sentry.Integrations.NetworkBreadcrumbs()`.

## Tracing

```ts
Sentry.init({
  // ...
  tracesSampleRate: 0.1,
  tracePropagationTargets: [/^https:\/\/api\.example\.com\//],
});

const result = Sentry.startSpan({ name: 'load-order', op: 'function' }, () => compute());
```

Replace the example API origin with the user's backend origin. Propagating trace headers to a backend requires that backend to accept `sentry-trace` and `baggage` headers (CORS is not involved in mini programs, but gateways may strip/deny unknown headers).

## Context APIs

```ts
Sentry.setUser({ id: 'user_123' }); // also attached to Replay events; avoid emails/names unless the user approves PII
Sentry.setTag('feature', 'checkout');
Sentry.setContext('screen', { name: 'checkout' });
Sentry.addBreadcrumb({ category: 'ui.action', message: 'Tapped pay', level: 'info' });
Sentry.captureException(err);
Sentry.captureMessage('Something noteworthy', 'warning');
Sentry.captureFeedback({ message: 'Page froze' }); // data only, no UI
```

Breadcrumbs are only sent with the next event. `showReportDialog()` is a no-op — mini programs have no DOM; build a native form and call `captureFeedback`.

## React error boundary

Taro React swallows render errors inside components unless an error boundary reports them. If the project has no boundary, offer a minimal one:

```tsx
import { Component, type PropsWithChildren } from 'react';
import * as Sentry from '@xumoses/sentry-taro';

export class SentryErrorBoundary extends Component<PropsWithChildren, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown, info: { componentStack?: string }) {
    Sentry.withScope((scope) => {
      scope.setContext('react', { componentStack: info.componentStack });
      Sentry.captureException(error);
    });
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}
```

Render a fallback that fits the app instead of `null` when appropriate.

## Flushing before exit

```ts
await Sentry.getReplay()?.flush(); // only if Replay is enabled
await Sentry.flush(2000);
```

`Sentry.flush()` only waits for the SDK transport; it does not drain Replay. The SDK already makes a best-effort flush on app hide.

## Production checklist

- Sentry ingest host added to the WeChat MP console `request` trusted domains.
- `release` (and `dist`) identical in `init`, build metadata, and sourcemap upload — see `build-plugin.md`.
- Sample rates reviewed for real traffic (`tracesSampleRate` 1.0 is for testing only).
