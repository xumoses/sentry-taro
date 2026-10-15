# 第二阶段实施进度

更新时间：2026-10-15。状态：**`0.1.0-beta.4` 已通过 GitHub Actions、人工审批及 npm OIDC 发布，registry 完整性与公开安装验证通过，修复 Taro 构建插件的微信最终 sourcemap ZIP 兼容性；工具链迁移和 10.76.2 运行时对齐已通过本地验证，宿主接入、受控错误、Replay 关联与 Playback 保留各自候选的验收记录；真机、宿主 CI 及上传体积待验收**。本文件记录第二阶段证据；[第一阶段记录](./phase-one.md)保留其原候选包和验收范围，不因本轮改动自动延续为新产物的通过结论。

## 已确认范围

- 工具链统一到 Vite Plus，采用其管理的兼容版本组合；开发用 Node.js、pnpm 精确锁定，由 `vp` 解析和执行。
- 官方 Sentry SDK 采用 v10 支持线的精确版本 10.76.2；功能支持及默认策略遵循[设计原则](../design-principles.md)。在工具链原有本地通过基线上继续升级运行时，具体 API、默认行为及兼容变化见[迁移说明](../migrations/phase-two-runtime.md)。
- ESM 优先，保留自包含 CJS 和独立 Worker，移除 UMD。保持声明、sourcemap、许可证和隔离消费者验证。
- 后续发布、依赖切换、旧包弃用和 iOS 真机验收按阶段推进，Android 后续补充。**npm 发布前明确暂停，等待用户确认后再继续发布。**

## 工具链迁移

目标组合为 Vite Plus 1.2.0、Node.js 26.12.0、pnpm 12.13.0。实际项目版本以根 `package.json`、`.node-version` 和锁文件为准；Vite、Vitest、Oxlint、Oxfmt 等跟随 Vite Plus 的整套版本。

