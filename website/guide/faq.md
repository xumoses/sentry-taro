# 常见问题

## Replay 回放里，某个列表的滚动位置没有变化

Replay 只能录制逻辑层能收到滚动事件的区域：页面滚动、`ScrollView`（`scroll-view`），以及 `Swiper` 切页。微信的 `view` 即使设置了 CSS `overflow: auto` / `overflow: scroll`，滚动时也不会向逻辑层派发事件，SDK 无从得知滚动位置，回放会停在该区域的初始位置。

常见情形是第三方组件（例如表格）在内部用 `View` 加 CSS overflow 实现滚动。这类区域的滚动不会出现在 Replay 中，录制的其他内容不受影响。

需要回放这类区域的滚动时，把滚动容器改为 `ScrollView`：

```tsx
import { ScrollView } from '@tarojs/components';

<ScrollView scrollY style={{ height: '100%' }}>
  {/* 原本放在 overflow 容器里的内容 */}
</ScrollView>;
```

无法改动组件内部实现时，可以让外层页面滚动代替组件内部滚动。这是平台限制，不属于需要额外配置的功能。

## 开发者工具中的错误没有还原到源码

开发者工具使用 `http://127.0.0.1:<端口>/appservice/…` 加载本地编译产物，与上传到 Sentry 的微信最终映射不是同一份代码，SDK 也不会改写这些帧。源码还原请在体验版或线上版本中验证，见 [Taro 构建插件](./taro-plugin.md)。
