# 贡献指南

欢迎提交问题、改进文档和代码。使用方式见 [README](./README.md)，详细接入说明见[文档目录](./docs/README.md)。

## 反馈问题

请在 [GitHub Issues](https://github.com/xumoses/sentry-taro/issues) 中说明：

- SDK、Taro、React、微信基础库和开发者工具版本；真机问题同时注明系统与机型。
- 最小复现步骤、预期结果、实际结果，以及相关错误信息。
- 问题发生在初始化、页面切换、录制、发送还是 Playback；说明是否仅在真机或构建后出现。

优先提供只包含合成数据的最小工程或代码片段。公开附件中不要包含真实用户信息、访问令牌、内部服务地址、业务源码、事件或 Replay 标识。公开回归的具体方式见[回归测试方案](./docs/plans/public-regression-testing.md)。

功能建议请先描述使用场景和当前限制。涉及公共 API、默认采样或隐私策略的较大改动，建议先通过 Issue 讨论方向。

## 本地开发

先按 [Vite Plus 官方指南](https://viteplus.dev/guide/)安装全局 CLI（`vp`），再克隆仓库并进入根目录。开发用 Node.js 版本以 [`.node-version`](./.node-version) 为准，pnpm 版本以 [`package.json`](./package.json) 的 `packageManager` 为准；Vite Plus 与 TypeScript 也由该文件固定。

```sh
vp env install
vp env current --json
vp exec node --version
vp exec pnpm --version
vp install --frozen-lockfile
```

先核对实际执行版本，再运行检查。已有 Vite Plus 若使用 `system_first`，项目版本声明不会覆盖 PATH 中的系统工具；[开发环境复现说明](./docs/implementation/phase-two.md#开发环境复现)提供只影响当前进程的处理方式。

开发工具版本与消费者的 Node.js 要求不同：消费者要求见 `package.json` 的 `engines`，小程序构建目标见 [`config/pack.ts`](./config/pack.ts)。依赖解析和允许的安装脚本由 [`pnpm-workspace.yaml`](./pnpm-workspace.yaml) 管理。

## 代码导航

| 路径                                             | 内容                                         |
| ------------------------------------------------ | -------------------------------------------- |
| [`src/`](./src/)                                 | 统一包的公共入口与 Replay integration        |
| [`src/sdk/`](./src/sdk/)                         | 小程序 SDK、平台适配、传输与 Replay recorder |
| [`src/replay/`](./src/replay/)                   | Replay 协调、Taro/React 接入与 Worker        |
| [`src/taro-plugin/`](./src/taro-plugin/)         | Node 构建插件与 Replay 资源生成              |
| [`test/`](./test/)                               | 按 `sdk`、`replay`、`taro-plugin` 分组的测试 |
| [`devtools/`](./devtools/)                       | 本地 Replay 查看器                           |
| [`config/`](./config/)                           | 构建与静态检查配置                           |
| [`scripts/`](./scripts/)                         | 产物校验、隔离消费、版本管理与发布脚本       |
| [`examples/taro-react/`](./examples/taro-react/) | 可合入现有 Taro 工程的接入片段               |
| [`docs/`](./docs/)                               | 用户指南、设计决策和实施记录                 |
| [`skills/sentry-taro/`](./skills/sentry-taro/)   | 面向使用者的英文 Agent Skill，不随 npm 发布  |

仓库只发布根包 `@xumoses/sentry-taro`，源码集中在 `src/`，没有内部工作区包。修改公共入口或打包配置时，需要同时验证声明文件、ESM/CJS 入口和独立 Worker。

`skills/sentry-taro/` 中的 Agent Skill 与 README、`docs/guides/` 描述同一套公共行为。修改导入入口、配置项、默认值、Replay 控制语义、构建插件选项或迁移步骤时，同步更新 Skill 对应的 `references/*.md`，保持英文，并确认示例与源码一致。

## 检查改动

日常开发可以按改动范围运行 `vp run test:sdk` 或 `vp run test:replay`；发布脚本的测试使用 `vp run test:release`。`vp run format` 会格式化文件，提交前请检查 diff，避免带入无关格式改动。

下面的命令与 [CI 工作流](./.github/workflows/ci.yml) 的检查项一致：

```sh
vp run release:check
vp run test:release
vp check
vp run typecheck
vp test run
vp pm pack --pack-destination .artifacts
vp run verify:bundles
vp run verify:consumer --online
```

`vp check` 执行格式和 lint 检查，类型检查单独运行。纯文档修改可以聚焦格式、链接和示例准确性；涉及代码、依赖或发布产物的改动应通过完整检查。

### 构建与 tarball 验证

| 命令                                       | 用途                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| `vp pack`                                  | 构建库的主入口与子路径，不单独完成全部发布资产                          |
| `vp run build`                             | 完整构建主包、独立 Worker、开发工具和类型声明                           |
| `vp run verify:package`                    | 检查已有构建的入口、声明、sourcemap、Worker 和许可通知                  |
| `vp pm pack --pack-destination .artifacts` | 经 pnpm 执行 `prepack`，重新构建并校验后生成本地 tarball                |
| `vp run verify:bundles`                    | 检查合成消费者的生产 bundle、Replay 按需引入和 Worker 隔离              |
| `vp run verify:consumer --online`          | 安装 tarball，在无 React/Taro 的临时消费者中检查严格类型与 SDK 运行行为 |

`verify:consumer` 默认使用 `.artifacts` 中与根包版本对应的 tarball，也支持指定 `.tgz` 路径。脚本默认离线，缓存完整时可省略 `--online`；新环境使用 `--online` 获取公开 npm 依赖。这些命令不会发布包。

需要验证 Taro 接入时，将刚生成的确切 tarball 安装到合成宿主工程：

```sh
pnpm add /path/to/candidate.tgz
```

本地测试、隔离消费、微信构建、Sentry 接收、Playback 和真机表现分别验证。PR 中写明实际完成的检查、运行环境及未覆盖的范围；本地内存 transport 的成功返回不能证明远端接收或 Playback。

## 提交 Pull Request

- 保持改动集中，说明解决的问题、最终行为和验证结果；有关联 Issue 时附上链接。
- 修复运行时问题时，优先增加能重现问题的合成回归；公共用法变化应同步更新中英文 README 和相关指南。
- 提交说明使用英文 Conventional Commits，例如 `fix(replay): resume recording after page show`、`docs: clarify replay setup`。
- 不提交生成的 `dist/`、`.artifacts/`、凭据或私有验收材料；涉及依赖时提交相应锁文件改动。

维护者的版本更新、候选准备和 npm 发布操作见[发布流程](./docs/releases.md)。项目使用 [MIT](./LICENSE)，保留的上游和内嵌依赖声明见 [THIRD_PARTY_NOTICES](./THIRD_PARTY_NOTICES)。
