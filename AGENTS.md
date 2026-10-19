# Agent 工作约定

本文件供 Claude Code、Codex、Cursor 等编码 Agent 在每次会话中读取，列出本项目长期不变的约束。规则的依据在所链接的 ADR 和设计文档中；本文只做摘要，二者冲突时以 ADR 为准，并应修正本文。

## 修改约束的流程

- 下列“长期约束”不能在普通改动中顺带调整。确需改变时，先新增或修订 [ADR](./docs/adr/)，再同步更新本文、[设计原则](./docs/design-principles.md)和 `test/invariants/` 中对应的测试，最后再改代码。
- `test/invariants/` 中的测试把这些约束固定为可执行检查。测试失败表示改动越过了已确认的边界；不要为了让测试通过而修改断言，除非对应的 ADR 已经更新。
- 新增 ADR 时，同时在 [docs/README.md](./docs/README.md) 和本文的“决策来源”中加入链接，`test/invariants/` 会检查这一点。

## 长期约束

1. **单一发布包。** 只发布 `@xumoses/sentry-taro`，源码是 `src/{sdk,replay,taro-plugin}` 单一目录树，不恢复多包或内部包注入边界。见 [ADR-0001](./docs/adr/0001-single-package-release.md)、[ADR-0005](./docs/adr/0005-layered-structural-refactor.md)。
2. **官方 Sentry 语义优先。** 公共 API、默认行为和数据协议以固定官方版本 `@sentry/core` 10.76.2（v10 支持线）为基线；官方已有的能力使用官方名称和语义，平台差异必须有说明、可配置并有回归测试。升级基线是单独决策。见 [ADR-0002](./docs/adr/0002-stage-official-api-alignment.md)、[设计原则](./docs/design-principles.md)。
3. **平台边界。** 架构是“官方 core + 小程序适配 + 可选 Taro DOM Replay”。不做浏览器仿真，不引入官方浏览器 Replay 或 rrweb 录制依赖；Taro DOM 是逻辑 UI 状态，不承诺像素还原。见 [ADR-0003](./docs/adr/0003-mini-program-platform-adaptation.md)。
4. **分层依赖方向。** 错误监控可独立使用：`src/sdk` 不得导入 `src/replay` 或 `src/taro-plugin`；`src/taro-plugin` 是构建期 Node 代码，不导入运行时层。运行时层的第三方依赖只限 `@sentry/core`、`fflate`、`@tarojs/*` 和 `react`。见 [ADR-0005](./docs/adr/0005-layered-structural-refactor.md)。
5. **产物格式。** ESM 优先，保留自包含 CJS 和独立 Worker，不恢复 UMD；运行时产物语法目标为 ES2015；根包有导入时初始化，不全局声明 `sideEffects: false`。见 [ADR-0004](./docs/adr/0004-esm-cjs-worker-artifacts.md)。
6. **版本精确锁定。** `dependencies`、`devDependencies`、`packageManager` 和 `.node-version` 使用精确版本，工具链按 Vite Plus 整套组合升级；peer 依赖可以是范围。见[设计原则](./docs/design-principles.md#工具链版本与迁移方向)。
7. **支持范围。** 正式支持 Taro 4.2.x + React 18 + 微信小程序，验收目标为电脑微信；手机微信标为“待验证”。其他小程序平台和小游戏代码冻结保留：不删除、不开发、不验收，但保持编译和测试通过。同名导出或类型检查通过不等于“正式支持”。见 [ADR-0005](./docs/adr/0005-layered-structural-refactor.md)、[CONTEXT.md](./CONTEXT.md)。
8. **公开信息边界。** 本仓库是开源项目，文档、测试 fixture、示例和产物中不得出现企业项目名称、路径、域名、部署身份、Sentry 事件或 Replay 标识；验证项目统一称为“首个验证项目”，使用合成数据。见[公开信息边界](./docs/plans/package-merge.md#公开信息边界)。
9. **兼容性变化须有迁移说明。** beta 期允许必要的破坏性调整，但每项被弃用或删除的公共接口、默认值和产物变化都要写入迁移说明和 [CHANGELOG](./CHANGELOG.md)，并同步更新 [Agent Skill](./skills/sentry-taro/SKILL.md) 的英文参考文档。

## 工作方式

- 直接在 `main` 上提交，不使用 worktree 或功能分支。
- 改动代码、依赖或产物后，运行与 CI 相同的检查，见[贡献指南](./CONTRIBUTING.md#检查改动)。只改文档时，至少运行 `vp check`。
- 文档与面向维护者的说明使用中文；以下例外使用英文：Agent Skill（`skills/`）、[贡献指南](./CONTRIBUTING.md)、`README.en.md` 和网站英文页（`website/en/`）。使用文档以 `website/` 为唯一来源，中英文页面同步维护。术语以 [CONTEXT.md](./CONTEXT.md) 为准。
- 设计决定不等于实现或验收完成。实施证据记录在 [docs/implementation/](./docs/implementation/)，不要把本地测试通过写成服务端或设备验收通过。

## 决策来源

- [领域术语](./CONTEXT.md)
- [设计原则](./docs/design-principles.md)
- [ADR-0001 统一发布](./docs/adr/0001-single-package-release.md)
- [ADR-0002 官方 API 分期对齐](./docs/adr/0002-stage-official-api-alignment.md)
- [ADR-0003 小程序平台适配](./docs/adr/0003-mini-program-platform-adaptation.md)
- [ADR-0004 ESM、CJS 与 Worker 产物](./docs/adr/0004-esm-cjs-worker-artifacts.md)
- [ADR-0005 分层渐进重构](./docs/adr/0005-layered-structural-refactor.md)
- [结构重构计划](./docs/plans/structural-refactor.md)
