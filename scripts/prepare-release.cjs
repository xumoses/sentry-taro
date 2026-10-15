const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { verifyVersions } = require('./release-config.cjs');

const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const registry = 'https://registry.npmjs.org/';

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args[0]} failed`);
  return capture ? result.stdout.trim() : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  assert.ok(
    args.length === 0 || (args.length === 1 && args[0] === '--offline'),
    'Usage: vp run release:prepare [--offline]',
  );
  const offline = args[0] === '--offline';
  const node = fs.readFileSync(path.join(root, '.node-version'), 'utf8').trim();
  const pnpm = run('pnpm', ['--version'], true);
  assert.equal(process.versions.node, node, 'Select the project Node.js version first');
  assert.equal(`pnpm@${pnpm}`, pkg.packageManager, 'Select the project pnpm version first');
  const { tag } = verifyVersions(root, process.env.RELEASE_TAG);
  if (process.env.GITHUB_ACTIONS === 'true') {
    assert.ok(process.env.RELEASE_TAG, 'CI release preparation requires a Git tag');
    assert.equal(run('git', ['status', '--porcelain'], true), '', 'CI source must be clean');
  }

  let registryCheck = 'not checked (offline)';
  if (!offline) {
    const response = await fetch(`${registry}${encodeURIComponent(pkg.name)}`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 404) registryCheck = 'package does not exist';
    else {
      assert.ok(response.ok, `Registry lookup failed: HTTP ${response.status}`);
      const metadata = await response.json();
      assert.ok(!metadata.versions?.[pkg.version], 'This version is already published');
      registryCheck = 'version does not exist';
    }
  }

  run('vp', ['check']);
  run('vp', ['run', 'typecheck']);
  run('vp', ['test', 'run']);
  run('vp', ['run', 'test:release']);

  // A new directory preserves earlier candidates and their acceptance evidence.
  const releases = path.join(root, '.artifacts', 'releases');
  fs.mkdirSync(releases, { recursive: true });
  const directory = fs.mkdtempSync(path.join(releases, `${pkg.version}-`));
  run('vp', ['pm', 'pack', '--pack-destination', directory]);
  const filename = `${pkg.name.replace(/^@/, '').replace('/', '-')}-${pkg.version}.tgz`;
  const tarball = path.join(directory, filename);
  run('vp', ['run', 'verify:bundles']);
  run(process.execPath, [
    path.join(__dirname, 'verify-consumer.cjs'),
    tarball,
    offline ? '--offline' : '--online',
  ]);

  // Only dry-run exists here. Actual publication is a separate, approved action.
  const dryRunReport = JSON.parse(
    run(
      'npm',
      [
        'publish',
        tarball,
        '--dry-run',
        '--ignore-scripts',
        `--tag=${tag}`,
        '--access=public',
        `--registry=${registry}`,
        `--cache=${path.join(root, '.artifacts', 'npm-cache')}`,
        '--fetch-retries=0',
        '--fetch-timeout=20000',
        '--json',
        ...(offline ? ['--offline'] : []),
      ],
      true,
    ),
  );
  // npm 11 keys publish JSON by package name; older versions return the entry.
  const dryRun = dryRunReport[pkg.name] || dryRunReport;
  assert.equal(dryRun.name, pkg.name);
  assert.equal(dryRun.version, pkg.version);
  for (const file of dryRun.files) {
    assert.match(
      file.path,
      /^(?:dist\/|package\.json$|README(?:\.en)?\.md$|LICENSE$|THIRD_PARTY_NOTICES$)/,
      `Unexpected published file: ${file.path}`,
    );
  }
  const bytes = fs.readFileSync(tarball);
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  assert.equal(dryRun.integrity, integrity, 'Dry-run must inspect the exact tarball');
  const manifest = {
    name: pkg.name,
    version: pkg.version,
    tag,
    access: 'public',
    registry,
    filename,
    bytes: bytes.length,
    integrity,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sourceCommit: run('git', ['rev-parse', 'HEAD'], true),
    hasUncommittedChanges: Boolean(run('git', ['status', '--porcelain'], true)),
    tools: { node, pnpm, npm: run('npm', ['--version'], true) },
    preparedAt: new Date().toISOString(),
    registryCheck,
    checks: [
      'versions',
      'check',
      'typecheck',
      'test',
      'test:release',
      'prepack',
      'bundles',
      'consumer',
      'publish-dry-run',
    ],
    files: dryRun.files,
    published: false,
  };
  fs.writeFileSync(path.join(directory, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `directory=${path.relative(root, directory)}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [
        `Prepared **${pkg.name}@${pkg.version}** for npm **${tag}**.`,
        `Source: \`${manifest.sourceCommit}\`. Tarball: ${manifest.bytes} bytes.`,
        `SHA-512: \`${integrity}\`.`,
        'Review the uploaded tarball and release.json before approving the npm environment.',
        'If NPM_OIDC_PUBLISH_ENABLED is not true, the publish job is skipped.',
        '',
      ].join('\n\n'),
    );
  }
  console.log(`Prepared ${pkg.name}@${pkg.version}: ${path.relative(root, tarball)}`);
  console.log(`Integrity: ${integrity}`);
  console.log('Stopped before publication. Dry-run does not prove publish permission or 2FA.');
}

main().catch((error) => {
  console.error(`Release preparation failed: ${error.message}`);
  process.exitCode = 1;
});
