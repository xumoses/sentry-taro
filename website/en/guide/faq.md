# FAQ

## A list's scroll position never changes in Replay playback

Replay can only record areas whose scrolling reaches the logic layer: page scrolling, `ScrollView` (`scroll-view`) and `Swiper` paging. A WeChat `view` with CSS `overflow: auto` / `overflow: scroll` dispatches no scroll events to the logic layer, so the SDK cannot see its scroll position and playback stays at the area's initial position.

This usually happens with third-party components, such as tables, that scroll inside a `View` with CSS overflow. Scrolling in such areas is missing from Replay; the rest of the recording is unaffected.

To replay scrolling in such an area, make the scroll container a `ScrollView`:

```tsx
import { ScrollView } from '@tarojs/components';

<ScrollView scrollY style={{ height: '100%' }}>
  {/* content previously inside the overflow container */}
</ScrollView>;
```

If you cannot change the component's internals, let the page scroll instead of the component. This is a platform limitation, not a feature that needs extra configuration.

## Errors from WeChat DevTools are not symbolicated

DevTools loads the local build from `http://127.0.0.1:<port>/appservice/…`, which is not the code the final WeChat maps uploaded to Sentry describe, and the SDK does not rewrite these frames. Verify symbolication on a trial or release build; see [Taro build plugin](./taro-plugin.md).

## Main-package frames point to an unrelated file on desktop WeChat

On Mac desktop WeChat, frames in the main package (`https://usr/app-service.js`) may all resolve to one unrelated business file, usually the last file in the map. Subpackage frames and errors from phones are unaffected.

The cause is on WeChat's side: the main-package script the desktop client runs has extra lines compared with the code WeChat's final source map describes. **Only line numbers shift; columns are correct.** Error lines therefore fall past the end of the map, and Sentry can only match the last mapping. The WeChat team has confirmed on its community forum that main-package source maps can be off because of a line offset while columns are correct, and said a fix would take time; developers still report it:

- [线上小程序sourcemap解析输出的为什么是null？](https://developers.weixin.qq.com/community/develop/doc/000288fd5e0608d49dcc2476a5b400) (2021, with an official reply, Chinese)
- [线上小程序分包解析正常，主包 sourcemap 解析为 null](https://developers.weixin.qq.com/community/develop/doc/000eeca78cce1096cf0e0534956400) (2022, Chinese)
- [sourceMap下载版本也是正确的 但是行号输入一直无法匹配](https://developers.weixin.qq.com/community/develop/doc/000a0a189f47c0ff266d753bb5bc00) (2022, Chinese)

From `0.1.0-rc.3`, the default `rewriteFramesIntegration()` subtracts the client's offset from main-package line numbers on **known** desktop clients before Sentry matches them; corrected events carry `contexts.miniapp.main_package_line_offset`. Mac WeChat `4.1.15.55` is known to shift by 1406 lines, measured from paired phone and desktop events of the same build. Phones, DevTools, subpackage frames and unlisted desktop versions are left unchanged rather than guessed; the offset varies by client version, so unlisted versions still show the symptom.

If you see the same symptom on another desktop client, compare the line numbers of one frame from the same build on a phone and on the desktop, and open an issue with the client version.
