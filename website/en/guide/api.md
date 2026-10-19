# API and configuration

This page covers the SDK APIs and Replay controls used in day-to-day integration. For first-time installation see [Getting started](./getting-started); for page recording see [Session Replay](./replay).

## Initialization and context

Call `Sentry.init()` once at application startup, before App and Page registration. Common options:

| Option                     | Purpose                                                             |
| -------------------------- | ------------------------------------------------------------------- |
| `dsn`                      | Ingest address of your Sentry project                               |
| `environment`              | Distinguishes development, staging and production                   |
| `release`                  | Application version identifier, e.g. `my-miniapp@1.0.0`             |
| `sampleRate`               | Error event sample rate; tracing and Replay are sampled separately  |
| `beforeSend`               | Modify or filter error events before sending; return `null` to drop |
| `beforeBreadcrumb`         | Modify or filter breadcrumbs; return `null` to drop the entry       |
| `sendDefaultPii`           | Controls upstream default PII collection; set `false` explicitly    |
| `traceNetworkBody`         | Request and response body capture, off by default                   |
| `enableConsoleBreadcrumbs` | Console breadcrumbs, off by default                                 |

Default integrations cover global errors, unhandled promise rejections, page and network breadcrumbs, sessions and system information. Replay requires adding its integration separately. The default `rewriteFramesIntegration()` rewrites WeChat device stack frames to the same `https://usr/…` names used by the [taro-plugin upload](./taro-plugin).

Use these from pages or modules after initialization:

```ts
import * as Sentry from '@xumoses/sentry-taro';

Sentry.setTag('feature', 'demo');
Sentry.setContext('screen', { name: 'example', mode: 'preview' });
Sentry.addBreadcrumb({
  category: 'ui.action',
  message: 'Opened example panel',
  level: 'info',
});

Sentry.captureException(new Error('Synthetic example error'));
Sentry.captureMessage('Synthetic diagnostic message');
```

Only attach data that you need for debugging and that is safe to send. `sendDefaultPii: false` and Replay masking do not scrub exception messages, tags or custom context you pass in yourself.

## Error-capturing integrations

`captureConsoleIntegration` and `httpClientIntegration` share names, parameters and defaults with the official `@sentry/core` / `@sentry/browser` 10.76.2. Neither is enabled by default; add them to `integrations` explicitly. Hosts no longer need to wrap `console.error` or request callbacks themselves:

```ts
import * as Sentry from '@xumoses/sentry-taro';

Sentry.init({
  dsn: 'https://PUBLIC_KEY@YOUR_SENTRY_HOST/PROJECT_ID',
  integrations: [
    Sentry.captureConsoleIntegration({ levels: ['error'] }),
    Sentry.httpClientIntegration({ failedRequestStatusCodes: [[500, 599]] }),
  ],
});
```

`captureConsoleIntegration` re-exports the core implementation unchanged:

| Option    | Default                                                    | Description                                  |
| --------- | ---------------------------------------------------------- | -------------------------------------------- |
| `levels`  | `debug`, `info`, `warn`, `error`, `log`, `assert`, `trace` | Console levels to report                     |
| `handled` | `true`                                                     | Written to `mechanism.handled`; can be false |

If an argument is an `Error`, it is reported as an exception; otherwise the arguments are joined into a message with the matching `level`, `logger` set to `console`, and the original arguments in `extra.arguments`. Objects are joined as `[object Object]` per the official rules. The mechanism is `auto.core.capture_console`. An `Error` object already reported by the global error handler is not reported again. When `levels` includes `warn`, the few `console.warn` notices the SDK prints itself (for example during initialization) are reported too; the offline-cache write failure notice bypasses the console wrapper, so it cannot loop.

`httpClientIntegration` creates error events from HTTP responses received by platform request APIs (`wx.request`, `Taro.request`, Alipay `my.request` / `my.httpRequest`, and so on):

