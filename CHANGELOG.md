# Changelog

## 未发布

- 修复小程序 API 失败（如 `request:fail timeout`、`hideLoading:fail …`）造成的未处理 rejection 在 Sentry 中以 SDK 压缩后的函数名（`value`、`e.value`、`h`）为标题，并随 SDK 版本拆成多个 issue：这类 rejection 的 reason 是 `{ errMsg }` 普通对象，`@sentry/core` 为它生成的合成堆栈只有 SDK 处理函数和框架帧。现在以 `errMsg` 作为异常值（`Error: request:fail timeout`），不附带堆栈帧，原对象（含 `errno` 等）仍在 `extra.__serialized__`。升级后这类事件会按 `errMsg` 归入新的 issue，旧 issue 可以 resolve；不含 `errMsg` 的普通对象仍按 core 的合成异常处理。
- 修复 Taro DOM Replay 不记录点击：录制器在页面根节点上监听 `tap`、`touchstart` 等事件，但 Taro 只在带原生事件绑定的节点上派发、不在虚拟 DOM 中冒泡，根节点永远收不到子节点的交互，因此 recording 中没有 `ui.click` 面包屑和 rrweb MouseInteraction，Sentry 的 dead/rage click 一直为 0。现改为通过 Taro 运行时的 `dispatchTaroEventFinish` 钩子观察派发（在应用处理函数之后，原生冒泡造成的重复派发只记一次），点击产生 `ui.click` 面包屑和 MouseInteraction，触摸与聚焦同样记录；空闲暂停的“用户活动”判断也改用同一来源，点击会恢复暂停的会话。只能观察到 Taro 实际派发的事件：点在自身及祖先都没有事件处理函数的元素上时，小程序不会派发，也不会被记录。`TaroReplayRuntime` 和 `startTaroReplayRecorder` 的选项新增可选的 `observeEvents`；未提供时仍回退到根节点监听。
- 修复 Replay 每个 segment 的 replay_event 都重复上报当前页面 URL，导致 Sentry 的 `count_urls` 等于 segment 数、页面列表中同一页面出现几十次。现与官方 Replay 一致，`urls` 只包含本 segment 中新进入的页面：第一个 segment 带上起始页面，停留在同一页面的后续 segment 发送空数组，切换页面（包括返回之前的页面）的 segment 带上新页面；error-buffer 转为完整会话时，补发的第一个 segment 带上缓冲窗口内经过的页面。失败重试的 segment 保持原有 `urls`，不会重复计数。升级后新录制的 replay 的 `count_urls` 反映实际页面跳转次数，已上报的 replay 不受影响。

## 0.1.0 — 2026-10-19

首个正式版，发布到 npm `latest`。运行时代码与 `0.1.0-rc.4` 相同；该候选已在首个验证项目中通过电脑微信验收（错误上报、Replay 录制与 Playback、默认上传映射后的栈帧还原），记录见[正式版实施记录](./docs/implementation/release-0.1.0.md)。手机微信仍为待验证。