| 工作项                     | 当前状态           | 验收依据                                                                                              |
| -------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------- |
| 环境、依赖和锁文件统一     | 本地通过           | 实际 Node.js/pnpm 版本、冻结锁文件安装及 peer 检查                                                    |
| Jest/ts-jest、ESLint 迁移  | 本地通过           | 76 个测试文件、959 项测试，`vp check` 和两次严格 TypeScript 检查                                      |
| `vp pack` 库构建与产物格式 | 本地通过           | ESM/CJS、独立 Worker、声明、map、通知及 tarball 隔离消费者检查                                        |
| CI 入口统一                | 远端发布工作流通过 | `0.1.0-beta.4` 的准备与发布 job 成功；见[微信最终映射兼容修复版本发布](#微信最终映射兼容修复版本发布) |

CI 使用 [`voidzero-dev/setup-vp@v1.21.2`](https://github.com/voidzero-dev/setup-vp/tree/v1.21.2) 管理环境，固定 action 版本并读取项目的 Vite Plus 和 Node.js 声明。`vp pack` 构建库；`vp pm pack` 通过项目包管理器运行 `prepack` 并生成 npm tarball，两者不是同一操作。

## 开发环境复现

先通过 `vp env install` 安装项目声明的 Node.js 和 pnpm，再检查实际执行环境：

```sh
vp env current --json
vp exec node --version
vp exec pnpm --version
```

预期分别为 Node.js `26.12.0` 和 pnpm `12.13.0`。不能仅用 `vp --version` 的项目版本摘要代替执行检查。官方的 [system-first 模式](https://viteplus.dev/guide/env#environment-modes)优先使用 PATH 中的系统工具；`vp env use` 和版本覆盖变量不会切换这个模式。`vp env on` 会保存管理偏好，因此本项目不要求开发者为一次迁移改变其他项目的全局设置。

在已有 system-first 安装上，可按 `vp env doctor` 显示的 **Data dir** 找到已安装的真实工具目录，仅在子 shell 中前置 PATH。以下是 macOS/Linux 旧版单目录布局的已验证示例；若 Data dir 不同，将 `sentry_taro_vp_data` 改为其实际绝对路径。此处使用普通进程环境选择工具，不是 Vite Plus 的项目模式配置。

```sh
(
  sentry_taro_vp_data="$HOME/.vite-plus"
  export PATH="$sentry_taro_vp_data/js_runtime/node/26.12.0/bin:$sentry_taro_vp_data/package_manager/pnpm/12.13.0/pnpm/bin:$PATH"
  vp env current --json
  vp exec node --version
  vp exec pnpm --version
  vp install --frozen-lockfile
  vp check
  vp run typecheck
  vp test run
  vp pm pack --pack-destination .artifacts
  vp run verify:bundles
  vp run verify:consumer --online
)
```

全新 GitHub hosted runner 上，`setup-vp` 默认启用托管环境，CI 不使用本机路径。官方也提供 [`VP_HOME`](https://viteplus.dev/guide/global-cli#vp-home) 隔离安装目录的能力；本次本地验证复用已安装工具，没有新建独立安装或修改全局模式。

pnpm 12 的发布冷却期涵盖传递依赖。项目明确设置 `minimumReleaseAge: 1440` 和 `minimumReleaseAgeStrict: true`，仅以精确 `包名@版本` 记录本轮 Vite Plus `1.2.0` 整套产物的例外，不为整个平台 scope 或其他传递依赖豁免。精确允许既有 `@swc/core@1.3.96` 与 `esbuild@0.21.5` 的安装脚本验证平台二进制；它们已正常完成。提交锁文件后用 `vp install --frozen-lockfile` 检查。配置含义见 [pnpm 依赖解析设置](https://pnpm.io/settings/dependency-resolution#minimumreleaseage)。

## 工具链阶段的历史验证

工具链迁移完成时的本地验证使用实际 Node.js `26.12.0`、pnpm `12.13.0` 和 Vite Plus `1.2.0`。记录如下：

| 门槛                                     | 状态                                                                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 冻结锁文件安装与环境版本核对             | 通过；peer 检查无问题                                                                                                  |
| 格式、lint、严格类型检查                 | 189 个格式文件、151 个 lint 文件，0 warning；两次严格 TypeScript 检查通过                                              |
| SDK 与 Replay 自动化测试                 | 76 个文件、959 项测试通过                                                                                              |
| SDK 覆盖率                               | 781 项 SDK 测试通过；语句 91.4%、分支 84.23%、函数 91.34%、行 92.75%                                                   |
| 发布产物、Worker、sourcemap、通知检查    | 本地 tarball 通过；12 个 ES2015 assets、340 个 portable sourcemap sources、隔离根入口、Worker Unicode 与许可证检查     |
| tarball 隔离安装、类型与运行时消费       | 通过；无 React/Taro peers 安装、严格 TS 7 声明、CJS/ESM/core identity、错误捕获、Replay buffer/send/stop 与 5 个子路径 |
| 远端 CI                                  | 未执行                                                                                                                 |
| 生产构建消费增量与裁剪                   | 待后续实施                                                                                                             |
| 目标服务错误、Replay 关联和实际 Playback | 待新候选包验证                                                                                                         |
| 体验版及 iOS 真机                        | 待重构完成后验证                                                                                                       |
| npm 发布                                 | 发布前暂停，等待用户确认                                                                                               |
| 正式依赖切换、旧包弃用                   | 未执行                                                                                                                 |

覆盖率迁移至与 Vitest `5.0.4` 匹配的 V8 provider。本次通过 `vp run test:sdk:coverage` 的 `--project sdk` 运行，继续统计 SDK 源文件，排除声明与公共 re-export 入口；已核对 LCOV 的 41 个文件均来自 `packages/sdk/src`，不含 `src/index.ts`。这个范围限定于 SDK 覆盖率命令；全项目覆盖率运行可能同时统计 Replay。provider 变化不代表功能覆盖提升。Vite Plus 的 Vite alias 以发行版本 `1.2.0` 暴露 Vite `8.3.4`，peer 例外只匹配固定的 Vitest/mocker `5.0.4`，没有放宽其他包的约束。

## 工具链阶段的历史产物

运行时升级之前的工具链构建包含当时的 README 更新，版本为 `0.1.0-beta.1`，没有发布到 npm。冻结安装、产物检查及在线隔离消费已通过；最终 tarball 又通过一次使用本机缓存的离线隔离消费。

- 文件：`.artifacts/xumoses-sentry-taro-0.1.0-beta.1.tgz`
- 大小：1,029,709 字节，仅代表 npm tarball，不代表小程序主包增量。
- SHA-512（Base64）：

```text
qeqn4CamPd16yweR8H7bXuKjx6oWbQueCq9HcG+0CuVRnpJ5IU6dP1Yb62hNVnBS1aRYyUuela1Tim8DqKbAeQ==
```

该记录只标识当时的产物；后续运行时构建会覆盖相同文件名，须以新校验值识别。相同版本号不能替代产物身份或延续真实服务验收结论。

## 运行时对齐

本轮已精确升级 core 10.76.2，将公共 options、默认集成、反馈与 scope 处理回归到 core 契约。Replay 增加当前 client 的 `getReplay()` 和官方直接控制接口；会话策略独立于 recorder，实现 4,999 毫秒最短发送、60 秒 buffer、60 分钟会话上限与空闲行为。可见页面所有权独立于自动采样，支持采样关闭后手动录制，原 bridge 接口保留兼容。

ESM 保留 fflate 的包边界及其副作用元数据，CJS 和 Worker 继续自包含；Replay 门面仅引用所需 SDK 绑定。三种合成生产消费者检查实际输出的源映射片段，确保 errors-only 不保留 Replay/fflate，主线程不嵌入独立 Worker。此证据不替代宿主小程序上传体积。

| 本轮运行时门槛                   | 结果                                                                                                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 冻结安装与 peer 检查             | `vp install --frozen-lockfile --offline` 通过；`vp exec pnpm peers` 无冲突                                                                                             |
| 格式、lint、类型                 | 200 个格式文件、157 个 lint 文件，0 warning；根与 SDK 两次严格 TypeScript 检查通过                                                                                     |
| 全部自动化测试                   | 79 文件、1,019 项通过：SDK 801、Replay 218                                                                                                                             |
| SDK 覆盖率                       | 42 个 SDK 源文件；语句 91.39%、分支 84.38%、函数 91.14%、行 92.78%                                                                                                     |
| Replay 控制与时间边界            | 合成 fake-clock 覆盖采样、60 秒 buffer、60 分钟 rollover、5/15 分钟空闲、最短时长、页面隐藏、停止/重启及队列失败隔离                                                   |
| 本地发布产物与消费               | 通过；12 个 ES2015 assets、347 个 portable sourcemap sources；严格声明、CJS/ESM/core identity、5 个子路径、错误与 Replay 控制、无 React/Taro peers 的离线 tarball 消费 |
| 目标服务与 Playback              | 本地检查完成后使用同一 tarball 重新验收通过，详见下节真实发送记录                                                                                                      |
| 远端 CI、设备与宿主上传体积      | 未执行，不延用第一阶段候选结论                                                                                                                                         |
| npm 发布、正式依赖切换、旧包弃用 | 未执行；npm 发布前暂停                                                                                                                                                 |

完整测试后补齐了超长配置分支清空等待队列时的订阅通知，Replay 控制契约再通过一次；不改变录制或投递默认策略。SDK 覆盖率不含 Replay，不能解读为整个发布包覆盖率。

功能矩阵分别记录正式支持、未支持、待验证。上游导出、内存 transport 测试或服务接收成功不能替代真实功能验收。公开证据只包含合成场景、版本范围和复现步骤；部署身份、内部地址、真实事件、录制和应用 sourcemap 留在公开仓库之外。

## 10.76.2 运行时最终本地产物

最终本地版本仍为 `0.1.0-beta.1`，未发布 npm。完整 `prepack` 与隔离消费验证针对以下 tarball：

- 文件：`.artifacts/xumoses-sentry-taro-0.1.0-beta.1.tgz`
- 大小：1,027,001 字节，仅表示 npm tarball。
- SHA-512（Base64）：

```text
gRvsPlbKLSGVxHgJuGHeRRTe9jbS6Wq7j1Ze5b5OOWnieoP26yaGFRR5pfoz7WGb+o1+4gEiaWxW3U8y+tsZaw==
```

合成生产消费者使用 Vite Plus 的相同生产配置、ES2015 目标和 minifier，测量未压缩 JS 字节，包含保留的许可证注释；Worker 作为独立资产单列：

| 场景                   | 主线程 JS | 独立 Worker |      合计 |
| ---------------------- | --------: | ----------: | --------: |
| 仅错误监控             | 155,665 B |         0 B | 155,665 B |
| 错误 + Replay          | 240,758 B |         0 B | 240,758 B |
| 错误 + Replay + Worker | 240,823 B |     8,712 B | 249,535 B |

本轮合成场景中，启用 Replay 的主线程增量为 85,093 B。实际参与输出的 source mapping segments 证明 errors-only 不保留 Replay/fflate 代码，所有主线程场景不包含 Worker 实现，必要 polyfill 初始化仍保留。此结果不代表宿主小程序主包、分包或上传包的增量，也不据此设定平台 2M 限额的通过结论。

报告位于忽略的 `.artifacts/consumer-bundles/report.json`；其 `entrySha256` 已与最终 ESM 文件核对：

```text
b201e6b2827dd4a749f0489c2026f7d7fc4e3f58a9881a449a6a36d4b3c654be
```

后续宿主、真实 Sentry 和真机验证应使用本节标识的 tarball；任何重建都需重新检查校验值，不能仅凭版本号继承结论。远端 CI 与 npm 发布均未执行，**停在 npm 发布之前**。

## 同一候选的宿主与真实发送验证

2026-10-15，使用上节 **1,027,001 字节、SHA-512 以 `gRvsPlbK` 开头**的原始 tarball 完成宿主验证，没有重新打包。原生 npm 与 Taro 两处已安装 ESM 的 SHA-256 均与上节一致，内置 core 为 10.76.2。宿主采用 `integrations: [replayIntegration]`，由 SDK 根据完整 init options 装配默认集成。临时安装结束后，四份依赖声明及锁文件恢复为安装前的准确字节；这不是正式 registry 依赖迁移。

| 验证边界               | 本次结果                                                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 宿主检查               | 80 项相关测试、TypeScript 检查、原生 npm/独立 Worker 与 Taro 生产构建通过                                                                       |
| 真实发送环境           | 微信开发者工具 2.02.2607271，基础库 3.7.12；只操作合成 POC 页面                                                                                 |
| 受控异常及错误缓冲模式 | 错误触发 buffer → session；错误与 Replay 均接收成功，服务端双向关联及 release/dist 一致                                                         |
| 分段完整性             | 完整分页读取 4 个分段、40 个 rrweb 事件；时间有效且非递减，与服务端分段数及客户端 accepted 数一致                                               |
| DOM 与选择性遮罩       | 计数 0 → 1 → 2、样式改变、节点新增/删除均有增量；普通合成输入可见；密码显隐及编辑期间 8 个 Input 增量全为星号，录制及错误 JSON 不含合成密码明文 |
| Worker 投递            | 4 个压缩分段、0 fallback，325,834 B → 42,253 B，减少 87.03%；停止后 pending/dropped/retry 均为 0                                                |
| 实际 Playback          | 页面成功渲染，观察到普通输入、密码遮罩、样式和节点变化；播放至服务端显示的 01:15 结束                                                           |

开发者工具仍提示该版本与基础库的支持警告；以上是此组合的实际观测，不是最低基础库或真机支持承诺。构建保留宿主既有的 peer、样式顺序和 asset size 提示；Webpack 提示不能代替微信上传的 2M 检查。原生 npm 打包器另提示 fflate 的 CJS 入口未找到；本包 CJS 已内置压缩器，安装脚本的外部引用检查及实际 Worker 投递通过，此提示不等于 ESM 依赖缺失。

本次仅验收受控错误与 Replay 路径；Tracing/Feedback 完整功能、新公共控制 API 的真实设备行为、长时间会话边界、iOS/Android、体验版、CI 与上传包体积仍需各自证据。宿主保留显式 `enableLogs: true` 配置，本次没有调用 Logs/Metrics，不能据此判断它们受目标服务支持。

真实部署身份、应用源码、事件 ID、Replay ID、原始录制与具体构建标识仅保存到仓库外的私有证据目录。README 的验收状态在测试后更新，未重建或替换已验收 tarball；后续打包仍须重新核对产物身份。npm 发布继续暂停。

## 首次 npm 发布准备

2026-10-15，选择首版本地手动发布，后续再接 CI 发布。新增 `vp run release:prepare`，完成检查、打包、隔离消费及固定 `--dry-run` 演练后生成独立候选目录和 `release.json`；实际发布仍需用户确认。触发方式、认证和发布后核验见[发布流程](../releases.md)。

- 发布目标：`@xumoses/sentry-taro@0.1.0-beta.1`，`public`、`beta`、官方 npm registry。
- 候选：`.artifacts/releases/0.1.0-beta.1-geJxVt/xumoses-sentry-taro-0.1.0-beta.1.tgz`。
- 大小：1,027,081 字节，共 98 个文件；同目录 `release.json` 保存完整文件清单及校验值。
- SHA-512（Base64）：

```text
0G3jV4zi8Wi5mGL2XtSO2pry036btQ+UoHQjHy3lsdiNGvlBbATm3E3OSiXCp0wgEU9jLcOmzfKJ082moCb+jA==
```

实际使用 Node.js 26.12.0、pnpm 12.13.0、npm 11.20.0。冻结安装、格式/lint、两次类型检查、79 个文件的 1,019 项测试、产物与 Worker、生产 bundle 检查通过。单独的在线隔离消费通过；最终离线准备命令完整通过，包含隔离消费与 npm 发布 dry-run。最终文件与在线消费的候选逐字节相同。清单中的 registry 检查标记为离线跳过；另行匿名查询官方 registry 返回 404，说明查询时尚无该包。

与上一节实际验收 tarball 比较：93 个 `dist` 文件（含运行时、Worker、声明、sourcemap）及第三方声明逐字节一致；差异仅为两份 README 和增加准备命令的 `package.json`。此前宿主与真实服务结果仍对应原始 tarball，本次通过文件对照确认运行时一致，没有重新执行宿主或真机验收。

**状态：准备完成，等待用户确认；未发布 npm，未创建或推送 Git tag，未提交本轮改动。** 远端 CI、设备、体验版与上传体积的待验收状态不变。

## tag 与 OIDC 发布配置

同日后续将常规发布方式调整为统一版本命令、tag 触发 GitHub Actions、人工审批后 OIDC 发布。上一节保留当时本地候选记录；当前流程以[发布说明](../releases.md)为准。

- `release:version <version>` 同步三个 manifest、`SDK_VERSION` 和 npm 渠道，拒绝降级和现有版本漂移；不自动提交、创建 tag、推送或发布。当前版本保持 `0.1.0-beta.1`。
- `publish.yml` 校验 tag 与版本一致、对应提交已合入 `main`；完整验证后只打包一次，上传候选与清单。发布 job 按同一 run 的 artifact ID 下载，复核源码 commit、干净状态与双 hash，经审批后才以 OIDC 发布，随后核验 registry 和下载字节。
- GitHub `npm` Environment 已创建并读回核验：审核人 `xumoses`，允许本人审批，禁止管理员绕过，部署策略仅允许 Tag 类型 `v*`。仓库变量 `NPM_OIDC_PUBLISH_ENABLED=false`；未启用发布。
- npm 官方 registry 再查返回 404。包尚未创建，不能绑定 trusted publisher；首次真实版本的普通发布、随后 npm OIDC 绑定及实际发布验证均待确认，不创建占位包。

本地冻结安装、格式/lint、类型、1,019 项 SDK/Replay 测试、51 项发布工具测试、产物/Worker、生产 bundle、隔离消费者、npm dry-run 与 actionlint 工作流检查通过。实际候选校验 CLI 通过，并确认错误 tag 与含未提交改动的 CI 候选会被拒绝。发布后 registry 校验逻辑使用合成响应测试，未执行真实发布。

本轮本地候选为 `.artifacts/releases/0.1.0-beta.1-VUBDQO/xumoses-sentry-taro-0.1.0-beta.1.tgz`，1,027,127 字节，完整清单位于同目录 `release.json`。SHA-512（Base64）：

```text
OHXSUpTvdMkx7pRfyhxZjvC53SpeDN6KbYjni3XtbH+FYHnerLH1MYAlVWkhFYx4aw4Ygez0M89aQakvzHoU5Q==
```

本次修改尚未提交或推送，远端仍只有初始 `main`，没有发布 tag。GitHub 保护设置已生效不等于工作流已在远端运行；远端 CI、审批暂停与 OIDC 发包仍未实际验收。**保持停在真正发布之前，等待用户确认。**

## 首次 npm 发布结果

2026-10-15，经确认后使用普通 npm 认证发布确切候选，执行 `npm publish <tarball> --tag=beta --access=public --ignore-scripts`。源码提交为 `138d301f341e83076834daef23b6cbc764ae0318`，准备时工作区干净；未重新打包或修改已批准的文件。

- 包：`@xumoses/sentry-taro@0.1.0-beta.1`，public；registry 记录发布时间为 `2026-10-15T05:34:53.230Z`。
- 候选：`.artifacts/releases/0.1.0-beta.1-46qDzE/xumoses-sentry-taro-0.1.0-beta.1.tgz`，1,026,754 字节。
- SHA-256：`2ee27d225521bc80b58cca08f04b8e591a3d2ffa43a8c39f469838d85e46ebd4`。
- SHA-512（Base64）：`8nwVIl4jbmMDo/NsLk4GpXd7UiPBvqVPv2osfNJraz46A7u9Oitgy0tJyyEx4fKIDNXdN+EwfVhxebo8E+tBOQ==`。

发布前冻结安装、格式/lint、类型、1,019 项 SDK/Replay 测试、51 项发布工具测试、产物/Worker、生产 bundle、在线隔离消费者和 npm dry-run 均通过。发布后匿名查询 registry，校验版本、`beta` 指向与 `dist.integrity`，下载公开 tarball 并与批准文件逐字节比较通过；随后从官方 registry 按精确版本安装，确认锁文件 integrity、严格类型、CJS/ESM 和真实 SDK/Replay 运行时通过。

npm 在首包处理期间自动生成 `0.0.0-stage`，处理完成后 `beta` 与 `latest` 均指向 `0.1.0-beta.1`。本次没有执行 `npm stage`，也未删除任何版本；额外 `latest` 标签的 CLI 删除请求返回 403，目前保留两个标签。建议消费者固定版本或显式使用 `@beta`。

上传被接受后曾短暂返回 404，约两分钟后目标版本可见。发布后校验已扩展为最多 41 次、30 秒间隔，只对暂未可见与暂时性请求错误重试；发布 job 超时调整为 30 分钟。确定的完整性或来源不符立即失败，不会重新发布。这些发布后工具和文档修正不属于已发布 tarball。

`release.json` 保留发布前清单，同目录 `publish-attempt.json` 和 `publication.json` 分别保存上传回执及公开下载、安装核验。首版发布完成时，GitHub 源码尚未推送、未创建或推送 tag，远端 CI 和 OIDC 尚未运行；当时 `npm` Environment 保护已配置，`NPM_OIDC_PUBLISH_ENABLED=false`，计划在后续候选准备好时绑定 trusted publisher。后续执行结果见下一节。

## 首次 OIDC 发布结果

2026-10-15，`v0.1.0-beta.2` 触发 [Actions run 38690018889](https://github.com/xumoses/sentry-taro/actions/runs/38690018889)。`prepare` 完成后，`publish` 在 `npm` Environment 的 Required reviewers 规则下暂停；取得用户对确切候选的确认后批准执行。两个 job 均成功，npm trusted publisher 状态为 `Valid`，仓库变量 `NPM_OIDC_PUBLISH_ENABLED=true`。

- 版本：`@xumoses/sentry-taro@0.1.0-beta.2`，public；registry 发布时间为 `2026-10-15T06:13:00.359Z`（北京时间 14:13）。
- 源码：`d25161f54952a7a14873b54d671dc5e9851b047c`；Git tag 为 `v0.1.0-beta.2`。
- Actions artifact：`11951034679`；文件 `xumoses-sentry-taro-0.1.0-beta.2.tgz`，1,026,737 字节。
- SHA-256：`718c07fe40528df69b290d75ea04e0cd8992eb8ec92cbdea2838d9d6e92396ef`。
- SHA-512（Base64）：`EwQq37v7iCo3MorjUJMHeIg9zULhD5Ej1Vqn8TvKdhKyWWKJXxJFDLRyaZynmB2J70nIaY4afXl2UHXZw8ZFtg==`。

远端准备通过冻结安装、格式/lint、类型、1,019 项 SDK/Replay 测试、72 项发布工具测试、构建与产物、Worker、生产 bundle、隔离消费者及 npm dry-run。发布 job 按 artifact ID 下载同一候选，核验源码与完整性后通过 OIDC 发布，并通过 registry 元数据和公开 tarball 下载校验。

npm 返回的 SLSA v1 provenance 已核对声明字段：仓库为 `https://github.com/xumoses/sentry-taro`，工作流为 `.github/workflows/publish.yml`，ref 为 `refs/tags/v0.1.0-beta.2`，resolved gitCommit 与上述源码提交一致，invocationId 指向该 run 的 `attempts/1`，subject SHA-512 与候选一致。[Sigstore 透明日志](https://search.sigstore.dev/?logIndex=3260556627)记录此次声明；本次未执行独立密码学验签。

发布后使用匿名身份和全新缓存，从官方 registry 固定安装 `0.1.0-beta.2`，锁文件 integrity、严格类型、CJS/ESM、SDK/Replay 行为及 5 个子路径检查通过。`beta` 指向 `0.1.0-beta.2`；按已确认的渠道安排，`latest` 保留在 `0.1.0-beta.1`。准备清单保存在 `.artifacts/actions/38690018889/candidate/release.json`，同 run 的 `publication.json` 汇总发布证据；公开消费报告为 `.artifacts/oidc-beta2-public-consumer.json`。

本次完成的是远端发包与公开包消费验收。既有真实 Sentry、Replay 关联和 Playback 证据仍对应各节记录的候选；本次未重做宿主接入、宿主 CI、体验版、iOS/Android 真机或微信上传体积验收，也未弃用旧包。发布后的文档更新不重建或替换已发布 tarball。

## Taro 构建插件版本发布

2026-10-15，`0.1.0-beta.3` 在用户确认确切候选后，通过 [Actions run 38735008427](https://github.com/xumoses/sentry-taro/actions/runs/38735008427) 的 `npm` Environment 审批和 OIDC 发布。`prepare` 与 `publish` 均成功；新增能力见 [Taro 构建插件指南](../guides/taro-plugin.md)。

- 版本：`@xumoses/sentry-taro@0.1.0-beta.3`，public；registry 发布时间为 `2026-10-15T12:40:36.342Z`（北京时间 20:40）。
- 源码：`d57f0cf555e928d74a3c9d0d790441ef20aeaaf3`；Git tag 为 `v0.1.0-beta.3`。
- Actions artifact：`11972990620`；文件 `xumoses-sentry-taro-0.1.0-beta.3.tgz`，1,949,124 字节。
- SHA-256：`deef1801c720aa3962ce34da0491039e74ded103a541edbe9003599a1ebd4dae`。
- SHA-512（Base64）：`cqspYI647glSK4jbMoUNiVOl2i9BZ4Yrhie+l+7FekipRBXtOxSYQXpA+vJWfmJL86krV+iP8UPzXhvY1EwOSQ==`。

远端候选通过冻结安装、格式/lint、类型、1,187 项 SDK/Replay/插件测试、72 项发布工具测试、构建与产物、Worker、生产 bundle、隔离消费者和 npm dry-run。审批前下载的 Actions tarball 与本地验证候选逐字节一致；发布后再次匿名下载 npm tarball，大小、SHA-256 和 SHA-512 均与候选一致。`beta` 指向 `0.1.0-beta.3`，`latest` 保留在 `0.1.0-beta.1`。

SLSA v1 provenance 声明中的仓库、工作流、tag、源码提交、run 和 subject SHA-512 均与候选一致；[Sigstore 透明日志](https://search.sigstore.dev/?logIndex=3264807392)记录此次声明。本次核对声明字段，未执行独立密码学验签。候选清单与发布证据保存在忽略的 `.artifacts/github/38735008427/` 中。

发布后使用匿名身份、全新目录和缓存，从官方 registry 固定安装 `0.1.0-beta.3`。锁文件完整性、严格类型、CJS/ESM、SDK/Replay 生命周期、运行时子路径与 `taro-plugin` 消费均通过；插件额外验证页面 SVG、资源读取、metadata、Worker 辅助及官方 CLI 的按需加载。报告保存在 `.artifacts/oidc-beta3-public-consumer.json`。

该版本的宿主插件迁移、体验版、iOS/Android 真机与微信上传体积仍需各自验收。发布记录不扩展既有真实 Sentry 和 Playback 证据的适用范围。

## 微信最终映射兼容修复版本发布

2026-10-15，`0.1.0-beta.4` 在用户确认确切候选后，通过 [Actions run 38763722097](https://github.com/xumoses/sentry-taro/actions/runs/38763722097) 的 `npm` Environment 审批和 OIDC 发布。`prepare` 与 `publish` 均成功。该版本接受微信最终 sourcemap ZIP 中表示归档根的单个前导 `/`，并为缺少真实 JS 的 `workers.js.map` 补齐映射引用文件；保留路径穿越、规范化重名校验、已有 JS 和最终映射原始字节。

- 版本：`@xumoses/sentry-taro@0.1.0-beta.4`，public；registry 发布时间为 `2026-10-15T15:54:23.912Z`（北京时间 23:54）。
- 源码：`ade25f3ca7447fecc08a899385919358d4e4e00a`；Git tag 为 `v0.1.0-beta.4`。
- Actions artifact：`11987130922`；文件 `xumoses-sentry-taro-0.1.0-beta.4.tgz`，1,949,592 字节。
- SHA-256：`d5b7a33ddef9352998f7d060b13bd30a3f25503a138b24fc23b96e261e62c18b`。
- SHA-512（Base64）：`bkPJH/XqEkbPb+6F8d636o4WBmO9VUS/jmKjqxZJrpg/2sItaKdbRApwbxMHkIL7RUanLQqUvm+WglBSVbCyTw==`。

远端候选通过冻结安装、格式/lint、类型、1,198 项 SDK/Replay/插件测试、72 项发布工具测试、构建与产物、Worker、生产 bundle、隔离消费者和 npm dry-run。审批前下载的 Actions tarball 与本地验证候选逐字节一致；发布后匿名下载 npm tarball，大小、SHA-256 和 SHA-512 均与候选一致。`beta` 指向 `0.1.0-beta.4`，`latest` 保留在 `0.1.0-beta.1`。

SLSA v1 provenance 声明中的仓库、工作流、tag、源码提交、run 和 subject SHA-512 均与候选一致；[Sigstore 透明日志](https://search.sigstore.dev/?logIndex=3265996943)记录此次声明。本次核对声明字段，未执行独立密码学验签。候选清单与发布证据保存在忽略的 `.artifacts/github/38763722097/` 中。

发布后使用匿名身份、空 npm 配置、全新目录和缓存，从官方 registry 固定安装 `0.1.0-beta.4`。锁文件完整性、严格类型、CJS/ESM、SDK/Replay 生命周期、运行时子路径与 `taro-plugin` 消费均通过；插件验证涵盖页面 SVG、资源读取、metadata、Worker 辅助及官方 CLI 的按需加载。报告保存在 `.artifacts/oidc-beta4-public-consumer.json`。

本次完成发布流程和公开包消费验证；宿主升级、实际 CI 映射上传、体验版、iOS/Android 真机与微信上传体积仍须各自验收。监控与 Replay 运行时行为未改动，既有真实服务和 Playback 证据的适用范围不变。发布后的文档更新不重建或替换已发布 tarball。