| Option                     | Default        | Description                                                              |
| -------------------------- | -------------- | ------------------------------------------------------------------------ |
| `failedRequestStatusCodes` | `[[500, 599]]` | `[from, to]` inclusive ranges and single status codes, can be mixed      |
| `failedRequestTargets`     | `[/.*/]`       | Strings (substring match) or regexes matched against the full caller URL |

The event shape matches the official one: message and exception value are `HTTP Client Error with status code: <status>`, `request` contains `url` and `method`, `contexts.response` contains `status_code`, and `mechanism.handled` is `false`. Request headers, response headers and cookies are attached only with `sendDefaultPii: true` or when `dataCollection` allows it, and sensitive fields are replaced with `[Filtered]` per core rules. Sentry's own ingest requests never trigger events.

Differences from the official implementation:

- `request.url` drops credentials, query and fragment, matching the URL policy of network breadcrumbs and Replay network details; the official SDK keeps the full URL. `failedRequestTargets` still matches the full URL per official semantics, locally only.
- The mechanism type is `auto.http.client.request`; the official SDK uses `auto.http.client.fetch` or `auto.http.client.xhr` depending on the source.
- Only requests that receive an HTTP response (the `success` callback) are handled. Timeouts, network loss and other `fail` callbacks produce no event, matching the official behavior for failed fetches.
- Request headers come from the caller's `header` / `headers`, excluding the SDK-injected `sentry-trace` / `baggage`. Response cookies are read from the `Set-Cookie` header first, then from WeChat's `cookies` array.
- It reuses the single wrapper that the default `NetworkBreadcrumbs` integration installs on request APIs, so platform methods are not patched twice. With `defaultIntegrations: false`, also add `new Sentry.Integrations.NetworkBreadcrumbs()`, or no events are produced.

Both integrations have local core-pipeline tests; end-to-end validation in WeChat DevTools and desktop WeChat is pending.

## Performance monitoring

Set `tracesSampleRate` or `tracesSampler` in your existing `init` options. This example samples 10% of traces and limits trace header propagation to an example API; replace it with your own backend.

```ts
import * as Sentry from '@xumoses/sentry-taro';

Sentry.init({
  dsn: 'https://PUBLIC_KEY@YOUR_SENTRY_HOST/PROJECT_ID',
  sendDefaultPii: false,
  traceNetworkBody: false,
  tracesSampleRate: 0.1,
  tracePropagationTargets: [/^https:\/\/api\.example\.com\//],
});
```

With trace sampling configured, the SDK enables lifecycle tracing for page loads and navigation by default, and creates `http.client` spans for platform requests. Disable page tracing with `enablePageTracing: false`. Additional metrics from platform performance APIs depend on the runtime.

`tracesSampler` takes precedence over `tracesSampleRate`. `tracePropagationTargets` controls which requests get trace headers; `[]` disables propagation but does not turn off local request spans.

Wrap operations you want to time with `startSpan`:

```ts
import * as Sentry from '@xumoses/sentry-taro';

const result = Sentry.startSpan({ name: 'prepare-demo-data', op: 'function' }, () => {
  return ['alpha', 'beta', 'gamma'].map((value) => value.toUpperCase());
});
```

## Replay controls

After adding `replayIntegration()` and attaching pages, `Sentry.getReplay()` returns the current client's integration, or `undefined` if none is registered.

| Method                                | Behavior                                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------------------------- |
| `start()`                             | Starts session recording manually; works even when automatic sample rates are 0               |
| `startBuffering()`                    | Starts local buffering manually, waiting for an error or an explicit send                     |
| `flush()`                             | Sends session segments; in buffer mode sends the buffer and continues as a session by default |
| `flush({ continueRecording: false })` | Sends the buffer and stops recording, keeping the buffer identity                             |
| `stop()`                              | Stops recording; by default sends remaining session data and discards an unsent buffer        |
| `stop({ flush: true })`               | Stops recording and tries to send remaining session or buffer data                            |
| `getReplayId()`                       | Current Replay identity; `undefined` when stopped or disabled                                 |
| `getRecordingMode()`                  | Returns `session`, `buffer` or `undefined`                                                    |

