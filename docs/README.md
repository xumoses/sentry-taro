# 项目文档

- [领域术语](../CONTEXT.md)
- [第二阶段设计原则](./design-principles.md)：已确认的官方 Sentry 语义、平台边界、默认策略、产物格式及工具链政策。
- [统一包合并方案](./plans/package-merge.md)：范围、API 与工具链分期、发布和验收顺序。
- [公开回归测试方案](./plans/public-regression-testing.md)：合成复现、Vitest 回归及公开信息边界。
- [第一阶段实施进度](./implementation/phase-one.md)：已完成的本地候选包验收、公开回归及第二阶段发布与设备验证边界。
- [第二阶段运行时迁移](./migrations/phase-two-runtime.md)：10.76.2 API、Replay 控制和默认行为变化、功能支持边界。
- [第二阶段实施进度](./implementation/phase-two.md)：工具链迁移、运行时对齐、发布和设备验收的独立状态。
- [统一发布决策](./adr/0001-single-package-release.md)
- [官方 API 分期对齐决策](./adr/0002-stage-official-api-alignment.md)
- [小程序平台适配决策](./adr/0003-mini-program-platform-adaptation.md)
- [ESM、CJS 与 Worker 产物决策](./adr/0004-esm-cjs-worker-artifacts.md)
