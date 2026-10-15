# 原生宿主与 Taro 混合应用

混合应用应由原生入口持有唯一的 SDK client 和 Replay integration，再把 `replay.bridge` 交给 Taro 页面。这样错误、Replay 身份和页面切换由同一套状态管理。

本指南适用于 Taro 4.2.x、React 18 的微信小程序接入。原生页面自身没有 Taro DOM，传递 bridge 不会使原生页面自动获得可视录制能力。

## 在宿主初始化一次

在原生宿主入口使用本包完成初始化，配置方法与 [Replay 指南](./replay.md)相同。原生构建使用 CommonJS 时也可以 `require('@xumoses/sentry-taro')`。

```ts
// 宿主拥有的 monitoring.ts
import * as Sentry from '@xumoses/sentry-taro';

const replay = Sentry.replayIntegration();

Sentry.init({
  dsn: 'https://PUBLIC_KEY@YOUR_SENTRY_HOST/PROJECT_ID',
  sendDefaultPii: false,
  traceNetworkBody: false,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 1,
  integrations: [replay],
});

export const monitoring = {
  replayBridge: replay.bridge,
  captureException: (error: unknown) => Sentry.captureException(error),
};
```

通过应用已有的宿主通信层暴露 `monitoring`。它应返回宿主中的同一个对象，不能在 Taro 分包中再次初始化 SDK。下面的 `getHostMonitoring` 是应用自行实现的通信入口，不是本包 API。

## Taro 侧使用轻量入口

```tsx
// Taro 应用入口，在页面创建之前安装。
import type { PropsWithChildren } from 'react';
import { installTaroReplayPageLifecycle } from '@xumoses/sentry-taro/taro/lifecycle';
import { getHostMonitoring } from './host-bridge';

const { replayBridge } = getHostMonitoring();
installTaroReplayPageLifecycle({ bridge: replayBridge });

export default function App({ children }: PropsWithChildren) {
  return children;
}
```

`/taro/lifecycle` 和 `/react/root` 是页面适配入口。Taro 侧通过通信层取得 bridge，避免为了取得它而导入包含 `Sentry.init()` 的宿主初始化模块，导致构建器再次打包完整 SDK。

需要显示录制状态时，从 `@xumoses/sentry-taro/react/root` 导入 `useTaroReplaySnapshot` 并传入同一个 bridge。若选择逐页生命周期，改用 `useTaroReplayRoot`；同一页面不要同时安装全局适配和 root hook。

检查宿主、主包与分包的最终构建产物，确认只保留预期的 SDK 运行时。源码使用同一个包名并不能证明宿主打包后不会产生重复副本；本包的根入口提供 ESM 和 CJS，具体去重和分包行为由宿主构建决定。

## 提供页面样式与静态图片

这部分同样适用于纯 Taro 应用。包不会在运行时读取业务 CSS、扫描应用图片或自动生成资源清单。推荐使用 [Taro 构建插件](./taro-plugin.md) 自动整理共享样式、页面样式和静态图片，再交给生命周期适配；已有自定义构建也可以继续提供以下回调。

两个回调都是同步函数：

```ts
getReplayStyles(route: string): string | undefined;
getReplayImageSources(route: string): Readonly<Record<string, string>> | undefined;
```

`route` 已去除开头的 `/`、查询参数和片段。例如 `/pages/home/index?source=demo` 会对应 `pages/home/index`。图片映射的键则应匹配页面 `Image` 节点实际使用的 `src`，不使用页面 route 代替图片路径。

下面展示资源数据的形状；`replay-assets.ts` 由应用自己维护或在构建时生成：

```ts
// 应用提供的 replay-assets.ts
export const sharedStyles = '[data-taro-node="view"]{box-sizing:border-box}';

export const pageStyles: Record<string, string> = {
  'pages/home/index': '.home-title{font-size:32rpx;font-weight:600}',
};

// 按页面提供经过检查的静态图片映射；未配置时保持媒体默认遮挡。
export const pageImages: Record<string, Readonly<Record<string, string>>> = {};
```

在 Taro 应用入口将资源回调与 bridge 一起传入：

```ts
import { installTaroReplayPageLifecycle } from '@xumoses/sentry-taro/taro/lifecycle';
import { getHostMonitoring } from './host-bridge';
import { pageImages, pageStyles, sharedStyles } from './replay-assets';

installTaroReplayPageLifecycle({
  bridge: getHostMonitoring().replayBridge,
  getReplayStyles: (route) => `${sharedStyles}\n${pageStyles[route] || ''}`,
  getReplayImageSources: (route) => pageImages[route],
});
```

纯 Taro 应用可以将 `bridge` 换为初始化时保存的 `replay.bridge`。资源清单、回调和初始化都应在页面创建前准备好。

样式会用于浏览器中的 Replay 渲染，需要使用能匹配录制节点的选择器。类名可以沿用；原生标签选择器应按录制结果转换，例如用 `[data-taro-node="view"]` 匹配 Taro `View`。录制器按视口宽度转换 `rpx`，但不会计算微信原生控件的最终样式。构建时提供的 CSS 属于可信输入，应在生成时审查其中的 URL 和 `content` 等文本。

图片映射的值使用已检查的静态图片 data URI。映射为单张图片提供显式许可，可能在 `blockAllMedia: true` 时仍被录制，所以只应包含随应用发布的安全资源。录制器会检查支持的 data URI 形式及单项大小；不要用它传入用户上传图片、带身份信息的资源或动态截图。资源清单也会增加宿主包体积与录制数据量，建议按页面挑选需要的资源。

## 构建和运行检查

确保宿主通信层在 Taro 页面创建前可用，主包和分包引用同一个 bridge。随后检查首次进入、页面跳转、返回、隐藏和重新显示的录制行为，以及错误与 Replay 的关联。

样式和图片需要在真实 Playback 中核对。原生组件内部、最终视图层时序及浏览器计算样式不在 Taro DOM 中，因此这些回调不能保证像素级还原。开发者工具通过后，仍需在目标真机检查页面行为、隐私和运行开销。

如果开启压缩，还需将独立 Worker 放入宿主最终产物并配置 `app.json`，见 [Worker 压缩](./worker.md)。从旧双包接入迁移时，同时更新宿主 npm 构建规则与旧运行时产物，见[旧包迁移](../migrations/legacy-packages.md)。

继续阅读：[Replay 指南](./replay.md) · [API 参考](./api.md) · [Worker 压缩](./worker.md)