Manual starts also need an attached visible page. While a session or buffer is active, `start()` / `startBuffering()` do not create a new identity or switch modes. `flush()` tries to start a session when nothing is running; call `stop()` to stop completely.

`continueRecording: false` only affects buffers; session mode ignores it and keeps recording. A retained buffer identity may be resampled by activity after it expires. To begin a new recording immediately, `await replay.stop()` first, then call `replay.start()` or `replay.startBuffering()`.

To send recordings and SDK events explicitly, call them in this order:

```ts
import * as Sentry from '@xumoses/sentry-taro';

async function flushMonitoring() {
  await Sentry.getReplay()?.flush();
  return Sentry.flush(2000);
}
```

`Sentry.flush(timeout)` only waits for SDK transport; it does not drain the recorder. The default minimum recording duration is 4,999 ms. A Replay `flush()` before that point schedules a delayed send and returns, and an immediate SDK `flush()` cannot upload earlier. Stopping explicitly at that point discards the short recording.

Replay's public `flush()` / `stop()` never surface transport errors as promise rejections. Inspect diagnostics through the integration's `onError` or `replay.bridge.getSnapshot()`, and confirm final ingestion and playback in Sentry.

`bridge` handles page and viewport adaptation. The legacy `bridge.flush()` only sends session segments, and `bridge.sendBufferedReplay()` sends a buffer explicitly; new integrations should prefer the integration methods above.

## Session defaults

| Option or behavior    | Default                                                        |
| --------------------- | -------------------------------------------------------------- |
| `minReplayDuration`   | 4,999 ms, configurable from 0 to 50,000 ms                     |
| Pre-error buffer      | 60 seconds; byte and event budgets may shorten the real window |
| `maxReplayDuration`   | 60 minutes, can be shortened                                   |
| `sessionIdlePauseMs`  | Session recording pauses after 5 minutes without interaction   |
| `sessionIdleExpireMs` | Session expires after 15 minutes without interaction           |

The local pre-error buffer uses a rolling window and does not apply the full-session idle policy. Buffering, the segment queue and retries all have resource limits; see [Session Replay](./replay).

## Entry points and capability boundaries

| Entry point                            | Purpose                                                                                                   |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `@xumoses/sentry-taro`                 | SDK, `replayIntegration` and public types                                                                 |
| `@xumoses/sentry-taro/taro/lifecycle`  | Global Taro page lifecycle adapter                                                                        |
| `@xumoses/sentry-taro/react/root`      | `useTaroReplaySnapshot` and per-page `useTaroReplayRoot`                                                  |
| `@xumoses/sentry-taro/react`           | Low-level single-recording hook; does not resume after hide/unload                                        |
| `@xumoses/sentry-taro/taro-plugin`     | Node build plugin, artifact preparation and final sourcemap upload; see the [plugin guide](./taro-plugin) |
| `@xumoses/sentry-taro/worker`          | Standalone Worker asset copied at build time                                                              |
| `@xumoses/sentry-taro/devtools/server` | Server entry of the local capture viewer                                                                  |

The bundled viewer only shows capture summaries, events and JSON; it does not render actual replays. Use Sentry for playback.

This package does not provide a full browser DOM/BOM, browser Replay selector options or a feedback dialog. `showReportDialog()` is a compatibility no-op; `captureFeedback()` submits feedback data without creating UI.

Logs/Metrics exports are kept and disabled by default; whether they work also depends on your ingest service, and they are outside the current validation scope. For API and default-behavior changes between versions, see the [runtime migration notes](https://github.com/xumoses/sentry-taro/blob/main/docs/migrations/phase-two-runtime.md) (Chinese).
