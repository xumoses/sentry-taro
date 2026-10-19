# Contributing

Issues, documentation improvements and code contributions are welcome. For usage, see the [documentation site](./website/en/guide/getting-started.md); maintainer design records are indexed in [docs/](./docs/README.md) (Chinese).

## Reporting issues

Open a [GitHub issue](https://github.com/xumoses/sentry-taro/issues) and include:

- SDK, Taro, React, WeChat base library and DevTools versions; for device issues, also the OS and device model.
- Minimal reproduction steps, expected and actual results, and related error messages.
- Whether the problem happens during initialization, page switching, recording, delivery or playback, and whether it only appears on devices or after building.

Prefer a minimal project or snippet with synthetic data only. Public attachments must not contain real user information, access tokens, internal service addresses, business source code, or event or Replay identifiers. See the [public regression testing plan](./docs/plans/public-regression-testing.md) (Chinese) for how public regressions are handled.

For feature requests, describe the use case and the current limitation first. For larger changes touching the public API, default sampling or privacy policy, please discuss the direction in an issue first.

## Local development

Install the global Vite Plus CLI (`vp`) following the [official Vite Plus guide](https://viteplus.dev/guide/), then clone the repository and enter its root. The development Node.js version is defined by [`.node-version`](./.node-version) and the pnpm version by `packageManager` in [`package.json`](./package.json); Vite Plus and TypeScript are pinned there as well.

```sh
vp env install
vp env current --json
vp exec node --version
vp exec pnpm --version
vp install --frozen-lockfile
```

Confirm the versions actually in use before running checks. If your existing Vite Plus uses `system_first`, the project's version declarations do not override system tools on `PATH`; the [development environment notes](./docs/implementation/phase-two.md#开发环境复现) (Chinese) describe a workaround scoped to the current process.

Development tool versions differ from consumer requirements: consumer Node.js requirements are in `engines` in `package.json`, and the mini-program build target is in [`config/pack.ts`](./config/pack.ts). Dependency resolution and allowed install scripts are managed in [`pnpm-workspace.yaml`](./pnpm-workspace.yaml).

## Code map

| Path                                             | Contents                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------- |
| [`src/`](./src/)                                 | Public entries of the unified package and the Replay integration    |
| [`src/sdk/`](./src/sdk/)                         | Mini-program SDK, platform adapters, transport and Replay recorder  |
| [`src/replay/`](./src/replay/)                   | Replay coordination, Taro/React integration and Worker              |
| [`src/taro-plugin/`](./src/taro-plugin/)         | Node build plugin and Replay asset generation                       |
| [`test/`](./test/)                               | Tests grouped by `sdk`, `replay`, `taro-plugin` and `invariants`    |
| [`devtools/`](./devtools/)                       | Local Replay capture viewer                                         |
| [`config/`](./config/)                           | Build and static analysis configuration                             |
| [`scripts/`](./scripts/)                         | Artifact checks, isolated consumers, versioning and release scripts |
| [`examples/taro-react/`](./examples/taro-react/) | Integration snippets to merge into an existing Taro project         |
| [`website/`](./website/)                         | User documentation site (VitePress, Chinese and English)            |
| [`docs/`](./docs/)                               | Design principles, ADRs, plans and implementation records           |
| [`skills/sentry-taro/`](./skills/sentry-taro/)   | English agent skill for users; not published to npm                 |

Only the root package `@xumoses/sentry-taro` is published. Source lives in `src/` with no internal workspace packages. When changing public entries or packaging configuration, verify type declarations, ESM/CJS entries and the standalone Worker together.

The website guides (`website/guide/` in Chinese and `website/en/guide/` in English), the READMEs and the agent skill in `skills/sentry-taro/` describe the same public behavior. When you change import entries, options, defaults, Replay control semantics, build plugin options or migration steps, update both language versions of the affected guide and the matching skill `references/*.md` (in English), and make sure examples match the source.

## Checking changes

During development you can run `vp run test:sdk` or `vp run test:replay` depending on the scope. `vp run test:invariants` checks the long-term constraints listed in [AGENTS.md](./AGENTS.md); if it fails, revise the corresponding ADR first instead of changing the assertion. Release script tests run with `vp run test:release`. `vp run format` rewrites files, so review the diff before committing to avoid unrelated formatting changes.

These commands match the checks in the [CI workflow](./.github/workflows/ci.yml):

```sh
vp run release:check
vp run test:release
vp check
vp run website:build
vp run typecheck
vp test run
vp pm pack --pack-destination .artifacts
vp run verify:bundles
vp run verify:consumer --online
```

`vp check` runs formatting and lint checks; type checking runs separately. Preview the website locally with `vp run website:dev` and build it with `vp run website:build`; the build fails on dead links. Pushes to `main` that touch the website, dependencies or Node.js version deploy it to Cloudflare Pages (`sentry-taro.pages.dev`) through the [website workflow](./.github/workflows/docs.yml); the job needs the `CLOUDFLARE_API_TOKEN` secret and `CLOUDFLARE_ACCOUNT_ID` variable in the `cloudflare-pages` environment. Documentation-only changes can focus on formatting, links and example accuracy; changes to code, dependencies or release artifacts should pass the full checks.

### Build and tarball verification

| Command                                    | Purpose                                                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `vp pack`                                  | Builds the library's main entry and subpaths; does not produce every release asset                               |
| `vp run build`                             | Full build of the main package, standalone Worker, devtools and type declarations                                |
| `vp run verify:package`                    | Checks entries, declarations, sourcemaps, Worker and license notices of an existing build                        |
| `vp pm pack --pack-destination .artifacts` | Runs `prepack` through pnpm, rebuilding and verifying before creating a local tarball                            |
| `vp run verify:bundles`                    | Checks synthetic consumers' production bundles, on-demand Replay and Worker isolation                            |
| `vp run verify:consumer --online`          | Installs the tarball and checks strict types and SDK runtime behavior in a temporary consumer without React/Taro |

`verify:consumer` uses the tarball in `.artifacts` matching the root package version by default, and also accepts a `.tgz` path. The script runs offline by default and can omit `--online` when the cache is complete; use `--online` in a fresh environment to fetch public npm dependencies. None of these commands publish the package.

To verify a Taro integration, install the exact tarball you just produced into a synthetic host project:

```sh
pnpm add /path/to/candidate.tgz
```

Local tests, isolated consumers, WeChat builds, Sentry ingestion, playback and device behavior are verified separately. In your PR, state which checks you actually ran, the environment, and what was not covered; a successful local in-memory transport does not prove remote ingestion or playback.

## Submitting a pull request

- Keep changes focused, and describe the problem solved, the resulting behavior and the verification; link related issues.
- When fixing a runtime issue, prefer adding a synthetic regression test that reproduces it. Public usage changes should update the Chinese and English website guides, the READMEs where relevant, and the agent skill.
- Write commit messages in English Conventional Commits, e.g. `fix(replay): resume recording after page show`, `docs: clarify replay setup`.
- Don't commit generated `dist/`, `.artifacts/`, credentials or private acceptance materials; include lockfile changes when dependencies change.

Maintainer versioning, candidate preparation and npm publishing are described in the [release process](./docs/releases.md) (Chinese). The project is licensed under [MIT](./LICENSE); retained upstream and bundled dependency notices are in [THIRD_PARTY_NOTICES](./THIRD_PARTY_NOTICES).
