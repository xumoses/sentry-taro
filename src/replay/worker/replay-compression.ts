import { zlibSync } from 'fflate';
import { encodeUtf8 } from '../../sdk/utf8';
import { encodeBase64 } from './base64';

declare const worker: {
  onMessage(listener: (message: Record<string, unknown>) => void): void;
  postMessage(message: Record<string, unknown>): void;
};

// The standalone build runs in a WeChat worker, without wx, DOM, Blob or network APIs.
worker.onMessage((message) => {
  const id = message['id'];
  if (!Number.isSafeInteger(id) || message['protocol'] !== 1) return;
  if (message['method'] === 'init') {
    worker.postMessage({ protocol: 1, id, method: 'init', success: true });
    return;
  }
  if (message['method'] !== 'compress') return;
  const data = message['data'];
  try {
    if (typeof data !== 'string' || data.length > 20 * 1024 * 1024)
      throw new Error('Invalid input');
    // Sentry's Replay worker uses zlib for the JSON events array. The segment
    // header is deliberately added uncompressed by the main thread afterwards.
    const result = zlibSync(encodeUtf8(data), { level: 6 });
    worker.postMessage({
      protocol: 1,
      id,
      method: 'compress',
      success: true,
      data: encodeBase64(result),
    });
  } catch {
    // Never return event data or exception messages to diagnostics.
    worker.postMessage({ protocol: 1, id, method: 'compress', success: false });
  }
});
