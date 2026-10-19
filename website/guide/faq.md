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

## 电脑版微信上，主包的堆栈帧指向了无关文件

在 Mac 电脑版微信上，主包（`https://usr/app-service.js`）报错的堆栈帧可能全部被还原到同一个无关的业务文件，常见的是映射的最后一个文件。分包的帧和手机上的报错不受影响。

原因在微信侧：电脑版客户端实际运行的主包脚本，比微信生成的最终 sourcemap 所描述的代码多出若干行，**只有行号整体偏移，列号正确**。报错行号因此落到映射末尾之外，Sentry 只能匹配到最后一条映射。微信团队曾在社区确认主包 sourcemap 存在"行号偏移导致不对，列号是正确的"的问题，并表示修复需要时间，至今仍有开发者反馈：

- [线上小程序sourcemap解析输出的为什么是null？](https://developers.weixin.qq.com/community/develop/doc/000288fd5e0608d49dcc2476a5b400)（2021，含官方回复）
- [线上小程序分包解析正常，主包 sourcemap 解析为 null](https://developers.weixin.qq.com/community/develop/doc/000eeca78cce1096cf0e0534956400)（2022）
- [sourceMap下载版本也是正确的 但是行号输入一直无法匹配](https://developers.weixin.qq.com/community/develop/doc/000a0a189f47c0ff266d753bb5bc00)（2022）

从 `0.1.0-rc.4` 起，默认的 `rewriteFramesIntegration()` 在**已知的**电脑版客户端上，于事件发送前（所有 `beforeSend` 之后）把主包帧的行号减去该客户端的偏移；修正过的事件带有 `contexts.miniapp.main_package_line_offset`。`beforeSend` 中看到的仍是运行时行号，即使它按原始堆栈重新解析帧，修正也不会丢失；不要在 `beforeSend` 里自行减去偏移，否则会重复修正。目前已知 Mac 微信 `4.1.15.55` 偏移 1406 行，这个值来自同一构建在手机和电脑上的成对事件。手机、开发者工具、分包帧以及未列出的电脑版本一律保持原样，不做猜测；偏移值因客户端版本而异，未列出的版本仍会出现上述现象。

如果你在其他电脑版客户端上遇到同样的现象，可以对比同一构建在手机和电脑上同一帧的行号差，并附上客户端版本提交 issue。
