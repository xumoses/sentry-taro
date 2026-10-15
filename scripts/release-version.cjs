const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  releaseTag,
  parseVersion,
  readReleaseState,
  sdkVersionPattern,
} = require('./release-config.cjs');

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < a.core.length; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1;
  }
  if (a.channel === undefined && b.channel !== undefined) return 1;
  if (a.channel !== undefined && b.channel === undefined) return -1;
  if (a.channel !== b.channel) return a.channel > b.channel ? 1 : -1;
  if (a.channel === undefined || a.sequence === b.sequence) return 0;
  return a.sequence > b.sequence ? 1 : -1;
}

function updateVersion(root, version) {
  const tag = releaseTag(version);
  const { config, manifests, sdkFilename, sdkText } = readReleaseState(root);
  assert.ok(
    compareVersions(version, config.version) >= 0,
    `Version downgrade is not allowed: ${config.version} -> ${version}`,
  );

  // Read and validate every input before writing any file. Re-running the same
  // version is a no-op; existing version drift must be resolved explicitly.
  if (version === config.version) return { ...config, changed: false };
  const updates = manifests.map(({ filename, value }, index) => {
    value.version = version;
    if (index === 0) value.publishConfig.tag = tag;
    return { filename, text: `${JSON.stringify(value, null, 2)}\n` };
  });
  updates.push({
    filename: sdkFilename,
    text: sdkText.replace(sdkVersionPattern, (_match, prefix, quote, _oldVersion, suffix) => {
      return `${prefix}${quote}${version}${quote}${suffix}`;
    }),
  });
  for (const { filename, text } of updates) fs.writeFileSync(filename, text);
  return { ...config, version, tag, changed: true };
}

if (require.main === module) {
  try {
    assert.equal(process.argv.length, 3, 'Usage: node scripts/release-version.cjs <exact-version>');
    const result = updateVersion(path.resolve(__dirname, '..'), process.argv[2]);
    console.log(
      `${result.changed ? 'Updated' : 'Already at'} ${result.name}@${result.version} (npm tag: ${result.tag})`,
    );
    console.log('No commit, Git tag, push, or publication was performed.');
  } catch (error) {
    console.error(`Version update failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { updateVersion };
