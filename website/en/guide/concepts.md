# Core concepts

The project in one line: **the official Sentry core + mini-program platform adaptation + opt-in Taro DOM Replay**.

It is not a "browser SDK for mini programs", nor a self-contained monitoring system. It translates what can be observed inside a mini program into the language Sentry already understands.

| Layer                     | Responsibility                                                     | Principle               |
| ------------------------- | ------------------------------------------------------------------ | ----------------------- |
| Sentry service            | Ingest, link and play back Issues, Traces and Replays              | Official protocols only |
| Official `@sentry/core`   | Client, scope, sampling, integrations, event processing, transport | Reuse, don't rewrite    |
| Mini-program adapters     | Errors, network, page lifecycle, storage, stack frames, Worker     | Platform deltas only    |
| Opt-in Replay             | Read Taro DOM → record → coordinate sessions → deliver             | Pay for what you use    |
| Build plugin (build time) | Prepare Replay styles and images, release identity, sourcemaps     | Never enters runtime    |

## Six design principles

### 1. Official semantics are the contract

Public APIs, defaults and data protocols are measured against one pinned official version (`@sentry/core` 10.76.2). Where the official SDK already has a capability, this package uses the official name, parameters and behavior; what you learn in the Sentry docs should hold here too.

Deviations appear only where the platform genuinely differs, and each one must be **documented, configurable and covered by a regression test**. Sharing a name is not compatibility; compatibility is about behavior.

### 2. Adapt to the platform, don't emulate a browser

Mini programs have no browser DOM, BOM or view rendering pipeline. This project does not fake a browser so that the official browser SDK "thinks" it is running in one. Instead it collects data directly with native mini-program capabilities: `wx.request`, page lifecycles, local storage and Workers.

Platform-independent parts reuse the official core; platform-specific parts stay small and explicit. The boundary is decided once, rather than re-arguing "should this behave like a browser?" for every API.

### 3. Record logical UI, not the screen

Replay's data source is the DOM that the Taro runtime maintains in the logic layer: nodes, attributes, text and mutations. It tells you what state the page was in and what the user did, but it does not include native component internals, final layout or pixels.

Replay is therefore an investigation lead, not a video. The build plugin can add styles and images so playback looks closer to the real page, but pixel-perfect reproduction is not promised.

### 4. Pay for what you use

Error monitoring works on its own without pulling in any Replay code. Replay is enabled explicitly through an integration. Worker compression, Canvas capture and the build plugin are all optional.

The package layout follows the same rule: ESM first with clear export boundaries, so build tools can drop what you don't use. Mini-program package size is a hard constraint, and every layer is accountable for its own weight.

### 5. Privacy is strict by default

By default the SDK does not send personal information or capture network bodies. Replay masks all text and inputs and blocks all media. Loosening privacy is an explicit, local choice, such as marking reviewed static copy with `sentry-unmask`.

Masking only applies to recorded content. Exception messages, tags and context you pass yourself remain your responsibility.

### 6. Support means verified

"Supported" means verified end to end in the declared environment: the service ingests the event, errors and replays are linked correctly, and the replay actually plays back.

Exporting an API of the same name, passing type checks, passing local tests, or having a request accepted by the server is only one piece, and none of them alone counts as support. The docs explicitly distinguish **supported, unsupported and pending verification**.

## Key terms

| Term                  | Meaning                                                                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unified package       | Only `@xumoses/sentry-taro` is published; the SDK, Replay and build plugin release together                                                                 |
| Taro DOM recording    | A recording that Sentry Replay can rebuild, sourced from the logical UI state observable in the Taro runtime                                                |
| Recording mode        | `session`: sampled per session and uploaded continuously; `buffer`: keeps a rolling pre-error window locally and decides on upload when an error occurs     |
| Replay identity       | A replay's ID. Switching pages or sending segments does not create a new one; a buffer promoted to a session keeps its original error-sampling identity     |
| Page bridge           | The platform hook the Replay integration exposes for the visible page root, scrolling and viewport; in hybrid apps the host hands it to Taro pages          |
| Lifecycle owner       | Whoever attaches and releases the recording root on page show/hide: the global `installTaroReplayPageLifecycle` or per-page `useTaroReplayRoot`, never both |
| Build time vs runtime | The build plugin runs only in Node.js during the build to prepare assets and identity; runtime code never imports it                                        |

## Capability boundaries

| This project provides                                           | This project does not provide                                        |
| --------------------------------------------------------------- | -------------------------------------------------------------------- |
| Errors, breadcrumbs, scopes and tracing on the official core    | Full browser DOM/BOM emulation                                       |
| Session Replay based on the Taro DOM, privacy-masked by default | Screen video, pixel-perfect reproduction, native component internals |
| Taro build plugin: Replay assets, release, sourcemaps           | Browser Replay selector options or a feedback dialog UI              |
| Optional Worker compression and hybrid native + Taro setups     | Official support for H5, other mini-program platforms or mini games  |

Code for other mini-program platforms and mini games is kept and still compiles and passes tests, but it is outside the current development and validation scope.

## Further reading

These principles map to the design principles and architecture decision records (ADRs) in the repository, written in Chinese, for readers who want more depth or plan to contribute:

- [Design principles](https://github.com/xumoses/sentry-taro/blob/main/docs/design-principles.md)
- [ADR-0002 Staged official API alignment](https://github.com/xumoses/sentry-taro/blob/main/docs/adr/0002-stage-official-api-alignment.md)
- [ADR-0003 Mini-program platform adaptation](https://github.com/xumoses/sentry-taro/blob/main/docs/adr/0003-mini-program-platform-adaptation.md)
- [ADR-0004 ESM, CJS and Worker artifacts](https://github.com/xumoses/sentry-taro/blob/main/docs/adr/0004-esm-cjs-worker-artifacts.md)
- [ADR-0005 Layered incremental refactor](https://github.com/xumoses/sentry-taro/blob/main/docs/adr/0005-layered-structural-refactor.md)
