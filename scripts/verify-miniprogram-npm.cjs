const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TraceMap, originalPositionFor } = require('@jridgewell/trace-mapping');

const pkg = require('../package.json');
const SOURCE_MAP_COMMENT = /^\/\/# sourceMappingURL=(.+)$/gm;

/**
 * Packs the installed tarball with WeChat's own npm builder, as a native consumer
 * using the SDK's packing ignores would, and checks the entry WeChat compiles.
 * `directory` must hold a package.json depending on the tarball and an npm-style
 * (hoisted) node_modules, which is the layout packNpm resolves.
 */
async function verifyMiniProgramNpm(directory) {
  // Resolve the builder from this repository; the consumer only holds the SDK.
  const { packNpmManually } = require('miniprogram-ci');
  const installed = path.join(directory, 'node_modules', pkg.name);
  const { getSentryMiniProgramNpmIgnores } = require(
    path.join(installed, 'dist/taro-plugin/index.cjs.js'),
  );
  const result = await packNpmManually({
    packageJsonPath: path.join(directory, 'package.json'),
    miniprogramNpmDistDir: directory,
    ignores: getSentryMiniProgramNpmIgnores(),
  });
  const warnings = (result?.warnList ?? []).map((warning) =>
    [warning.msg || warning.tips, warning.jsPath].filter(Boolean).join(' @ '),
  );
  assert.deepEqual(warnings, [], 'WeChat npm packing reported warnings');

  const npmOutput = path.join(directory, 'miniprogram_npm');
  assert.deepEqual(
    fs.readdirSync(npmOutput).sort(),
    [pkg.name.split('/')[0]],
    'Only the SDK may be packed; core and fflate are bundled into its native entry',
  );
  const packed = path.join(npmOutput, pkg.name);
  const entry = path.join(packed, 'index.js');
  const source = fs.readFileSync(entry, 'utf8');
  const comments = [...source.matchAll(SOURCE_MAP_COMMENT)].map((match) => match[1].trim());
  assert.deepEqual(comments, ['index.js.map'], 'Packed entry must reference exactly its own map');

  // The miniprogram directory is copied verbatim: no module wrapper, one map reference.
  assert.equal(source, fs.readFileSync(path.join(installed, pkg.miniprogram, 'index.js'), 'utf8'));
  const mapPath = path.join(packed, comments[0]);
  assert.ok(fs.existsSync(mapPath), 'Packed entry sourcemap is missing');
  const map = new TraceMap(fs.readFileSync(mapPath, 'utf8'));
  assert.equal(map.file, 'index.js');
  // SDK_NAME is defined once in the SDK source; its packed position must map back there.
  const offset = source.search(/[`'"]sentry\.javascript\.taro[`'"]/);
  assert.ok(offset >= 0, 'SDK name marker missing from the packed entry');
  const before = source.slice(0, offset).split('\n');
  const original = originalPositionFor(map, {
    line: before.length,
    column: before[before.length - 1].length,
  });
  assert.match(String(original.source), /(?:^|\/)src\/sdk\//, 'Packed map does not reach src/');
  const files = fs.readdirSync(packed).sort();
  return { files, source: original.source, line: original.line };
}

module.exports = { verifyMiniProgramNpm };