- `latest` 由 `0.1.0-beta.1` 改为 `0.1.0`：安装命令不再需要 `@rc` 标签，直接安装 `@xumoses/sentry-taro` 即可；`beta` 渠道停在 `0.1.0-beta.6`，不再更新。
- 从 `0.1.0-beta.*` 升级的破坏性变化见 `0.1.0-rc.1` 条目和[正式版前删除的弃用接口](./docs/migrations/phase-two-runtime.md#正式版前删除的弃用接口)；从 `0.1.0-rc.*` 升级无需改动。
- README 与网站中英文安装页、示例和 Agent Skill 的安装命令去掉 `@rc`；网站改用 Sentry 的配色、字体与标志。

## 0.1.0-rc.4 — 2026-10-19

- 修复 `0.1.0-rc.3` 的电脑版主包行号修正可能失效：修正原在事件处理阶段执行，宿主 `beforeSend` 若按 `hint.originalException.stack` 重新解析帧，会把行号覆盖回运行时值，而 `contexts.miniapp.main_package_line_offset` 标记仍保留。现改在 `beforeSendEvent` 钩子（所有 `beforeSend` 之后、发送之前）修正并标记，每个事件只执行一次；`beforeSend` 看到的是运行时行号，不要在其中自行减去偏移。
- 修复 iOS 等 JavaScriptCore 堆栈丢失抛错位置的帧：`@sentry/core` 的事件构建会跳过堆栈第一行（假定为 V8 的 `Error: message` 头），而 JavaScriptCore 堆栈第一行就是帧。现与官方浏览器 SDK 一致从第一行解析，头部行不会被识别为帧；链式错误同样适用。
- `wx.onError` 传入字符串时，以该字符串（含原始堆栈）作为堆栈解析，帧来自出错代码，而不是 SDK 的处理函数；字符串中没有堆栈时事件不再附带指向 SDK 内部的帧。
- 帧路径 `https://usr//…`（重复斜杠）和 `http://usr/…` 统一写成上传产物使用的 `https://usr/…`。
- 微信上 `weapp:///`、`webpack-internal:///` 等其他运行时 scheme 的帧保持原样，不再被改写为冻结平台使用的 `app:///…`。
- 以上修复后，宿主无需在 `beforeSend` 中按原始堆栈重新解析或改写路径；已有此类代码可以删除。

## 0.1.0-rc.3 — 2026-10-19

- 修复 Mac 电脑版微信上主包堆栈帧指向无关业务文件：电脑版实际运行的主包脚本比微信最终映射多出若干行（仅行号偏移，列号正确，微信侧已知问题）。默认 `rewriteFramesIntegration()` 在已知的电脑版客户端上先把主包帧行号减去偏移再匹配，修正过的事件带 `contexts.miniapp.main_package_line_offset`；目前仅收录 Mac 微信 `4.1.15.55`（1406 行）。手机、开发者工具、分包帧和未收录的客户端保持原样。原因与参考见[常见问题](./website/guide/faq.md#电脑版微信上主包的堆栈帧指向了无关文件)。
- 更正 `0.1.0-rc.2` 的说明：其 sourcemap 修复使 `taro.js` 等运行库映射不再被微信丢弃，手机上的运行库帧已在体验版确认还原正确；电脑版的错误映射来自上述行号偏移，由本版本处理。

## 0.1.0-rc.2 — 2026-10-19

- 修复框架运行库帧在 Sentry 中指向无关业务文件：微信生成最终映射时，会整份丢弃 `sourcesContent` 含 null 或空字符串的 sourcemap，并折叠 `../` 逃逸路径（常见于 `taro.js`）。Taro 构建插件在产出后统一改写：逃逸的 source 改名为唯一的 `__external__/…`，缺失或空的内容补为占位注释；映射位置不变。需重新构建并上传映射；Sentry 中的实际还原待体验版确认。
- 新增[常见问题](./website/guide/faq.md)页面，说明 CSS overflow 容器滚动无法录制（微信 `view` 不向逻辑层派发滚动事件，改用 `ScrollView`）等。
- Replay 与官方一致，发送时带上 scope 用户（`Sentry.setUser`，合并 global、isolation、current scope）；修复 `0.1.0-rc.1` 删除 `privacy.allowUser` 后宿主无法为 Replay 关联用户的问题。只设置了 scope 用户的宿主此后会在 Replay 上看到同一用户；`getMetadata` 返回的 `user` 不采用。见[迁移说明](./docs/migrations/phase-two-runtime.md#正式版前删除的弃用接口)。

## 0.1.0-rc.1 — 2026-10-19

正式版 `0.1.0` 的候选版本，通过 npm `rc` 渠道发布。删除 beta 期承诺移除的弃用接口；候选经电脑微信与 Sentry 栈帧还原验收后，以相同内容发布 `0.1.0` 到 `latest`。迁移步骤见[正式版前删除的弃用接口](./docs/migrations/phase-two-runtime.md#正式版前删除的弃用接口)。

破坏性变化：

- 删除低层录制器的弃用别名 `startTaroDomReplayPoc`、`TARO_DOM_REPLAY_POC_MARKER`、`StartTaroDomReplayPocOptions`、`TaroDomReplayPocController`、`TaroReplayPocCapture`、`TaroReplayPocEvent`、`TaroReplayPocMetadata`，改用 `0.1.0-beta.6` 起提供的正式名称；录制数据中的 marker 值不变。
- `SentryMiniappReplaySdk` 的录制方法由 `startTaroDomReplayPoc` 改名为 `startTaroReplayRecorder`；只影响向 `replayIntegration({ sdk })` 传入自定义 `sdk` 的宿主。
- 删除 `Integrations.RewriteFrames` 类和非官方 `enableSourceMap` 选项；默认的 `rewriteFramesIntegration()` 不变，关闭改写改用 `integrations` 回调过滤 `RewriteFrames`。
- `replayIntegration` / `taroReplayIntegration` 不再接受 `privacy` 对象，改用顶层 `maskAllText`、`maskAllInputs`、`blockAllMedia`，新增顶层 `maskAttributes`；`privacy.allowUser` 无替代，Replay 元数据中的自定义 `user` 一律丢弃。遗留的 `privacy` 对象被忽略，其中放宽的设置恢复为默认遮罩。

其他变化：

- 修复默认栈帧路径与构建插件上传前缀不一致：默认集成改为官方 core 的 `rewriteFramesIntegration`（新增同名导出），真机 `https://usr/…` 与 `appservice/…` 帧写成 `https://usr/…`，与上传产物同名；开发者工具 HTTP 帧和基础库帧保持原样。`0.1.0-beta.6` 及更早版本写成 `app:///…`，Sentry 无法匹配默认上传的映射。差异见[运行时迁移说明](./docs/migrations/phase-two-runtime.md#栈帧路径)；Sentry 中的实际还原尚待真实事件确认，是本候选的验收项。
- 使用文档从 `docs/guides/` 迁入项目网站 [`website/`](./website/guide/getting-started.md)，新增“核心概念”页和完整英文版，部署在 [sentry-taro.pages.dev](https://sentry-taro.pages.dev/)；README 精简为概览与文档入口，链接指向线上站点；贡献指南改为英文。
- 新增英文 Agent Skill [`skills/sentry-taro`](./skills/sentry-taro/SKILL.md)，覆盖新项目接入、Replay、Taro 构建插件，以及从 `@xumoses/sentry-miniapp` / `@xumoses/sentry-miniapp-replay-taro` 迁移；可通过 `npx skills add https://github.com/xumoses/sentry-taro --skill sentry-taro` 安装。Skill 不随 npm 包发布，运行时行为不变。

## 0.1.0-beta.6 — 2026-10-16

- 新增与官方 10.76.2 同名的 `captureConsoleIntegration`（core 重导出）和 `httpClientIntegration`，均默认不启用；宿主可替代自行包装的 `console.error` 与 HTTP 5xx 上报。
- `httpClientIntegration` 复用 `NetworkBreadcrumbs` 对平台请求 API 的包装，事件结构与官方一致；URL 去除账号密码、query 和 fragment，请求头与 cookie 仅在 `sendDefaultPii` / `dataCollection` 允许时附带。差异见 [API 指南](./website/guide/api.md#错误采集集成)。
- 离线缓存写入失败的提示改为绕过 console 包装输出，避免被 `captureConsoleIntegration` 再次上报。
- 低层录制器改用正式名称：`startTaroReplayRecorder`、`TARO_REPLAY_CAPTURE_MARKER`、`TaroReplayRecorder`，类型统一为 `StartTaroReplayRecorderOptions`、`TaroReplayCapture`、`TaroReplayEvent`、`TaroReplayMetadata`。`startTaroDomReplayPoc`、`TARO_DOM_REPLAY_POC_MARKER` 及 `TaroReplayPoc*`、`StartTaroDomReplayPocOptions`、`TaroDomReplayPocController` 保留为弃用别名，下一个 beta 移除；录制数据中的 marker 值不变。
- 修复 Replay 缓冲在嵌套文档节点上折叠滚动位置的问题，与录制器的检查点处理保持一致。
- `replayIntegration()` 不再在内部组装 SDK 对象注入协调器；`sdk` 选项仍可选，行为不变。
- 内部结构调整：源码合并为 `src/{sdk,replay,taro-plugin}` 单一目录树，移除内部工作区包；公共入口和产物路径不变。
- 内部结构调整：录制器按子系统拆分为共享状态对象加独立模块，Replay 协调器抽出错误关联与缓冲历史；行为不变，启用 Replay 后产物增加约 4 KB（gzip 约 1 KB）。

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
