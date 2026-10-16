const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('acorn');

const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'dist/index.mjs');
const outputDirectory = path.join(root, '.artifacts/consumer-bundles');
const reportPath = path.join(outputDirectory, 'report.json');
const base64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// sourcesContent can retain discarded modules. Read mapping segments to count
// only source files that actually contribute generated code to the consumer.
function mappedSources(map) {
  let sourceIndex = 0;
  const sources = new Set();
  for (const segment of map.mappings.split(/[;,]/)) {
    if (!segment) continue;
    const fields = [];
    let value = 0;
    let shift = 0;
    for (const character of segment) {
      const digit = base64.indexOf(character);
      assert.ok(digit >= 0, 'Invalid source map VLQ');
      value += (digit & 31) * 2 ** shift;
      if (digit & 32) {
        shift += 5;
      } else {
        fields.push(value & 1 ? -(value >> 1) : value >> 1);
        value = 0;
        shift = 0;
      }
    }
    if (fields.length < 4) continue;
    sourceIndex += fields[1];
    const source = map.sources[sourceIndex];
    assert.equal(typeof source, 'string', 'Invalid source map source index');
    sources.add(source.replace(/\\/g, '/'));
  }
  return [...sources].sort();
}

async function bundle(build, name, fixture) {
  const result = await build({
    configFile: false,
    root,
    mode: 'production',
    logLevel: 'warn',
    resolve: { alias: { '@xumoses/sentry-taro': entry } },
    plugins: [
      {
        name: 'published-sdk-source-map',
        // Feed the published map through the production build so attribution
        // follows the library's original modules after consumer tree shaking.
        load(id) {
          if (id !== entry) return;
          return {
            code: fs.readFileSync(entry, 'utf8'),
            map: JSON.parse(fs.readFileSync(`${entry}.map`, 'utf8')),
          };
        },
      },
    ],
    build: {
      write: false,
      target: 'es2015',
      minify: 'oxc',
      sourcemap: true,
      reportCompressedSize: false,
      rolldownOptions: {
        input: path.join(__dirname, 'fixtures', fixture),
        output: { format: 'iife', name: 'SyntheticSentryConsumer' },
      },
    },
  });
  assert.ok(!Array.isArray(result) && 'output' in result, 'Expected one consumer build');
  const chunks = result.output.filter((item) => item.type === 'chunk');
  assert.equal(chunks.length, 1, 'Synthetic consumer must stay self-contained');
  const chunk = chunks[0];
  assert.ok(chunk.map, 'Consumer source map is required');
  assert.equal(chunk.imports.length + chunk.dynamicImports.length, 0);
  parse(chunk.code, { ecmaVersion: 2015, sourceType: 'script' });
  const sourceMapName = `${name}.js.map`;
  const code = chunk.code.replace(
    /\/\/# sourceMappingURL=.*$/,
    `//# sourceMappingURL=${sourceMapName}`,
  );
  fs.writeFileSync(path.join(outputDirectory, `${name}.js`), code);
  fs.writeFileSync(path.join(outputDirectory, sourceMapName), chunk.map.toString());
  return {
    mainRawBytes: Buffer.byteLength(code),
    mappedSources: mappedSources(chunk.map),
  };
}

async function main() {
  fs.rmSync(reportPath, { force: true });
  assert.ok(fs.existsSync(entry), 'Build the package before verifying consumers');
  const workerPath = path.join(root, 'dist/worker/replay-compression.js');
  assert.ok(fs.existsSync(workerPath), 'Run the complete package build before verifying consumers');
  fs.mkdirSync(outputDirectory, { recursive: true });
  const { build } = await import('vite-plus');
  const errors = await bundle(build, 'errors-only', 'bundle-errors.mjs');
  const replay = await bundle(build, 'errors-replay', 'bundle-replay.mjs');
  const replayWorker = await bundle(build, 'errors-replay-worker', 'bundle-worker.mjs');
  const recorder = /src\/replay\/recorder\//;
  const coordinator = /src\/replay\/coordinator\//;
  const replaySource = (source) =>
    recorder.test(source) || /src\/replay\/|(?:^|\/)fflate(?:@[^/]+)?\//.test(source);
  assert.deepEqual(
    errors.mappedSources.filter(replaySource),
    [],
    'Errors-only consumer retained Replay code',
  );
  for (const result of [replay, replayWorker]) {
    assert.ok(
      result.mappedSources.some((source) => recorder.test(source)),
      'Replay consumer lost its recorder',
    );
    assert.ok(
      result.mappedSources.some((source) => coordinator.test(source)),
      'Replay consumer lost its coordinator',
    );
  }
  for (const result of [errors, replay, replayWorker]) {
    assert.ok(
      result.mappedSources.some((source) => /src\/sdk\/polyfills\./.test(source)),
      'Mini-program polyfill installation was discarded',
    );
    assert.ok(
      !result.mappedSources.some((source) =>
        /src\/replay\/worker\/replay-compression\./.test(source),
      ),
      'Standalone Worker code entered the main consumer',
    );
  }
  assert.ok(
    replay.mainRawBytes > errors.mainRawBytes,
    'Replay should have a measurable opt-in cost',
  );
  const workerRawBytes = fs.statSync(workerPath).size;
  for (const result of [errors, replay, replayWorker]) {
    result.workerRawBytes = result === replayWorker ? workerRawBytes : 0;
    result.totalRawBytes = result.mainRawBytes + result.workerRawBytes;
  }
  const report = {
    scope: 'Synthetic production ESM consumers; raw JavaScript bytes, not mini-program upload size',
    packageVersion: require('../package.json').version,
    coreVersion: require('@sentry/core/package.json').version,
    entrySha256: createHash('sha256').update(fs.readFileSync(entry)).digest('hex'),
    errors,
    replay,
    replayWorker,
    replayIncrementBytes: replay.mainRawBytes - errors.mainRawBytes,
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `Synthetic production bundles passed: errors ${errors.totalRawBytes} B; errors + Replay ${replay.totalRawBytes} B; errors + Replay + Worker ${replayWorker.mainRawBytes} + ${workerRawBytes} = ${replayWorker.totalRawBytes} B.`,
  );
}

main().catch((error) => {
  console.error(`Synthetic bundle verification failed: ${error.message}`);
  process.exitCode = 1;
});
