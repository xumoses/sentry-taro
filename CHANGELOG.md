# Changelog

## 0.1.0-beta.1 — 2026-10-15

首个 npm 版本，已通过公开 registry 的固定版本安装、完整性、严格类型及运行时消费验证。

- 合并监控 SDK 与 Taro Replay，对外统一为 `@xumoses/sentry-taro`；Replay 显式开启。
- 对齐 `@sentry/core@10.76.2` 的公共 API 与运行时行为，新增 Replay 直接控制接口及会话策略。
- 提供 ESM、自包含 CJS、类型声明、独立 Worker 和轻量 Taro/React 入口；移除 UMD。兼容变化与迁移步骤见[第二阶段迁移说明](./docs/migrations/phase-two-runtime.md)。
- 统一版本更新和发布校验，配置 tag 触发的 GitHub Actions、人工审批及 npm OIDC 发布流程。

支持与验证范围以 README 和[实施记录](./docs/implementation/phase-two.md)为准；本地、真实服务、CI 与真机验收分别记录。
