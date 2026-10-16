# Changelog

## Unreleased

- 新增与官方 10.76.2 同名的 `captureConsoleIntegration`（core 重导出）和 `httpClientIntegration`，均默认不启用；宿主可替代自行包装的 `console.error` 与 HTTP 5xx 上报。
- `httpClientIntegration` 复用 `NetworkBreadcrumbs` 对平台请求 API 的包装，事件结构与官方一致；URL 去除账号密码、query 和 fragment，请求头与 cookie 仅在 `sendDefaultPii` / `dataCollection` 允许时附带。差异见 [API 指南](./docs/guides/api.md#错误采集集成)。
- 离线缓存写入失败的提示改为绕过 console 包装输出，避免被 `captureConsoleIntegration` 再次上报。
- 低层录制器改用正式名称：`startTaroReplayRecorder`、`TARO_REPLAY_CAPTURE_MARKER`、`TaroReplayRecorder`，类型统一为 `StartTaroReplayRecorderOptions`、`TaroReplayCapture`、`TaroReplayEvent`、`TaroReplayMetadata`。`startTaroDomReplayPoc`、`TARO_DOM_REPLAY_POC_MARKER` 及 `TaroReplayPoc*`、`StartTaroDomReplayPocOptions`、`TaroDomReplayPocController` 保留为弃用别名，下一个 beta 移除；录制数据中的 marker 值不变。
- 修复 Replay 缓冲在嵌套文档节点上折叠滚动位置的问题，与录制器的检查点处理保持一致。
- `replayIntegration()` 不再在内部组装 SDK 对象注入协调器；`sdk` 选项仍可选，行为不变。
- 内部结构调整：源码合并为 `src/{sdk,replay,taro-plugin}` 单一目录树，移除内部工作区包；公共入口和产物路径不变。

## 0.1.0-beta.5 — 2026-10-16

- 修复默认单页 Swiper 的 Replay 分页布局与切页状态采集，覆盖横向、纵向、原生切页及受控 `current` 更新。
- 修复 Taro 共享分包复制丢失已压缩标记、导致 JavaScript 二次压缩而 sourcemap 未同步的问题；保留原始映射段，不裁剪越界映射。

## 0.1.0-beta.4 — 2026-10-15

- 修复微信最终 sourcemap ZIP 使用单个前导 `/` 表示归档根时被误拒绝的问题，保留路径穿越和规范化重名校验。
- 为缺少真实 JS 的微信 `workers.js.map` 补齐映射引用文件，保留已有 JS 和最终映射原始字节。

## 0.1.0-beta.3 — 2026-10-15

- 新增 `@xumoses/sentry-taro/taro-plugin` 构建入口，迁入 Replay 样式转换、按路由资源提取、压缩及预算控制。
- 同一构建入口迁入 release/dist 身份保存与注入、Taro sourcemap 位点修复、微信最终映射上传、Worker 准备及原生 npm 排除项辅助；上传按需使用官方 CLI。
- SVG 自动发现覆盖页面和组件目录；保留源码内容校验，并对资源未收录或超限输出诊断。
- 默认生成 JSON 资源，通过 `createReplayAssetProviders` 在纯 Taro 应用内惰性读取；混合宿主可继续生成 CommonJS 资源模块。
- 通用插件配置对齐 Sentry 的 `disable`、`silent`、`debug` 和 `errorHandler` 语义。

## 0.1.0-beta.2 — 2026-10-15

首次通过 Git tag、GitHub Actions 人工审批及 npm OIDC 发布。发布后 registry 完整性、匿名公开安装、严格类型及运行时消费验证通过；[发布记录](./docs/implementation/phase-two.md#首次-oidc-发布结果)保留确切产物和工作流证据。

- 发布后校验兼容 npm 扫描延迟，暂时性错误最多重试约二十分钟；完整性和来源不符立即失败。
- 补充首版公开发布记录和安装说明，统一版本号更新至 `0.1.0-beta.2`；监控与 Replay 行为不变。

## 0.1.0-beta.1 — 2026-10-15

首个 npm 版本，已通过公开 registry 的固定版本安装、完整性、严格类型及运行时消费验证。

- 合并监控 SDK 与 Taro Replay，对外统一为 `@xumoses/sentry-taro`；Replay 显式开启。
- 对齐 `@sentry/core@10.76.2` 的公共 API 与运行时行为，新增 Replay 直接控制接口及会话策略。
- 提供 ESM、自包含 CJS、类型声明、独立 Worker 和轻量 Taro/React 入口；移除 UMD。兼容变化与迁移步骤见[第二阶段迁移说明](./docs/migrations/phase-two-runtime.md)。
- 统一版本更新和发布校验，配置 tag 触发的 GitHub Actions、人工审批及 npm OIDC 发布流程。

支持与验证范围以 README 和[实施记录](./docs/implementation/phase-two.md)为准；本地、真实服务、CI 与真机验收分别记录。
