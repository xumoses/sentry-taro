# Session Replay

Session Replay 将 Taro 页面结构、交互和错误关联起来，帮助你查看问题发生前后的页面变化。它需要显式开启；只使用错误监控时，无需接入下面的 integration 或页面生命周期。

当前面向 **Taro 4.2.x、React 18、微信小程序**，仍为 Beta。录制基于 Taro 运行时 DOM，不是屏幕视频，也不等同于浏览器 Replay 的全部能力。开发者工具中的发送和 Playback 验证不能替代真机验证。

## 1. 初始化 Replay

在应用中只初始化一次 SDK。下面配置关闭常规会话采样，在发生异常时发送缓冲录制，适合验证接入；上线时按实际流量调整采样率。

```ts
// src/sentry.ts
import * as Sentry from '@xumoses/sentry-taro';

export const replay = Sentry.replayIntegration({
  maskAllText: true,
  maskAllInputs: true,
  blockAllMedia: true,
});

Sentry.init({
  dsn: 'https://PUBLIC_KEY@YOUR_SENTRY_HOST/PROJECT_ID',
  environment: 'production',
  sendDefaultPii: false,
  traceNetworkBody: false,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 1,
  integrations: [replay],
});

export { Sentry };
```

`replayIntegration()` 自动使用本包 SDK，并与默认错误监控集成一起工作。初始化 integration 后还需要接入页面，才能采集 Taro DOM。

## 2. 接入页面生命周期

推荐在 Taro 应用入口调用一次 `installTaroReplayPageLifecycle`，并确保调用发生在页面创建之前：

```tsx
// src/app.tsx
import type { PropsWithChildren } from 'react';
import { installTaroReplayPageLifecycle } from '@xumoses/sentry-taro/taro/lifecycle';
import { replay } from './sentry';

installTaroReplayPageLifecycle({ bridge: replay.bridge });

export default function App({ children }: PropsWithChildren) {
  return children;
}
```

适配层在页面 ready/show 时接入当前可见根，hide/unload 时释放根，同时记录页面滚动和视口变化。切换页面和发送分段不会自动创建新的 Replay 身份。

页面只有在需要显示诊断状态时才使用 `useTaroReplaySnapshot`。这个 hook 只订阅状态，不管理页面生命周期：

```tsx
import { Button, Text, View } from '@tarojs/components';
import { useTaroReplaySnapshot } from '@xumoses/sentry-taro/react/root';
import { replay, Sentry } from '../../sentry';

export default function ExamplePage() {
  const snapshot = useTaroReplaySnapshot({ bridge: replay.bridge });

  return (
    <View>
      <Text>Replay: {snapshot.state}</Text>
      <Button onClick={() => Sentry.captureException(new Error('synthetic example error'))}>
        触发测试异常
      </Button>
    </View>
  );
}
```

如果应用更适合逐页接入，可以在需要录制的每个页面组件中调用：

```tsx
import { Text } from '@tarojs/components';
import { useTaroReplayRoot } from '@xumoses/sentry-taro/react/root';
import { replay } from '../../sentry';

export default function ExamplePage() {
  const snapshot = useTaroReplayRoot({ bridge: replay.bridge });
  return <Text>Replay: {snapshot.state}</Text>;
}
```

