const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { releaseTag, verifyVersions } = require('./release-config.cjs');
const { updateVersion } = require('./release-version.cjs');

const files = [
  'package.json',
  'packages/sdk/package.json',
  'packages/replay/package.json',
  'packages/sdk/src/version.ts',
];

function fixture(t, version = '0.1.0-beta.1') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-taro-release-version-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const contents = [
    {
      name: '@xumoses/sentry-taro',
      version,
      publishConfig: {
        access: 'public',
        tag: releaseTag(version),
        registry: 'https://registry.npmjs.org/',
      },
      scripts: { test: 'unchanged' },
    },
    { name: '@sentry-taro/internal-sdk', version, private: true },
    { name: '@sentry-taro/internal-replay', version, private: true },
    `// Keep this comment.\nexport const SDK_VERSION = '${version}';\nexport const SDK_NAME = 'sentry.javascript.taro';\n`,
  ];
  for (let index = 0; index < files.length; index += 1) {
    const filename = path.join(root, files[index]);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const value = contents[index];
    fs.writeFileSync(
      filename,
      typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`,
    );
  }
  return root;
}

function snapshot(root) {
  return files.map((file) => fs.readFileSync(path.join(root, file), 'utf8'));
}

function mutateManifest(root, index, mutate) {
  const filename = path.join(root, files[index]);
  const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
  mutate(value);
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
}

test('maps stable and supported prerelease versions to npm channels', () => {
  for (const [version, tag] of [
    ['1.0.0', 'latest'],
    ['0.0.0-alpha.0', 'alpha'],
    ['1.2.3-beta.10', 'beta'],
    ['1.2.3-rc.1', 'rc'],
  ]) {
    assert.equal(releaseTag(version), tag);
  }
});

test('rejects ambiguous, unsupported, and invalid versions', () => {
  for (const version of [
    'v1.0.0',
    '1.0',
    '01.0.0',
    '1.0.0-beta.01',
    '1.0.0-beta',
    '1.0.0-next.1',
    '1.0.0-beta.1.extra',
    '1.0.0+build.1',
    ' 1.0.0',
    '1.0.0\n',
    '9007199254740992.0.0',
    null,
  ]) {
    assert.throws(() => releaseTag(version));
  }
});

test('updates all four version sources and the npm channel while preserving other values', (t) => {
  const root = fixture(t);
  const before = snapshot(root);
  assert.deepEqual(updateVersion(root, '0.1.0-rc.1'), {
    name: '@xumoses/sentry-taro',
    version: '0.1.0-rc.1',
    tag: 'rc',
    registry: 'https://registry.npmjs.org/',
    changed: true,
  });
  assert.equal(verifyVersions(root, 'v0.1.0-rc.1').tag, 'rc');
  const after = snapshot(root);
  for (let index = 0; index < 3; index += 1) {
    const expected = JSON.parse(before[index]);
    expected.version = '0.1.0-rc.1';
    if (index === 0) expected.publishConfig.tag = 'rc';
    assert.deepEqual(JSON.parse(after[index]), expected);
  }
  assert.equal(after[3], before[3].replace('0.1.0-beta.1', '0.1.0-rc.1'));
  updateVersion(root, '0.1.0');
  assert.equal(verifyVersions(root).tag, 'latest');
});

test('same-version update is a byte-for-byte no-op', (t) => {
  const root = fixture(t);
  const before = snapshot(root);
  assert.equal(updateVersion(root, '0.1.0-beta.1').changed, false);
  assert.deepEqual(snapshot(root), before);
});

test('uses numeric prerelease ordering and permits the next core version', (t) => {
  const root = fixture(t, '0.1.0-beta.9');
  updateVersion(root, '0.1.0-beta.10');
  updateVersion(root, '0.1.0-rc.0');
  updateVersion(root, '0.1.0');
  updateVersion(root, '0.2.0-alpha.0');
  assert.equal(verifyVersions(root).version, '0.2.0-alpha.0');
});

test('rejects downgrades and invalid input without changing any file', (t) => {
  const root = fixture(t, '1.2.3-rc.10');
  const before = snapshot(root);
  for (const version of ['1.2.2', '1.2.3-beta.99', '1.2.3-rc.9', '1.2.3-rc.01', 'minor']) {
    assert.throws(() => updateVersion(root, version));
    assert.deepEqual(snapshot(root), before);
  }
  updateVersion(root, '1.2.3');
  const stable = snapshot(root);
  assert.throws(() => updateVersion(root, '1.2.3-rc.11'), /downgrade/);
  assert.deepEqual(snapshot(root), stable);
});

test('requires an exact matching Git tag when provided', (t) => {
  const root = fixture(t);
  assert.equal(verifyVersions(root, 'v0.1.0-beta.1').version, '0.1.0-beta.1');
  for (const tag of ['0.1.0-beta.1', 'v0.1.0-beta.2', 'refs/tags/v0.1.0-beta.1', '']) {
    assert.throws(() => verifyVersions(root, tag), /Git tag/);
  }
});

test('rejects unsafe package configuration and version drift before writing', async (t) => {
  const cases = [
    [
      'root name',
      0,
      (pkg) => {
        pkg.name = '@other/package';
      },
    ],
    [
      'private root',
      0,
      (pkg) => {
        pkg.private = true;
      },
    ],
    [
      'restricted access',
      0,
      (pkg) => {
        pkg.publishConfig.access = 'restricted';
      },
    ],
    [
      'other registry',
      0,
      (pkg) => {
        pkg.publishConfig.registry = 'https://example.org/';
      },
    ],
    [
      'wrong channel',
      0,
      (pkg) => {
        pkg.publishConfig.tag = 'latest';
      },
    ],
    [
      'missing publish config',
      0,
      (pkg) => {
        delete pkg.publishConfig;
      },
    ],
    [
      'public SDK',
      1,
      (pkg) => {
        pkg.private = false;
      },
    ],
    [
      'public Replay',
      2,
      (pkg) => {
        delete pkg.private;
      },
    ],
    [
      'SDK version drift',
      1,
      (pkg) => {
        pkg.version = '0.1.0-beta.2';
      },
    ],
    [
      'Replay version drift',
      2,
      (pkg) => {
        pkg.version = '0.1.0-beta.2';
      },
    ],
  ];
  for (const [label, index, mutate] of cases) {
    await t.test(label, (subtest) => {
      const root = fixture(subtest);
      mutateManifest(root, index, mutate);
      const before = snapshot(root);
      assert.throws(() => verifyVersions(root));
      assert.throws(() => updateVersion(root, '0.1.0-beta.2'));
      assert.deepEqual(snapshot(root), before);
    });
  }
});

test('rejects invalid JSON and invalid SDK source before writing', async (t) => {
  const cases = [
    ['invalid JSON', 2, '{'],
    ['SDK version drift', 3, "export const SDK_VERSION = '0.0.0';\n"],
    ['missing SDK version', 3, "export const SDK_NAME = 'sentry.javascript.taro';\n"],
    [
      'duplicate SDK version',
      3,
      "export const SDK_VERSION = '0.1.0-beta.1';\nexport const SDK_VERSION = '0.1.0-beta.1';\n",
    ],
  ];
  for (const [label, index, content] of cases) {
    await t.test(label, (subtest) => {
      const root = fixture(subtest);
      fs.writeFileSync(path.join(root, files[index]), content);
      const before = snapshot(root);
      assert.throws(() => updateVersion(root, '0.1.0-beta.2'));
      assert.deepEqual(snapshot(root), before);
    });
  }
});
