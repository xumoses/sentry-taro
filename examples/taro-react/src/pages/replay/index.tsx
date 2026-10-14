import { Button, Text, View } from '@tarojs/components';
import { useState } from 'react';
import { useTaroReplaySnapshot } from '@xumoses/sentry-taro/react/root';
import { getCollectedEnvelopeCount, replay, Sentry } from '../../sentry';

export default function ReplaySyntheticPage() {
  const [count, setCount] = useState(0);
  const [collected, setCollected] = useState(0);
  const snapshot = useTaroReplaySnapshot({ bridge: replay.bridge });
  const collect = async () => {
    Sentry.captureException(new Error('synthetic demo error'));
    await Sentry.flush(2000);
    await replay.bridge.flush();
    await Sentry.flush(2000);
    setCollected(getCollectedEnvelopeCount());
  };

  return (
    <View>
      <Text>Synthetic count: {count}</Text>
      <Text>Replay state: {snapshot.state}</Text>
      <Text>Locally collected envelopes: {collected}</Text>
      <Button onClick={() => setCount((value) => value + 1)}>Increase synthetic count</Button>
      <Button onClick={() => void collect()}>Capture synthetic error locally</Button>
    </View>
  );
}
