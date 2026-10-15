# Taro Replay build plugin

Status: implemented and locally validated, 2026-10-15. Not published.

Expose `@xumoses/sentry-taro/taro-plugin` as a Node-only entry in the existing
package. The runtime entry stays independent of the compiler and its parsers.
The plugin prepares Replay resources, build identity, precise source maps, and optional
Worker output. An explicit post-WeChat-build helper uploads final source maps through
the official CLI. It does not publish application assets.

## Interface and official alignment

The default export follows Taro's `(ctx, options)` plugin contract. Common
options `disable`, `silent`, `debug`, and `errorHandler` follow the corresponding
Sentry bundler-plugin conventions: disabled plugins do nothing, silent suppresses
plugin logs, and errors fail the build unless a supplied handler returns normally.
Taro-specific options live under `replay`, including source/output/app roots,
route prefix, compact resource encoding, and image priority.

Only implemented options are accepted. Build and upload stages expose the corresponding
official release/sourcemaps fields; unsupported telemetry, Debug IDs, source rewriting,
and deployment management are rejected. Final transformed WeChat source maps remain
associated with the frozen identity in the uploaded artifact. Upload does not regenerate it.

The default JSON output is consumed through the optional runtime
`createReplayAssetProviders` helper, without importing not-yet-generated code
or rewriting compiled application JavaScript. Module output retains the native
host require-based integration.

The same entry exports `generateReplayAssets(options)` for custom build pipelines
that copy output into a native host before resource generation. This avoids relying
on ordering between unrelated `onBuildFinish` callbacks.

## Migration

- Move generic WXSS conversion/import expansion, route dependency discovery,
  static image auditing, resource budgets, compressed manifests, and generated
  runtime factories into the package.
- Discover trusted SVGs throughout the configured source root, including page
  and component directories; admit only exact source-backed bytes referenced by
  a route's emitted JavaScript dependency graph. Do not follow source symlinks.
- Migrate generic build identity creation, artifact serialization/validation, independent
  Worker copying, and native bundled-dependency exclusion hints.
- Migrate Webpack/Taro prefix-offset repair and final WeChat ZIP/directory normalization,
  companion preparation, filtering, and official CLI release/upload/finalize.
- Keep application copying, business release naming, WeChat upload/download, native npm
  orchestration, asset publication, and project priorities as caller responsibilities.
- Use synthetic tests for page-local SVG coverage, route isolation, import order,
  budgets, path containment, compact resource readers, and plugin error behavior.
- Verify the packed Node entry in an isolated consumer and verify generated
  runtime modules against the mini-program syntax floor. Recompute a private
  host's resources without copying its source or data into public fixtures.

## Validation

- Synthetic plugin/provider regressions cover source-local SVG discovery, per-route
  resources, styles, budgets, emitted ES2015 modules, watch rebuilds, diagnostics,
  JSON decoding/retries, and a real oversized stylesheet rejected before writing.
- Full repository tests, release-script tests, type/lint/format checks, package
  verification, production consumer bundles, and isolated tarball consumption pass.
- A real Taro 4.2.0 / Webpack 5 synthetic application loads the packaged plugin,
  executes its build hooks, and consumes the JSON artifact through the SDK helper.
  Production subpackage prefix insertion and strict-directive relocation retain exact
  original line/column mappings. Executing the emitted SDK confirms injected release/dist,
  explicit init overrides, and agreement with the frozen metadata artifact.
  The resolved runner config also confirms full source maps and MutationObserver support.
  The environment's Taro doctor system-proxy check requires `--no-check`; compilation
  and the plugin hook still run normally.
- A private host's existing build output passes differential comparison: original
  styles and image mappings remain identical, while the intended page-local SVGs
  are now included within budget. Original evidence remains outside this public repo.
- No npm publication, host dependency upgrade, trial deployment, or device Playback
  acceptance is implied by these local checks.
- Final archive normalization and upload orchestration are covered with synthetic files
  and a mocked official CLI; no real Sentry release or source-map upload is performed.
  The isolated tarball consumer loads both plugin module formats without Node type globals
  or an installed CLI, copies the exact installed Worker, and only requires the CLI on upload.

## References

- [Sentry webpack plugin options](https://www.npmjs.com/package/@sentry/webpack-plugin)
- [Taro plugin contract](https://docs.taro.zone/en/docs/plugin)
