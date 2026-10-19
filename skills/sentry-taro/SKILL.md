---
name: sentry-taro
description: Set up, configure, or migrate to @xumoses/sentry-taro — the Sentry SDK (errors, tracing, opt-in Session Replay) for Taro 4.2 + React 18 WeChat mini programs. Use when a user wants to add Sentry/error monitoring/session replay to a Taro mini program, configure the sentry-taro Taro build plugin, Worker compression or WeChat sourcemap upload, or migrate from @xumoses/sentry-miniapp and/or @xumoses/sentry-miniapp-replay-taro.
---

# @xumoses/sentry-taro

`@xumoses/sentry-taro` is a single package that contains:

- the mini-program Sentry SDK (built on `@sentry/core` 10.76.2): errors, breadcrumbs, scopes, tracing, sessions, offline cache, consent;
- opt-in Session Replay that records the Taro runtime DOM (not a screen video);
- a Node-side Taro build plugin (`/taro-plugin`) for Replay assets, release identity, sourcemap repair, Worker preparation, and WeChat final sourcemap upload.

It replaces the two legacy packages `@xumoses/sentry-miniapp` and `@xumoses/sentry-miniapp-replay-taro`.

**Supported scope (beta):** Taro `4.2.x`, React 18, WeChat mini programs, Node.js ≥ 20, Webpack 5 compiler for the build plugin. Replay does not support H5, other mini-program platforms, Vue/uni-app, mini games, native-page DOM, or native component internals. Say so plainly if the user's project is outside this scope instead of forcing an integration.

## Step 1 — Inspect the project first

Before editing anything, read:

1. `package.json` + lockfile → package manager (`pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `package-lock.json` → npm), `@tarojs/taro` version, `react` version, and whether `@xumoses/sentry-miniapp`, `@xumoses/sentry-miniapp-replay-taro`, `sentry-miniapp`, or `@sentry/*` packages are already installed.
2. The Taro app entry (usually `src/app.ts` / `src/app.tsx`) and app config (`src/app.config.ts`).
3. The Taro build config (`config/index.ts` / `config/index.js`) — `compiler` must be Webpack 5 for the build plugin.
4. Any existing Sentry init module (`grep -rn "Sentry.init\|sentry-miniapp" src`), Worker copy scripts, sourcemap scripts, and CI upload steps.
5. Whether the app is a **hybrid** (native mini-program host that embeds Taro output) — look for a native `app.js`/`app.json` outside the Taro output, or a script that copies Taro `dist` into a native folder.

Then route:

| Situation                                                                                 | Read                                                          |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Legacy `@xumoses/sentry-miniapp` or `@xumoses/sentry-miniapp-replay-taro` is present      | [references/migration.md](references/migration.md) first      |
| New install, errors / tracing only                                                        | [references/setup.md](references/setup.md)                    |
| User wants Session Replay                                                                 | `setup.md`, then [references/replay.md](references/replay.md) |
| Release/dist, sourcemaps, Replay styles/images, Worker files, or hybrid host build output | [references/build-plugin.md](references/build-plugin.md)      |

Ask the user only for things you cannot infer: the DSN (never invent one — use a placeholder and tell them to replace it), whether they want Replay, and target sample rates.

## Step 2 — Non-negotiable rules

- **One SDK, one init.** Call `Sentry.init()` exactly once per app, in a module imported at the very top of the app entry, before `App`/pages are registered. In hybrid apps the native host initializes; Taro code only receives `replay.bridge`. Never initialize again in a subpackage.
- **Never mix packages.** Do not keep `@xumoses/sentry-miniapp` or `@xumoses/sentry-miniapp-replay-taro` alongside `@xumoses/sentry-taro`; two copies of `@sentry/core` break client/scope sharing.
- **Privacy-safe defaults.** Always write `sendDefaultPii: false` and `traceNetworkBody: false` explicitly. Leave Replay masking at defaults (`maskAllText`, `maskAllInputs`, `blockAllMedia` all `true`). Only unmask specific static, non-user content with `sentry-unmask` and tell the user why. Masking does not scrub what the app passes to `captureException`, `setContext`, tags, or breadcrumbs.
- **Replay is opt-in** and needs both `replayIntegration()` in `init` **and** page attachment (`installTaroReplayPageLifecycle` or `useTaroReplayRoot`). One lifecycle owner per page — never both.
- **Secrets stay out of source.** `SENTRY_AUTH_TOKEN`, org and project for uploads come from environment/CI secrets. The DSN is public but should still come from config, not be hard-coded into multiple files.
- **Import paths are exact.** Root `@xumoses/sentry-taro`; subpaths `/taro/lifecycle`, `/react/root`, `/react`, `/taro-plugin`, `/worker`, `/devtools/server`. `/taro-plugin` is Node-only — never import it from mini-program runtime code.
- **Don't overclaim.** Local build and DevTools success does not prove device behavior. Tell the user to verify on target devices and in Sentry (Issues, Replays) after changes.

## Step 3 — Verify

After editing:

1. Install with the project's package manager (`@xumoses/sentry-taro`, optionally pinned to an exact version) and run the project's own typecheck/lint/build.
2. Ask the user to trigger a synthetic error from a test button (`Sentry.captureException(new Error('sentry-taro smoke test'))`) in WeChat DevTools and confirm it appears in Sentry Issues.
3. With Replay: interact with the page for **more than ~5 seconds** before triggering the error (default `minReplayDuration` is 4,999 ms), then confirm the issue links a replay.
4. Confirm the Sentry ingest domain is in the mini program's `request` trusted-domain list (WeChat MP console), otherwise nothing is sent on devices.

Summarize for the user: files changed, what they must fill in (DSN, env vars, sample rates), and what remains unverified.
