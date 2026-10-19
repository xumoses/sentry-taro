# 项目文档

本目录保存面向维护者的设计原则、架构决策和实施记录。使用文档已迁入[项目网站](../website/guide/getting-started.md)（中英文），源码位于 [`website/`](../website/)。

## 使用文档

- [快速开始](../website/guide/getting-started.md) · [核心概念](../website/guide/concepts.md)
- [Session Replay](../website/guide/replay.md) · [Taro 构建插件](../website/guide/taro-plugin.md) · [Worker 压缩](../website/guide/worker.md) · [原生与 Taro 混合应用](../website/guide/hybrid-apps.md)
- [API 与配置](../website/guide/api.md) · [从旧包迁移](../website/guide/migration.md)
- [Taro React 示例](../examples/taro-react/README.md)：使用合成数据和内存 transport 的接入片段。
- [Agent Skill](../skills/sentry-taro/SKILL.md)（英文）：供 Claude Code、Cursor 等工具自动完成接入、Replay、构建插件配置和旧包迁移。

## 升级说明

- [运行时迁移说明](./migrations/phase-two-runtime.md)：10.76.2 API、Replay 控制和默认行为变化、功能支持边界。
- [变更记录](../CHANGELOG.md)：各版本的公开变化说明。

## 贡献与维护

- [贡献指南](../CONTRIBUTING.md)（英文）：反馈问题、开发环境、源码导航和检查命令。
- [公开回归测试方案](./plans/public-regression-testing.md)：合成复现、Vitest 回归及公开信息边界。
- [npm 发布流程](./releases.md)：版本更新、候选校验、GitHub Actions、人工审批和 OIDC 发布。

## 架构与设计决策

- [Agent 工作约定](../AGENTS.md)：长期约束摘要及修改流程，由 `test/invariants/` 固定为可执行检查。
- [领域术语](../CONTEXT.md)
- [设计原则](./design-principles.md)：Sentry 语义、平台边界、默认策略、产物格式及工具链政策。
- [统一发布决策](./adr/0001-single-package-release.md)
- [官方 API 分期对齐决策](./adr/0002-stage-official-api-alignment.md)
- [小程序平台适配决策](./adr/0003-mini-program-platform-adaptation.md)
- [ESM、CJS 与 Worker 产物决策](./adr/0004-esm-cjs-worker-artifacts.md)
- [分层渐进重构决策](./adr/0005-layered-structural-refactor.md)

## 实施与验证记录

以下记录保留各阶段的方案和验证证据，具体结论对应当时的源码、产物与环境。

- [Taro 构建插件迁移](./plans/taro-build-plugin.md)：职责、官方选项对齐和验证范围。
- [统一包合并方案](./plans/package-merge.md)：范围、API 与工具链分期、发布和验收顺序。
- [结构重构计划](./plans/structural-refactor.md)：分层收敛、范围裁剪、官方 API 对齐的分期、门槛与范围决定。
- [结构重构实施记录](./implementation/structural-refactor.md)：第一阶段的提交、验证结果和未完成项。
- [正式版 0.1.0 实施记录](./implementation/release-0.1.0.md)：候选电脑微信验收与正式版准备。
- [第一阶段记录](./implementation/phase-one.md)：原候选包的本地验收与公开回归。
- [第二阶段记录](./implementation/phase-two.md)：工具链迁移、运行时对齐、发布和设备验证状态。
