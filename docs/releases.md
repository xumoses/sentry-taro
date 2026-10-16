# npm 发布流程

常规发布采用统一更新版本、Git tag 触发 GitHub Actions、人工审批后通过 npm OIDC trusted publishing 发布。`@xumoses/sentry-taro@0.1.0-beta.5` 已于 2026-10-16 通过该流程公开发布；`beta` 当前指向 `0.1.0-beta.5`，`latest` 保留在 `0.1.0-beta.1`。推荐固定版本或显式使用 `@beta`。准备命令只验证和生成候选；每次真正发布前必须停下，提交确切产物和检查结果供用户确认。

首版通过常规 npm 认证发布；`0.1.0-beta.2` 首次完成 OIDC 发布，`0.1.0-beta.3`、`0.1.0-beta.4` 和 `0.1.0-beta.5` 也已完成远端准备、Environment 审批暂停、用户批准后发布、registry 完整性和公开安装验证。`NPM_OIDC_PUBLISH_ENABLED=true`。证据见[首版发布记录](./implementation/phase-two.md#首次-npm-发布结果)、[首次 OIDC 发布记录](./implementation/phase-two.md#首次-oidc-发布结果)、[Taro 构建插件版本发布](./implementation/phase-two.md#taro-构建插件版本发布)、[微信最终映射兼容修复版本发布](./implementation/phase-two.md#微信最终映射兼容修复版本发布)及[Swiper 与共享分包映射修复版本发布](./implementation/phase-two.md#swiper-与共享分包映射修复版本发布)。

## CI、Git tag 与 npm 标签

[CI 工作流](../.github/workflows/ci.yml) 负责日常验证；[发布工作流](../.github/workflows/publish.yml) 由推送 `v*` Git tag 触发。Git tag 用来标记源码提交，例如 `v0.1.0-beta.2`；npm 的 `beta` 是指向某个已发布版本的 dist-tag，两者独立。

版本和安装渠道固定对应如下，发布时仍显式传入 `--tag`，不依赖版本名称自动选择渠道。参见 [npm dist-tags 文档](https://docs.npmjs.com/adding-dist-tags-to-packages/)。

| 版本格式        | npm dist-tag |
| --------------- | ------------ |
| `1.2.3`         | `latest`     |
| `1.2.3-alpha.1` | `alpha`      |
| `1.2.3-beta.1`  | `beta`       |
| `1.2.3-rc.1`    | `rc`         |

## 统一更新版本

显式指定下一个版本，例如：

```sh
vp run release:version 0.1.0-beta.6
```

命令同步根目录、`packages/sdk`、`packages/replay` 三个 `package.json` 的版本、SDK 的 `SDK_VERSION` 和根包 `publishConfig.tag`。支持稳定版本及 `alpha.N`、`beta.N`、`rc.N` 预发布版本。它不自动提交、不创建或推送 Git tag，也不发布包。

检查版本改动，并更新 `CHANGELOG.md` 中对应版本的说明；审查和提交后合入 `main`。发布 tag 必须严格等于 `v<package.json 的版本>`，且 tag 对应提交必须已包含在 `origin/main` 中。当前已发布 `0.1.0-beta.5`，修复默认单页 Swiper 回放分页，以及 Taro 共享分包重复压缩导致的映射失配；后续版本仍须重新准备候选，公开 `beta` 以 registry 实际状态为准。

## 准备候选

先完成冻结依赖安装，并确认实际执行的是项目固定的 Node.js `26.12.0` 和 pnpm `12.13.0`：

```sh
vp env install
vp env current --json
vp exec node --version
vp exec pnpm --version
vp install --frozen-lockfile
vp run release:prepare
```

若 Vite Plus 使用 `system_first`，项目声明不一定覆盖 PATH 中的系统工具。按[开发环境复现说明](./implementation/phase-two.md#开发环境复现)切换当前进程的工具选择，再执行以上命令。准备脚本会验证实际 Node.js 和 pnpm 版本，不以 manifest 声明代替运行结果。

`release:prepare` 默认检查 registry 中的目标版本是否已发布，并进行在线隔离消费；依赖缓存完整时，可运行 `vp run release:prepare --offline`。离线模式使用缓存安装消费者依赖，跳过 registry 版本预检，并给 npm dry-run 加上 `--offline`；其余本地校验保持不变。清单会明确记录 registry 未检查，真正发布前仍须在线确认目标版本可用。准备顺序为：

1. 检查工具版本、统一版本号与发布渠道。
2. 执行格式与静态检查、类型检查和完整测试。
3. 通过 `vp pm pack` 调用 `prepack`，重新构建并验证 exports、类型、sourcemap、许可证和独立 Worker。
4. 执行消费者 bundle 检查及 tarball 隔离安装、严格类型和运行时检查。
5. 对确切 tarball 执行 `npm publish --dry-run --ignore-scripts`，检查拟发布内容；不向 registry 发布。

每次准备使用独立目录 `.artifacts/releases/<unique-id>/`，保存 tarball 与 `release.json` 清单。以本次清单和输出为准记录包名、版本、校验值及检查结果，不复用其他目录下同名 `.tgz` 的结论。即使版本号不变，重新打包也必须重新核对校验值；之前的宿主或服务验收只属于其记录的产物。历史候选与验收边界见[第二阶段记录](./implementation/phase-two.md)。

准备成功后暂停。给用户呈现本次 tarball 路径、校验值、版本、npm 标签和验证结果。`release:prepare` 始终只做 dry-run，没有自动切换为真实发布的分支。dry-run 成功不等于已通过 registry 的发布权限、OIDC 信任校验或二次验证。

## GitHub 与 npm 的一次性设置

在 GitHub 仓库设置中创建名为 `npm` 的 Environment，并核对：

1. Required reviewers 为 `xumoses`。
2. 允许本人审批，即不勾选 Prevent self-review；个人维护者才能批准自己推送 tag 触发的发布。
3. 禁止管理员绕过保护规则。
4. Deployment branches and tags 仅允许 Tag 类型的 `v*`，不添加分支放行规则。

公开仓库可使用 Required reviewers。仅在 YAML 中声明 `environment: npm` 不会自动增加审批规则：若环境不存在，GitHub 会自动创建没有保护规则的环境，因此必须先在远端配置并读回核验。参见 [GitHub 审批规则](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments#required-reviewers)和[环境配置说明](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)。

仓库 Actions 变量 `NPM_OIDC_PUBLISH_ENABLED` 初始设为 `false`。变量缺失或不等于 `true` 时，tag 工作流只准备候选，不进入发布 job。只有 npm 信任关系和 GitHub 审批规则都已核验后才能启用该变量；它不能替代每次发布的人工审批。

包已存在后，在 npm 的包设置中添加 GitHub Actions trusted publisher，准确填写：

| 配置项               | 值                      |
| -------------------- | ----------------------- |
| Organization or user | `xumoses`               |
| Repository           | `sentry-taro`           |
| Workflow filename    | `publish.yml`，不带目录 |
| Environment name     | `npm`                   |
| Allowed actions      | 允许 `npm publish`      |

工作流只在发布 job 授予 `id-token: write`，使用 GitHub hosted runner，不配置 `NPM_TOKEN`。npm 根据仓库、工作流和 Environment 的 OIDC 身份决定是否允许发布，并为公开仓库的发布生成 provenance。`npm whoami` 不能验证 OIDC 发布权限，dry-run 也不能代替真实信任交换。npm 当前要求 trusted publishing 使用 npm CLI ≥11.5.1、Node ≥22.14.0；工作流应固定经过验证且彼此兼容的工具版本。参见 [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)。

新建 trusted publisher 必须在两天内完成首次成功发布，否则会过期。因此应在后续 tag 发布候选准备好时绑定，而非在首次手动发布后立即创建并长期闲置。配置成功不代表发布已经成功；是否启用必须以当时的远端设置和候选状态为准。

## 首次发布的初始化

npm 的 [`npm trust` 前提](https://docs.npmjs.com/cli/v12/commands/npm-trust/#prerequisites)明确要求包已存在，账户启用 2FA 且具有包写权限。本项目已在首次发布确认后，通过常规 npm 认证发布真实的 `0.1.0-beta.1` 候选；之后的版本采用上面的 tag、审批和 OIDC 流程。以下保留首次初始化的操作边界。

不要用 `npm stage publish` 绕过首次发布确认。对不存在的包，该命令会立即公开 `0.0.0-stage` 占位版本，只有待审批版本的内容继续保留在 staging 区。这同样是外部发布行为，本流程不主动用 stage 命令创建占位版本。参见 [npm staged publishing](https://docs.npmjs.com/staged-publishing/)。本次普通 `npm publish` 后 registry 也出现了 `0.0.0-stage`，实际版本和渠道状态保存在发布结果中。

首次发布前，用 `npm whoami --registry=https://registry.npmjs.org/` 核对当前登录身份；未登录时使用 `npm login --registry=https://registry.npmjs.org/`，按 npm 要求完成 2FA。凭据不得写进仓库、发布清单或公开日志。登录成功与目标包的发布权限仍需分别确认。首次直接发布的认证要求见 [npm scoped 包发布说明](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/#direct-publishing)。

取得用户对确切候选的发布确认后，在线确认该包名及版本尚未发布，核对 tarball 与清单中的校验值，再发布用户批准的文件。以下路径为占位符，应替换为本次准备输出的实际路径：

```sh
npm publish ./确切.tgz --tag beta --access public --registry=https://registry.npmjs.org/ --ignore-scripts
```

发布的是已经检查的 tarball，不再从工作目录重新打包。该命令禁用生命周期脚本，因此不能依赖 `prepublishOnly` 重新跑门槛；所有检查已由 `release:prepare` 显式执行。若代码、manifest 或文档继续变化，应重新准备候选并重新确认。npm 同名同版本不能重复发布，详见 [npm publish 文档](https://docs.npmjs.com/cli/v11/commands/npm-publish/)。

发布完成后核对 registry 中的版本、`beta` 指向和 `dist.integrity`，下载 registry 的实际 tarball 再进行隔离消费验证。首次本地发布不等于完成 OIDC 发布验证。更新公开状态与宿主依赖应依据实际发布后验证结果。

## 常规 tag 发布

1. 使用 `release:version` 更新版本与渠道，更新 CHANGELOG，审查并提交合入 `main`。
2. 核对 npm trusted publisher、`npm` Environment 审批规则和仓库变量，确认该版本未发布。
3. 在明确允许推送发布 tag 后，创建并推送与版本一致的 `v<version>` tag。
4. `prepare` job 校验 tag 和源码提交，执行完整 `release:prepare`，上传 tarball 与 `release.json` 为 Actions artifact。
5. 变量启用时，`publish` job 等待 `npm` Environment 审批。审批前检查本次 run 的源码提交、候选清单、tarball 校验值、版本、渠道及验证结果；未取得用户发布确认时不要批准。
6. 审批后，发布 job 按 artifact ID 下载同一 run 的候选，核验 SHA-512 完整性和源码提交，再对确切 `.tgz` 执行 `npm publish --ignore-scripts --tag <channel> --access public --provenance`。发布 job 不重新构建或打包，也不使用长期 npm token。
7. 发布后核对 registry 的版本、`dist.integrity` 与渠道指向，再进行公开包消费和宿主验收。

若候选的源码、manifest 或文档发生变化，应重新准备和审查候选，不能沿用旧校验值或审批。npm 同名同版本不能重复发布；发布 job 若在上传成功后失败，应先检查 registry 状态，不要直接重跑发布。参见 [npm publish 文档](https://docs.npmjs.com/cli/v12/commands/npm-publish/)。

npm 接受上传后还会进行扫描，可安装性会延迟，官方说明通常约五分钟，繁忙时可能超过十五分钟。发布后校验只重试查询和下载：最多 41 次，每次间隔 30 秒，发布 job 超时为 30 分钟。暂未可见、限流、服务端错误和网络超时可重试；已存在版本的 hash、渠道或 tarball 来源不符立即失败。等待期间不要重新执行发布。参见 [npm 发布扫描说明](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/)。

## 验收边界

`0.1.0-beta.5` 的 [Actions run 38842775478](https://github.com/xumoses/sentry-taro/actions/runs/38842775478) 已验证远端 tag 工作流、审批暂停、OIDC 发布及发布后 registry 核验。该结果对应本次源码提交和确切产物；后续版本仍须完成各自检查与审批，本地 dry-run 不能代替远端执行证据。

iOS/Android 真机、体验版及微信上传包体积仍待各自验收。本地检查、tarball 消费、真实 Sentry 接收、Playback、远端 CI 和设备表现是不同证据；发布 beta 不自动补齐这些结论，也不自动弃用旧包。
