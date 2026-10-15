const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { parse } = require('acorn');
const { verifyVersions } = require('./release-config.cjs');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const pkg = require('../package.json');
const requiredExports = [
  'init',
  'captureException',
  'getClient',
  'getReplay',
  'startTaroDomReplayPoc',
  'replayIntegration',
  'taroReplayIntegration',
  'createTaroReplay',
  'decodeReplayAssetData',
];

function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
}
function targets(value) {
  return typeof value === 'string' ? [value] : Object.values(value).flatMap(targets);
}
function run(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${path.basename(script)} failed`);
}
function assertApi(api) {
  for (const name of requiredExports) assert.equal(typeof api[name], 'function', `Missing ${name}`);
  assert.equal(api.SDK_VERSION, pkg.version);
  assert.equal(api.SDK_NAME, 'sentry.javascript.taro');
  assert.equal(api.replayIntegration, api.taroReplayIntegration);
  const replay = api.replayIntegration({ minReplayDuration: 0 });
  assert.equal(replay.name, 'Replay');
  for (const name of [
    'start',
    'startBuffering',
    'stop',
    'flush',
    'getReplayId',
    'getRecordingMode',
  ]) {
    assert.equal(typeof replay[name], 'function', `Missing Replay control ${name}`);
  }
}

async function main() {
  verifyVersions(root);
  for (const target of targets(pkg.exports)) {
    assert.ok(fs.existsSync(path.join(root, target)), `Missing export target ${target}`);
  }
  for (const target of Object.values(pkg.bin)) {
    assert.ok(fs.existsSync(path.join(root, target)), 'Missing CLI target');
  }
  const publishFiles = files(dist);
  assert.ok(
    publishFiles.every((file) => !/\.umd\./.test(file)),
    'Stale UMD output must not be published',
  );
  let parsed = 0;
  for (const file of publishFiles) {
    // The optional viewer runs on Node; all mini-program assets must parse as ES2015.
    if (!/\.(?:mjs|js)$/.test(file) || file.includes(`${path.sep}devtools${path.sep}`)) continue;
    parse(fs.readFileSync(file, 'utf8'), {
      ecmaVersion: 2015,
      sourceType: file.endsWith('.mjs') ? 'module' : 'script',
    });
    parsed++;
  }

  let checkedSources = 0;
  for (const file of publishFiles.filter((name) => name.endsWith('.map'))) {
    const map = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(map.version, 3);
    assert.ok(map.mappings.length > 0);
    assert.equal(map.sources.length, map.sourcesContent.length);
    assert.ok(!map.sourceRoot);
    assert.equal(new Set(map.sources).size, map.sources.length, 'Duplicate bundled source');
    for (const [index, source] of map.sources.entries()) {
      assert.ok(!path.isAbsolute(source) && !/^[a-z]:[\\/]/i.test(source), 'Absolute source path');
      assert.ok(!/(?:^|\/)(?:Users|home|private|tmp)\//i.test(source), 'Machine source path');
      assert.equal(typeof map.sourcesContent[index], 'string');
      if (!source.startsWith('../node_modules/')) {
        const local = path.resolve(path.dirname(file), source);
        assert.ok(local.startsWith(root + path.sep), 'Source escapes repository');
        assert.ok(
          map.sourcesContent[index] === fs.readFileSync(local, 'utf8'),
          `Stale sourcemap source: ${source}`,
        );
      }
      checkedSources++;
    }
    if (/(?:react-root|taro-lifecycle)\./.test(path.basename(file))) {
      assert.ok(
        map.sources.every(
          (source) => !/sdk\/src|@sentry\/core|coordinator\/|compression\//.test(source),
        ),
        'A lightweight entry bundled the SDK or coordinator',
      );
    }
  }

  const mainSource = fs.readFileSync(path.join(dist, 'index.cjs.js'), 'utf8');
  for (const author of ['Functional Software', 'Arjun Barrett']) {
    assert.ok(mainSource.includes(author), 'Bundled third-party notice missing');
    assert.ok(fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES'), 'utf8').includes(author));
  }
  const sandbox = vm.createContext({ console, setTimeout, clearTimeout });
  const module = { exports: {} };
  const factory = vm.runInContext(
    `(function(module, exports, require) {\n${mainSource}\n})`,
    sandbox,
  );
  factory(module, module.exports, () => {
    throw new Error('Root entry must not require external runtime modules');
  });
  assertApi(module.exports);
  const esmPath = path.join(dist, 'index.mjs');
  const esmProgram = parse(fs.readFileSync(esmPath, 'utf8'), {
    ecmaVersion: 2015,
    sourceType: 'module',
  });
  const esmImports = esmProgram.body
    .filter((statement) => statement.type === 'ImportDeclaration')
    .map((statement) => statement.source.value);
  assert.deepEqual(
    esmImports,
    ['fflate/browser'],
    'ESM must retain only the optional codec dependency boundary',
  );
  assert.equal(
    typeof pkg.dependencies.fflate,
    'string',
    'The ESM codec must be a runtime dependency',
  );
  assertApi(await import(pathToFileURL(esmPath).href));

  run(path.join(root, 'packages/replay/scripts/verify-assets.cjs'), [dist]);
  const worker = path.join(dist, 'worker/replay-compression.js');
  assert.equal(
    fs.readFileSync(worker, 'utf8'),
    fs.readFileSync(path.join(root, 'packages/replay/dist/worker/replay-compression.js'), 'utf8'),
  );
  run(path.join(root, 'packages/replay/scripts/verify-worker.cjs'));
  console.log(
    `Verified ${parsed} ES2015 assets, ${checkedSources} portable sourcemap sources, exports, notices, isolated root and Worker.`,
  );
}
main().catch((error) => {
  // Parser failures must not dump a minified line or captured payload.
  console.error(`Package verification failed: ${error.message}`);
  process.exitCode = 1;
});
