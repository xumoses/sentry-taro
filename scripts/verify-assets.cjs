const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { deflateSync } = require('node:zlib');

// The root build assembles the unified public entry; the replay build emits subpaths.
const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../dist');
const context = vm.createContext({});
const modules = new Map();
function load(filename) {
  if (modules.has(filename)) return modules.get(filename).exports;
  const module = { exports: {} };
  modules.set(filename, module);
  const source = fs.readFileSync(filename, 'utf8');
  const factory = vm.runInContext(
    '(function (module, exports, require) {\n' + source + '\n})',
    context,
    { filename },
  );
  factory(module, module.exports, (specifier) => {
    assert(specifier.startsWith('.'), 'Root entry must remain self-contained');
    return load(path.resolve(path.dirname(filename), specifier));
  });
  return module.exports;
}
// This proves the published CJS graph works without Node/browser encoding globals.
for (const name of ['Buffer', 'atob', 'TextDecoder', 'TextEncoder']) {
  assert.equal(vm.runInContext('typeof ' + name, context), 'undefined');
}
assert(
  fs
    .readFileSync(path.join(root, 'index.cjs.js'), 'utf8')
    .includes('Copyright (c) 2023 Arjun Barrett'),
  'Bundled fflate MIT notice is required in the native entry',
);
const { decodeReplayAssetData } = load(path.join(root, 'index.cjs.js'));
assert.equal(typeof decodeReplayAssetData, 'function');
const value = {
  css: '.图表{content:"🙂𝄞"}',
  loneSurrogate: '\ud800',
  image: 'data:image/png;base64,AA==',
};
const json = JSON.stringify(value);
const compressed = deflateSync(Buffer.from(json, 'utf8'));
const actual = decodeReplayAssetData(compressed.toString('base64'), Buffer.byteLength(json));
assert.equal(JSON.stringify(actual), json);
assert.throws(() => decodeReplayAssetData(compressed.toString('base64'), 1));
console.log('[assets] published CJS zlib/Unicode decoding verified without encoding globals');
