# 结构重构计划

状态：计划已起草，2026-10-16；尚未开始实施。决策依据见 [ADR-0005](../adr/0005-layered-structural-refactor.md)，对齐原则见[设计原则](../design-principles.md)。本文记录范围、分期、门槛和待确认项；各阶段的实施证据另行记录，不在本文中标记为通过。

## 目标与非目标

目标：

- 源码按官方 SDK 分层组织，去除两个独立包时期遗留的注入边界和重复模块。
- 删除当前支持范围（Taro 4.2.x + React 18 + 微信小程序）之外的代码，并测量产物体积变化。
- 公共 API 收敛到官方名称和语义；小程序与 Taro 特有能力以官方风格的扩展提供。

非目标：

- 不升级 `@sentry/core` 基线，继续使用 10.76.2。
- 不重新设计 recorder 的序列化算法、采样、缓冲及投递策略；只做结构调整和语义对齐。
- 不引入浏览器仿真，不改为多包发布。
- 不新增功能；重构期间发现的缺陷按现有流程单独修复和登记。

## 现状基线

以下事实来自 `0.1.0-beta.5` 源码与本地构建，作为各阶段对比基线：

| 项目       | 现状                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| 源码规模   | sdk 约 10.1k 行、replay 约 4.3k 行、taro-plugin 约 2.2k 行；测试约 24k 行，88 个文件、1204 项                            |
| 入口结构   | `src/index.ts` 转导出 `packages/sdk` 和 `packages/replay`；`src/replay.ts` 通过 `sdk` 参数把 recorder 注入 Replay 协调器 |
| 重复模块   | `network-details.ts` 两份逐字相同；`rebase.ts` 两份在根节点判断上不一致；`utf8.ts` 两份                                  |
| 超大文件   | `packages/sdk/src/replay-poc.ts` 2088 行，`ReplayCoordinator.ts` 1052 行，`integrations/performance.ts` 724 行           |
| 范围外代码 | `platform` 标签包含 7 个小程序平台；小游戏生命周期与帧率集成；导入即执行的全局 polyfill                                  |
| 集成形式   | 17 个类式集成、9 个函数式集成；`Integrations` 命名空间中的 `Dedupe` 与默认使用的 core `dedupeIntegration` 重复           |
| 主入口产物 | `dist/index.mjs` 274,738 B，gzip 后 85,373 B                                                                             |

已完成的对齐不重复列为任务：默认集成支持 `integrations` 函数筛选；integration 名称为官方 `Replay`；顶层 `maskAllText`、`maskAllInputs`、`blockAllMedia` 优先于兼容的 `privacy.*`。官方同名的 `captureConsoleIntegration` 和 `httpClientIntegration` 已在分支实现（提交 `a7bee33`），尚未合入主分支或发布。

## 待确认项

以下决定影响第二、三阶段范围，实施对应阶段前需要确认：

1. 是否放弃微信以外的小程序平台和小游戏支持。确认后删除相关代码，不保留兼容层。
2. 非官方 API 的去留：`setConsent`/`requireConsent`、`enableOfflineCache`、`showReportDialog`、`wrap`。默认倾向是：有官方对应的改用官方方式，没有对应且没有实际使用的删除。
3. `privacy.*` 兼容配置和 `maskInputValues` 的移除时间：在第三阶段删除，还是先标记弃用、到下一个 beta 再删除。
4. `TARO_DOM_REPLAY_POC_MARKER` 等 POC 名称作为 beta 兼容契约的消费方。确认消费方后再决定重命名还是保留别名。

## 分阶段计划

每个阶段单独提交，单独发布 beta，并完成下文的通用门槛后再进入下一阶段。

### 第一阶段：结构收敛，行为不变

- 先为 `rebase.ts` 的分叉补充能暴露差异的回归测试，确定正确语义后只保留一份；合并 `network-details.ts`，在 Worker 独立打包允许的前提下合并 `utf8.ts`。
- 把 `packages/sdk` 与 `packages/replay` 合并为按层组织的单一源码树；移除 `SentryMiniappReplaySdk` 注入参数，Replay 直接引用 recorder。
- 拆分 `replay-poc.ts`，按序列化、变更、样式、Canvas、网络和隐私分成模块；拆分 `ReplayCoordinator.ts`。
- 公共导出、产物路径和运行时行为保持不变；`verify:consumer` 的五个子路径和类型声明结果与基线一致。

### 第二阶段：裁剪范围

依赖待确认项 1、2。

- 删除其他平台适配、小游戏集成、全局 polyfill，以及与 core 重复的自有实现（如 `Integrations.Dedupe`）。
- 保留的平台访问统一收敛到微信与 Taro API。
- 记录主入口产物和首个验证项目主包的体积变化，作为本阶段的成效证据。

### 第三阶段：API 对齐官方

依赖待确认项 2、3。

- 集成全部改为函数式 `xxxIntegration()`；`Integrations` 命名空间和 `enableXxx` 开关先标记弃用，迁移说明给出对应的 `integrations` 写法。
- 帧路径处理改用 core 的 `rewriteFramesIntegration`，默认路径与 taro-plugin 上传的 sourcemap 一致；移除非官方的 `enableSourceMap`。Debug ID 方案单独评估，需先在电脑微信验证。
- Replay 事件按官方方式从 scope 带用户信息，弃用 `getMetadata` 和 `privacy.allowUser`；对照官方 `stop()`/`start()` 核对 bridge 的 `reset` 语义。
- 离线缓存改为通过 `transport` 选项使用官方 `makeOfflineTransport`。
- 合入 `captureConsoleIntegration` 和 `httpClientIntegration`。
- 每项对齐都以 10.76.2 官方源码为依据，在[运行时迁移说明](../migrations/phase-two-runtime.md)或新的迁移文档中写明差异和替代写法。

### 第四阶段：发布与迁移

- 发布 `0.2.0` beta，附完整迁移说明和 CHANGELOG。
- 首个验证项目按迁移说明升级，移除可由官方集成替代的接入代码，并完成电脑微信回归。
- 迁移完成后，再决定稳定版本号和发布标签。

## 每阶段通用门槛

- 本地：`vp check`、`vp run typecheck`、`vp test run`、`vp pm pack`、`vp run verify:bundles`、`vp run verify:consumer --online` 全部通过；现有测试不得删除，除非对应代码随范围裁剪一并删除。
- 电脑微信：真实错误接收、Replay 与错误双向关联、实际 Playback；记录微信版本、基础库版本和候选包校验值。
- 体积：记录主入口产物大小和首个验证项目的主包大小。
- 公开信息边界遵循[统一包合并方案](./package-merge.md#公开信息边界)；验证项目的原始证据留在非公开环境。

## 风险

- 第三阶段的破坏性调整需要使用方同步迁移，迁移说明必须覆盖每个被弃用或删除的接口。
- 拆分 recorder 时，模块间的隐式状态可能改变事件顺序；以现有 Replay 测试和 Playback 验收共同把关。
- 删除平台代码后无法低成本恢复；只在待确认项 1 明确后执行。
- 电脑微信验收不能代表手机微信；手机端在文档中保持“待验证”。
