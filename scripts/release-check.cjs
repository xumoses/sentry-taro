const assert = require('node:assert/strict');
const path = require('node:path');
const { verifyVersions } = require('./release-config.cjs');

try {
  assert.equal(process.argv.length, 2, 'Usage: vp run release:check');
  const config = verifyVersions(path.resolve(__dirname, '..'), process.env.RELEASE_TAG);
  console.log(`Verified ${config.name}@${config.version} (npm tag: ${config.tag})`);
} catch (error) {
  console.error(`Release version check failed: ${error.message}`);
  process.exitCode = 1;
}
