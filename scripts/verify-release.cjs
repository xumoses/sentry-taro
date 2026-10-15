const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { verifyVersions } = require('./release-config.cjs');

const registry = 'https://registry.npmjs.org/';

function verifyBytes(bytes, manifest) {
  assert.equal(bytes.length, manifest.bytes, 'Tarball size does not match release.json');
  assert.equal(
    `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    manifest.integrity,
    'Tarball SHA-512 integrity does not match release.json',
  );
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    manifest.sha256,
    'Tarball SHA-256 does not match release.json',
  );
}

function verifyArtifact(directory, config, expectedCommit, requireClean = false) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'release.json'), 'utf8'));
  for (const field of ['name', 'version', 'tag', 'registry']) {
    assert.equal(
      manifest[field],
      config[field],
      `Release ${field} does not match source configuration`,
    );
  }
  assert.equal(manifest.registry, registry, 'Release registry must be npmjs.org');
  assert.equal(manifest.access, 'public', 'Release access must be public');
  const filename = `${config.name.replace(/^@/, '').replace('/', '-')}-${config.version}.tgz`;
  assert.equal(manifest.filename, filename, 'Unexpected release tarball filename');
  assert.match(expectedCommit, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/, 'Invalid expected source commit');
  assert.equal(
    manifest.sourceCommit,
    expectedCommit,
    'Release source commit does not match checkout',
  );
  assert.equal(
    typeof manifest.hasUncommittedChanges,
    'boolean',
    'Release must record source cleanliness',
  );
  if (requireClean) {
    assert.equal(
      manifest.hasUncommittedChanges,
      false,
      'CI release must come from a clean checkout',
    );
  }

  const tarball = path.resolve(directory, filename);
  assert.ok(
    fs.lstatSync(tarball).isFile(),
    'Release tarball must be a regular file, not a symbolic link',
  );
  verifyBytes(fs.readFileSync(tarball), manifest);
  return { manifest, tarball };
}

async function verifyPublishedArtifact(
  artifact,
  { fetchImpl = fetch, sleepImpl = sleep, attempts = 5 } = {},
) {
  assert.ok(
    Number.isInteger(attempts) && attempts >= 1 && attempts <= 5,
    'Use between 1 and 5 attempts',
  );
  const { manifest } = artifact;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // These requests are anonymous and may never redirect away from the
      // official registry. No npm token or local npm configuration is read.
      const response = await fetchImpl(`${registry}${encodeURIComponent(manifest.name)}`, {
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
      assert.ok(response.ok, `Registry metadata lookup failed: HTTP ${response.status}`);
      const metadata = await response.json();
      const published = metadata.versions?.[manifest.version];
      assert.ok(published, 'Published version is not visible in the registry yet');
      assert.equal(
        published.dist?.integrity,
        manifest.integrity,
        'Published integrity does not match the candidate',
      );
      assert.equal(
        metadata['dist-tags']?.[manifest.tag],
        manifest.version,
        'Published npm tag does not select the expected version',
      );

      const tarballUrl = new URL(published.dist.tarball);
      assert.equal(
        tarballUrl.origin,
        new URL(registry).origin,
        'Published tarball must use the official registry origin',
      );
      assert.ok(
        !tarballUrl.username && !tarballUrl.password,
        'Published tarball URL must not contain credentials',
      );
      const tarballResponse = await fetchImpl(tarballUrl.href, {
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
      assert.ok(
        tarballResponse.ok,
        `Published tarball download failed: HTTP ${tarballResponse.status}`,
      );
      verifyBytes(Buffer.from(await tarballResponse.arrayBuffer()), manifest);
      return;
    } catch (error) {
      if (attempt === attempts) throw error;
      console.warn(
        `Publication verification attempt ${attempt}/${attempts} failed: ${error.message}`,
      );
      await sleepImpl(2_000);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  assert.ok(
    (args.length === 1 || (args.length === 2 && args[1] === '--published')) &&
      !args[0].startsWith('--'),
    'Usage: node scripts/verify-release.cjs <directory> [--published]',
  );
  const root = path.resolve(__dirname, '..');
  if (process.env.GITHUB_ACTIONS === 'true') {
    assert.ok(process.env.RELEASE_TAG, 'CI artifact verification requires a Git tag');
  }
  const config = verifyVersions(root, process.env.RELEASE_TAG);
  const expectedCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const artifact = verifyArtifact(
    path.resolve(args[0]),
    config,
    expectedCommit,
    process.env.GITHUB_ACTIONS === 'true',
  );
  if (args[1] === '--published') await verifyPublishedArtifact(artifact);

  if (process.env.GITHUB_OUTPUT) {
    const relative = path.relative(root, artifact.tarball);
    assert.ok(
      relative &&
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative),
      'GitHub artifact output must be inside the repository',
    );
    const tarball = `./${relative.split(path.sep).join('/')}`;
    assert.ok(
      !/[\r\n]/.test(tarball) && !/[\r\n]/.test(config.tag),
      'GitHub output values must be single lines',
    );
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `tarball=${tarball}\ntag=${config.tag}\n`);
  }
  console.log(
    `Verified ${config.name}@${config.version} (${config.tag}): ${artifact.manifest.integrity}`,
  );
  if (args[1] === '--published') {
    console.log(
      'Publication confirmed: registry version, npm tag, and downloaded tarball match the verified candidate.',
    );
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Release verification failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { verifyArtifact, verifyPublishedArtifact };
