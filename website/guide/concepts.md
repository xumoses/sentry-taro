# 核心概念

一句话概括本项目：**官方 Sentry core + 小程序平台适配 + 可选的 Taro DOM Replay**。

它不是一个“小程序版浏览器 SDK”，也不是自成体系的监控方案。它把小程序里能观察到的东西，翻译成 Sentry 本来就理解的语言。

| 层                  | 职责                                             | 原则         |
| ------------------- | ------------------------------------------------ | ------------ |
| Sentry 服务         | Issues、Traces、Replays 的接收、关联与播放       | 只说官方协议 |
| 官方 `@sentry/core` | client、scope、采样、集成、事件处理与传输管线    | 复用，不重写 |
| 小程序适配          | 异常、网络、页面生命周期、存储、栈帧、Worker     | 只做平台差异 |
| 可选 Replay         | 读取 Taro DOM → 录制 → 会话协调 → 投递           | 按需引入     |
| 构建插件（构建期）  | 准备 Replay 样式与图片、release 身份和 sourcemap | 不进入运行时 |

## 六条设计理念

### 1. 官方语义是契约

公共 API、默认值和数据协议以一个固定的官方版本（`@sentry/core` 10.76.2）为基线。官方已有的能力，使用官方的名称、参数和行为；你在 Sentry 文档中学到的用法，在这里应该同样成立。

偏离只在平台确实不同的地方出现，并且必须**有说明、可配置、有回归测试**。名称相同不等于兼容，兼容要落到行为上。

### 2. 适配平台，不仿真浏览器

小程序没有浏览器的 DOM、BOM 和视图渲染管线。本项目不去模拟一个浏览器，让官方浏览器 SDK“以为”自己跑在浏览器里；而是在小程序原生的能力上直接实现采集：`wx.request`、页面生命周期、本地存储、Worker。

平台无关的部分复用官方 core，平台相关的部分保持小而清晰。边界一次确定，不为每个接口重新争论“要不要像浏览器”。

### 3. 录制的是逻辑 UI，不是屏幕

Replay 的数据源是 Taro runtime 在逻辑层维护的 DOM：节点、属性、文本和变更。它能告诉你“页面在逻辑上是什么状态、用户做了什么”，但不包含原生组件内部、最终布局和像素。

所以 Replay 是排查线索，而不是录像。样式和图片可以由构建插件补充，使回放更接近真实页面，但不承诺像素级还原。

### 4. 按需付费

错误监控可以独立使用，不引入任何 Replay 代码；Replay 通过 integration 显式开启；压缩 Worker、Canvas 采集、构建插件都是可选项。

包结构遵循同一原则：ESM 优先、导出边界清晰，未使用的能力可以被构建工具裁剪掉。小程序的包体积是硬约束，每一层都要为自己的体积负责。

### 5. 隐私默认收紧

默认不发送个人信息、不采集网络正文；Replay 默认遮罩所有文本和输入，遮挡所有媒体。放宽隐私是显式、局部的选择，例如用 `sentry-unmask` 标记确认安全的静态文案。

遮罩只作用于录制内容。你主动传入的异常信息、标签和上下文，仍由你自己负责。

### 6. 支持以验证为准

“正式支持”指在声明的环境中完成了端到端验证：事件被服务接收、错误与 Replay 正确关联、回放实际可播放。

导出了同名 API、通过了类型检查、本地测试通过、请求被服务端接收，都只是其中一环，不能单独构成“支持”。文档会明确区分**正式支持、未支持与待验证**。

## 关键术语

| 术语               | 含义                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| 统一包             | 只发布 `@xumoses/sentry-taro` 一个包，SDK、Replay、构建插件同版本发布                                                     |
| Taro DOM 录制      | 以 Taro runtime 中可观察的逻辑 UI 状态为来源，生成 Sentry Replay 可重建的录制                                             |
| 录制模式           | `session`：按会话采样并持续上传；`buffer`：在本地保留出错前的滚动窗口，发生异常时再决定是否上传                           |
| Replay 身份        | 一段 Replay 的 ID。切换页面、发送分段不会创建新身份；buffer 被异常提升为 session 后仍保留最初的错误采样身份               |
| 页面桥接（bridge） | Replay integration 提供的平台接入点，负责可见页面根节点、滚动和视口；混合应用中由宿主传给 Taro 页面                       |
| 生命周期所有者     | 负责在页面 show/hide 时接入和释放录制根的那一方：全局 `installTaroReplayPageLifecycle` 或逐页 `useTaroReplayRoot`，二选一 |
| 构建期 / 运行期    | 构建插件只在 Node.js 构建阶段运行，准备资源和身份；运行时代码从不导入它                                                   |

## 能力边界

| 本项目提供                                     | 本项目不提供                                |
| ---------------------------------------------- | ------------------------------------------- |
| 错误、面包屑、scope、性能追踪，复用官方 core   | 完整的浏览器 DOM/BOM 仿真                   |
| 基于 Taro DOM 的 Session Replay，默认隐私遮罩  | 屏幕录像、像素级还原、原生组件内部内容      |
| Taro 构建插件：Replay 资源、release、sourcemap | 浏览器 Replay 的 selector 选项和反馈弹窗 UI |
| 可选 Worker 压缩、原生与 Taro 混合接入         | H5、其他小程序平台和小游戏的正式支持        |

其他小程序平台和小游戏的代码仍保留并保持编译、测试通过，但不在当前开发和验收范围内。

## 延伸阅读

这些理念对应仓库中的设计原则和架构决策记录（ADR），供希望深入了解或参与贡献的读者参考：

- [设计原则](https://github.com/xumoses/sentry-taro/blob/main/docs/design-principles.md)
- [ADR-0002 官方 API 分期对齐](https://github.com/xumoses/sentry-taro/blob/main/docs/adr/0002-stage-official-api-alignment.md)
- [ADR-0003 小程序平台适配](https://github.com/xumoses/sentry-taro/blob/main/docs/adr/0003-mini-program-platform-adaptation.md)
- [ADR-0004 ESM、CJS 与 Worker 产物](https://github.com/xumoses/sentry-taro/blob/main/docs/adr/0004-esm-cjs-worker-artifacts.md)
- [ADR-0005 分层渐进重构](https://github.com/xumoses/sentry-taro/blob/main/docs/adr/0005-layered-structural-refactor.md)
