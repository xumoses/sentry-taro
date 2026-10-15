const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { inflateSync } = require('node:zlib');
const plugin = require('@xumoses/sentry-taro/taro-plugin');
const { createReplayAssetProviders } = require('@xumoses/sentry-taro');

async function main() {
  const esm = await import('@xumoses/sentry-taro/taro-plugin');
  for (const api of [plugin, esm]) {
    assert.equal(api.default, api.sentryTaroPlugin);
    for (const name of [
      'generateReplayAssets',
      'uploadSourceMaps',
      'createSentryBuildMetadata',
      'readSentryBuildMetadata',
      'writeSentryBuildMetadata',
      'writeReplayWorker',
      'getSentryMiniProgramNpmIgnores',
    ])
      assert.equal(typeof api[name], 'function');
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-taro-plugin-consumer-'));
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h2v2z"/></svg>';
  const uri = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  const files = {
    'src/pages/gallery/assets/icon.svg': svg,
    'dist/app.json': JSON.stringify({ pages: ['pages/gallery/index'] }),
    'dist/app.wxss': 'page { color: red }',
    'dist/pages/gallery/index.js': `module.exports = ${JSON.stringify(uri)};`,
    'dist/pages/gallery/index.wxss': 'view { display: flex }',
  };
  try {
    for (const [name, source] of Object.entries(files)) {
      const file = path.join(root, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, source);
    }
    // Both packed module formats must work without parser or Taro peers installed.
    for (const api of [plugin, esm]) {
      let finish;
      api.default({
        paths: {
          appPath: root,
          sourcePath: path.join(root, 'src'),
          outputPath: path.join(root, 'dist'),
        },
        modifyRunnerOpts() {},
        modifyWebpackChain() {},
        onBuildFinish(callback) {
          finish = callback;
        },
      });
      finish();
      const metadata = api.createSentryBuildMetadata({
        projectDir: root,
        release: { name: 'synthetic@1', dist: 'build-1' },
      });
      api.writeSentryBuildMetadata({
        metadata,
        outputRoot: path.join(root, 'dist'),
        format: 'module',
      });
      assert.equal(
        api.readSentryBuildMetadata({
          outputRoot: path.join(root, 'dist'),
          expected: { name: 'synthetic@1', dist: 'build-1' },
        }).dist,
        'build-1',
      );
      await api.uploadSourceMaps({ disable: true });
      const worker = api.writeReplayWorker({
        projectDir: __dirname,
        outputRoot: path.join(root, 'workers'),
      });
      assert.deepEqual(
        fs.readFileSync(worker),
        fs.readFileSync(require.resolve('@xumoses/sentry-taro/worker')),
      );
      const finalRoot = path.join(root, 'final-wechat');
      const finalMap = path.join(finalRoot, '__APP__/app-service.js.map');
      fs.mkdirSync(path.dirname(finalMap), { recursive: true });
      const finalMapData = JSON.stringify({
        version: 3,
        sources: ['synthetic.js'],
        names: [],
        mappings: 'AAAA',
      });
      fs.writeFileSync(finalMap, finalMapData);
      // The Node entry loads without the optional CLI. Only an explicit upload needs it.
      await assert.rejects(
        api.uploadSourceMaps({
          release: { name: 'synthetic@1' },
          wechat: { sourceMapPath: finalRoot },
          silent: true,
        }),
        /Cannot find (?:package|module).*@sentry\/cli/,
      );
      assert.equal(fs.readFileSync(finalMap, 'utf8'), finalMapData);
      const providers = createReplayAssetProviders({
        readAssetFile: () => fs.readFileSync(path.join(root, 'dist/replay-assets.json'), 'utf8'),
        readPackagedImage: (name) => fs.readFileSync(path.join(root, 'dist', name), 'base64'),
      });
      assert.equal(providers.getReplayImageSources('pages/gallery/index')[uri], uri);
      assert.match(providers.getReplayStyles('pages/gallery/index'), /data-taro-node/);
      api.generateReplayAssets({
        replay: {
          sourceRoot: path.join(root, 'src'),
          outputRoot: path.join(root, 'dist'),
          output: 'modules',
        },
      });
      const decode = (encoded, bytes) => {
        const value = inflateSync(Buffer.from(encoded, 'base64'));
        assert.equal(value.byteLength, bytes);
        return JSON.parse(value.toString());
      };
      const load = (name) => {
        const sandbox = { module: { exports: {} } };
        vm.runInNewContext(fs.readFileSync(path.join(root, 'dist', name), 'utf8'), sandbox);
        return sandbox.module.exports(decode);
      };
      assert.equal(load('replay-images.js')('pages/gallery/index')[uri], uri);
      assert.match(load('replay-styles.js')('pages/gallery/index'), /data-taro-node/);
    }
    console.log('Packed Taro plugin passed: isolated CJS/ESM, page-local SVG, generated runtime.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(`Packed plugin failed: ${error.message}`);
  process.exitCode = 1;
});