`useTaroReplayRoot` 同时管理页面生命周期和订阅状态。同一页面只选择一种生命周期接入方式，避免与全局适配重复接管。需要通过回调提供页面样式和静态图片时，使用全局适配，见[样式与图片接入](./hybrid-apps.md#提供页面样式与静态图片)。

`@xumoses/sentry-taro/react` 中的 `useTaroReplay` 是低层单次录制接口，页面 hide/unload 后不会自动恢复。连续会话应使用上面的生命周期适配或 `useTaroReplayRoot`。

## 3. 选择采样方式

两个采样率都在 `0` 到 `1` 之间，省略时默认不自动录制。

| 配置                       | 行为                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `replaysSessionSampleRate` | 按比例选择会话，录制并定期发送分段                                                                           |
| `replaysOnErrorSampleRate` | 大于 `0` 时，为未选中常规会话的页面保留本地滚动缓冲，并在异常发生时按此比例决定是否上传；为 `0` 时不自动缓冲 |
| 两者均为 `0`               | 禁用自动采样，仍可手动开始录制                                                                               |

例如，`0` / `1` 表示只按异常触发发送；`0.1` / `1` 表示抽取约 10% 的常规会话，其余会话仍保留异常缓冲。缓冲上传后继续录制。可在 `replayIntegration` 中配置 `beforeErrorSampling(event)`，返回 `false` 阻止该异常触发缓冲发送；参数定义见 [ReplayCoordinatorOptions](https://github.com/xumoses/sentry-taro/blob/main/src/replay/coordinator/types.ts)。

默认出错前窗口是 **60 秒**。事件数量和字节预算可能使实际保留窗口更短，不能保证每次异常都能拿到完整 60 秒。

## 4. 配置隐私

默认遮罩文本和输入值、遮挡媒体。使用顶层 `maskAllText`、`maskAllInputs`、`blockAllMedia` 调整，`maskAttributes` 指定需要遮罩的属性名；`0.1.0-rc.1` 起不再接受 `privacy.*` 对象。密码输入和显式标记为遮罩的输入始终保持遮罩。

可以对明确不含用户数据的静态文案使用局部标记，同时继续保护敏感区域：

```tsx
<View>
  <Text className="sentry-unmask">帮助中心</Text>
  <View className="sentry-mask">需要遮罩的内容</View>
  <View className="sentry-block">不采集内部内容的区域</View>
</View>
```

对应的 `data-sentry-unmask`、`data-sentry-mask`、`data-sentry-block` 标记也可使用。标记会影响子节点；遮罩标记优先于取消遮罩，阻止区域仅保留占位节点。`sentry-unmask` 不会取消输入值的全局遮罩策略。

媒体可以通过 `sentry-unblock` / `data-sentry-unblock` 局部放行，但 URL 仍会过滤查询参数和片段。构建时提供的可信静态图片映射是另一种逐图片放行方式，即使 `blockAllMedia: true` 也可能显示，详见[静态资源说明](./hybrid-apps.md#提供页面样式与静态图片)。不要把用户上传图片或运行时截图放入该映射。

Canvas 默认关闭，开启后还需要显式节点标记和提供帧读取函数。像素无法使用文本遮罩规则处理。需要自定义接入时，参考 [TaroReplayBridge.recordCanvas 类型](https://github.com/xumoses/sentry-taro/blob/main/src/replay/coordinator/types.ts)和 [Canvas 合成用例](https://github.com/xumoses/sentry-taro/blob/main/test/replay/canvas.test.ts)。

Replay 的遮罩配置不等于 SDK 所有事件字段的过滤。错误消息、手动添加的上下文和日志也应避免包含敏感内容；示例保留 `sendDefaultPii: false`、`traceNetworkBody: false`。上传前检查合成场景的录制和事件内容，再决定是否放宽默认隐私配置。

## 5. 手动控制与发送

`Sentry.getReplay()` 返回当前 client 上注册的 Replay integration；没有注册时返回 `undefined`。也可以直接使用初始化时保存的 `replay` 对象。

```ts
// 自动采样率都为 0 时，也可以手动开启。
Sentry.getReplay()?.start();

// 需要发送当前录制时，先处理 Replay，再等待 SDK transport。
await Sentry.getReplay()?.flush();
await Sentry.flush(2000);

// 停止后，页面再次 show 不会自动重启录制。
await Sentry.getReplay()?.stop();
```

| 方法                                         | 行为                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------ |
| `replay.start()`                             | 开始 session；已经录制时不创建新身份                                           |
| `replay.startBuffering()`                    | 开始本地缓冲；已经录制时不切换模式                                             |
| `replay.flush()`                             | session 发送当前分段；buffer 默认发送并继续 session；未启动时尝试启动 session  |
| `replay.flush({ continueRecording: false })` | 发送 buffer 后停止 recorder，保留当前身份；完整状态语义见 [API 参考](./api.md) |
| `replay.stop()`                              | 默认发送 session 剩余数据，丢弃未发送的 buffer                                 |
| `replay.stop({ flush: true })`               | 停止前也尝试发送 buffer，仍受最短时长限制                                      |
| `replay.bridge.flush()`                      | 兼容入口，只发送 session 分段                                                  |
| `replay.bridge.sendBufferedReplay()`         | 兼容入口，显式发送 buffer                                                      |
| `Sentry.flush(timeout)`                      | 等待 SDK transport，不主动切分或发送 Replay recorder 中的数据                  |

`continueRecording: false` 仅影响 buffer；session 模式会忽略此选项并继续录制。需要停止 session 时使用 `stop()`。

默认最短发送时长为 **4,999 毫秒**，可以通过 `minReplayDuration` 在 `0–50,000` 毫秒内调整。录制尚未达到此时长时，`replay.flush()` 会安排延后发送并立即完成 Promise；随后调用 `Sentry.flush()` 也不能提前越过该门槛。显式 `stop()` 会丢弃尚未达到最短时长的数据。

`flush()` 完成不表示服务已经接收或可以播放。integration 的直接控制方法不会向调用方抛出投递错误，可通过 `onError`、状态快照和服务端实际结果诊断。没有可见 Taro 页面时，手动开始也无法采集页面 DOM。

## 会话和资源限制

| 项目                     | 默认行为                                                     |
| ------------------------ | ------------------------------------------------------------ |
| 已发送 Replay 的最长时长 | 60 分钟；可通过 `maxReplayDuration` 缩短                     |
| 常规 session 无用户活动  | 5 分钟暂停录制，15 分钟过期；后续活动重新采样                |
| 尚未发送的 error buffer  | 保持有界滚动窗口，不因身份年龄或无活动而过期                 |
| error buffer 发送后      | 不套用常规 session 的 5 分钟空闲暂停，仍受时长和过期策略约束 |
| 录制缓冲                 | 默认最多 500 个事件、512 KiB，mutation 保护阈值为 10,000     |
| 投递队列                 | 默认最多 4 段、2 MiB，最多重试 2 次                          |

这些限制控制录制和投递资源，不保证宿主包体积或设备性能。调整前应测量实际宿主的构建体积与运行表现。可选的 [Worker 压缩](./worker.md)不会取消这些限制。

## 常见问题

| 现象                             | 检查方向                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------- |
| 能收到错误，没有 Replay          | 确认 integration 已注册、采样率已配置、生命周期在页面创建前安装，并检查可见页面状态与最短发送时长 |
| 调用 `Sentry.flush()` 后仍无录制 | 先调用 integration 的 `replay.flush()`；兼容的 `bridge.flush()` 不发送 buffer                     |
| 回放中文字和图片不显示           | 先检查默认遮罩和媒体策略；只对已确认安全的内容局部放行                                            |
| 页面布局或图片与实际页面不同     | 包不会自动读取业务 CSS 或收集图片，需提供[构建时资源](./hybrid-apps.md#提供页面样式与静态图片)    |
| 页面返回后不再录制               | 检查是否使用了单次 `useTaroReplay`，或此前显式调用过 `stop()`                                     |
| 原生组件或 Canvas 内容缺失       | Taro DOM 不包含原生组件内部；不支持的节点可能显示为占位，Canvas 需单独显式接入                    |

录制不提供浏览器计算样式或原生视图层的最终渲染时序。样式、字体、原生控件和动画可能与设备显示不同，应在实际 Sentry Playback 和目标设备上检查。

附带 `sentry-taro-viewer` 只用于查看 capture 摘要、事件和 JSON，不提供真正的回放渲染。[Taro React 示例](https://github.com/xumoses/sentry-taro/blob/main/examples/taro-react/README.md)使用本地收集 transport，不会向 Sentry 上传。

继续阅读：[API 参考](./api.md) · [Worker 压缩](./worker.md) · [混合应用](./hybrid-apps.md) · [旧包迁移](./migration.md)
