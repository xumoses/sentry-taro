const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const registry = 'https://registry.npmjs.org/';
const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/;
const sdkVersionPattern = /^(export\s+const\s+SDK_VERSION\s*=\s*)(['"])([^'"\r\n]+)\2(\s*;?\s*)$/gm;
const manifestPaths = ['package.json'];
const sdkVersionPath = 'src/sdk/version.ts';

function parseVersion(version) {
  assert.equal(typeof version, 'string', 'Version must be a string');
  const match = versionPattern.exec(version);
  assert.ok(
    match && match[0] === version,
    `Invalid release version: ${version}. Use X.Y.Z or X.Y.Z-(alpha|beta|rc).N without leading zeroes or build metadata`,
  );
  const numbers = [match[1], match[2], match[3], ...(match[5] === undefined ? [] : [match[5]])];
  assert.ok(
    numbers.every((value) => Number.isSafeInteger(Number(value))),
    'Version numbers must be safe integers',
  );
  return { core: match.slice(1, 4).map(Number), channel: match[4], sequence: Number(match[5]) };
}

function releaseTag(version) {
  return parseVersion(version).channel || 'latest';
}

function readReleaseState(root) {
  const manifests = manifestPaths.map((relativePath) => {
    const filename = path.join(root, relativePath);
    const text = fs.readFileSync(filename, 'utf8');
    return { filename, text, value: JSON.parse(text) };
  });
  const sdkFilename = path.join(root, sdkVersionPath);
  const sdkText = fs.readFileSync(sdkFilename, 'utf8');
  const sdkVersions = [...sdkText.matchAll(sdkVersionPattern)];
  assert.equal(sdkVersions.length, 1, 'Expected exactly one exported SDK_VERSION string');

  const [pkg] = manifests.map((manifest) => manifest.value);
  const tag = releaseTag(pkg.version);
  assert.equal(pkg.name, '@xumoses/sentry-taro', 'Unexpected root package name');
  assert.ok(
    pkg.private === undefined || pkg.private === false,
    'The root package must be publishable',
  );
  assert.equal(pkg.publishConfig?.access, 'public', 'Root publishConfig.access must be public');
  assert.equal(
    pkg.publishConfig?.registry,
    registry,
    'Root publishConfig.registry must be npmjs.org',
  );
  assert.equal(
    pkg.publishConfig?.tag,
    tag,
    'Root publishConfig.tag must match the release channel',
  );
  assert.equal(sdkVersions[0][3], pkg.version, 'SDK_VERSION must match the root package');

  return {
    config: { name: pkg.name, version: pkg.version, tag, registry },
    manifests,
    sdkFilename,
    sdkText,
  };
}

function verifyVersions(root, gitTag) {
  const { config } = readReleaseState(root);
  if (gitTag !== undefined) {
    assert.equal(gitTag, `v${config.version}`, 'Git tag must exactly match v<package version>');
  }
  return config;
}

module.exports = { releaseTag, verifyVersions, parseVersion, readReleaseState, sdkVersionPattern };
