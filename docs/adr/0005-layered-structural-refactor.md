# 按官方 SDK 分层渐进重构统一包

状态：方向已确认，2026-10-16；尚未开始实施。分阶段范围、门槛和待确认项见[结构重构计划](../plans/structural-refactor.md)。

统一包已只发布 `@xumoses/sentry-taro`，但源码仍保留两个独立包时期的结构：`src/` 只转导出 `packages/sdk` 与 `packages/replay`，Replay 通过显式 `sdk` 参数调用另一侧的 recorder，部分模块在两侧各存一份且已出现分叉。SDK 还保留超出当前支持范围的多平台、小游戏和全局 polyfill 代码，以及早于官方 v8 的类式集成、`Integrations` 命名空间和一组 `enableXxx` 开关。

我们决定在 beta 期按官方 SDK 的分层渐进重构，不推倒重写：

| 层         | 官方参照                     | 职责                                                                  |
| ---------- | ---------------------------- | --------------------------------------------------------------------- |
| 核心       | `@sentry/core`               | 直接依赖，不自行实现已有语义                                          |
| 运行时 SDK | `@sentry/browser`            | `init`、client、transport、stack parser 和函数式集成                  |
| Replay     | `@sentry-internal/replay`    | recorder 负责 Taro DOM 序列化与隐私；协调器负责采样、会话、缓冲和投递 |
| Taro 适配  | 框架 SDK，如 `@sentry/react` | 页面生命周期、React root、页面与路由追踪                              |
| 构建插件   | Sentry bundler plugins       | sourcemap、Replay 资源和上传                                          |

仍只发布一个包，[ADR-0001](./0001-single-package-release.md) 不变；源码改为按层组织的单一目录树，不再保留内部包之间的注入边界。官方已有的能力使用官方名称和语义；Taro 与小程序特有能力以官方风格的 `xxxIntegration()` 提供，并在文档中标为扩展。微信以外的小程序平台和小游戏代码冻结保留：不删除、不开发、不验收，保持编译和现有测试通过。

选择渐进重构，是因为 recorder 和协调器中的边界处理来自多轮真实接收与 Playback 验收，重写会丢失这些行为证据。每个阶段要求行为不变或附迁移说明，保持现有测试全部通过，并单独发布 beta、完成验收。

验收目标由 iOS 真机改为**电脑微信**，便于自动化执行；这一点替代 ADR-0001 和[第二阶段记录](../implementation/phase-two.md)中的真机门槛。手机微信的 JS 引擎、渲染层、Worker 和 Canvas 与电脑微信存在差异，公开文档将其标为“待验证”，不标为“已支持”或“不支持”。

代价是 beta 期会有多次破坏性 API 调整，使用方需要按迁移说明同步升级；冻结的平台代码只有单元测试保障，没有端到端验收。
