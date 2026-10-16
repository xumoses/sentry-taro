const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { inflateSync } = require('node:zlib');

const source = fs.readFileSync(
  path.resolve(__dirname, '../.build/worker/replay-compression.js'),
  'utf8',
);
assert(
  source.includes('Copyright (c) 2023 Arjun Barrett'),
  'Bundled fflate MIT notice is required',
);
let receive;
const messages = [];
// Deliberately omit TextEncoder/TextDecoder, DOM, wx and browser Worker APIs.
vm.runInNewContext(source, {
  worker: {
    onMessage(callback) {
      receive = callback;
    },
    postMessage(message) {
      messages.push(message);
    },
  },
});
receive({ protocol: 1, id: 1, method: 'init' });
assert.equal(messages[0].success, true);
const events = [{ type: 2, timestamp: 1, data: { text: 'A汉字🙂𝄞\ud800'.repeat(1000) } }];
const serialized = JSON.stringify(events);
receive({ protocol: 1, id: 2, method: 'compress', data: serialized });
const reply = messages[1];
assert.equal(reply.success, true);
const compressed = Buffer.from(reply.data, 'base64');
assert.equal(
  inflateSync(compressed).toString('utf8'),
  serialized,
  'Worker UTF-8/zlib round trip failed',
);
assert(compressed.length < Buffer.byteLength(serialized));
console.log('[worker] standalone zlib, Unicode, missing TextEncoder and bundled license verified');
