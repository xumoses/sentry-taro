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
