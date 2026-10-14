const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const packedName = `${pkg.name.replace(/^@/, '').replace('/', '-')}-${pkg.version}.tgz`;

function argumentsFor(argv) {
  let tarball;
  let offline = true;
  for (const argument of argv) {
    if (argument === '--online') offline = false;
    else if (argument === '--offline') offline = true;
    else if (!argument.startsWith('-') && !tarball) tarball = path.resolve(argument);
    else throw new Error('Usage: node scripts/verify-consumer.cjs [package.tgz] [--offline|--online]');
  }
  return { tarball: tarball || path.join(root, '.artifacts', packedName), offline };
}

function run(command, args, cwd, label) {
  // A caller's module search path must not make workspace peers visible to the consumer.
  const env = { ...process.env };
  delete env.NODE_PATH;
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: 'inherit',
    timeout: 120_000,
  });
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${label} failed (${result.signal || `exit ${result.status}`})`);
  }
}

function main() {
  const { tarball, offline } = argumentsFor(process.argv.slice(2));
  assert.ok(tarball.endsWith('.tgz') && fs.statSync(tarball).isFile(), 'Expected an existing npm tarball');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-taro-consumer-'));
  try {
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
      name: 'synthetic-sentry-taro-consumer',
      private: true,
      dependencies: { [pkg.name]: `file:${tarball}` },
    }, null, 2));
    fs.writeFileSync(path.join(directory, '.npmrc'),
      'auto-install-peers=false\nignore-scripts=true\nnode-linker=isolated\n');
    fs.writeFileSync(path.join(directory, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        strict: true,
        skipLibCheck: false,
        noEmit: true,
        target: 'ES2020',
        module: 'Node16',
        moduleResolution: 'Node16',
        lib: ['ES2020', 'DOM'],
        types: [],
      },
      files: ['consumer.ts'],
    }, null, 2));
    for (const name of ['consumer.ts', 'consumer.cjs']) {
      fs.copyFileSync(path.join(__dirname, 'fixtures', name), path.join(directory, name));
    }
    const installArgs = [
      'install', '--ignore-scripts', '--ignore-workspace', '--no-frozen-lockfile',
      '--config.auto-install-peers=false', '--registry=https://registry.npmjs.org/',
      '--reporter=append-only', ...(offline ? ['--offline'] : []),
    ];
    const pnpmCli = process.env.npm_execpath;
    if (pnpmCli && /(?:^|[\\/])pnpm\.(?:c?js)$/.test(pnpmCli)) {
      run(process.execPath, [pnpmCli, ...installArgs], directory, 'Tarball installation');
    } else {
      run('pnpm', installArgs, directory, 'Tarball installation');
    }
    for (const peer of ['react', '@types/react', '@tarojs/runtime', '@tarojs/taro']) {
      assert.ok(!fs.existsSync(path.join(directory, 'node_modules', peer)), `Unexpected peer installed: ${peer}`);
    }
    run(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.json'],
      directory, 'Strict consumer declarations');
    run(process.execPath, ['consumer.cjs', pkg.version], directory, 'Consumer runtime');
    console.log('Packed consumer passed: isolated install, strict declarations, no React/Taro peers.');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}

try {
  main();
} catch (error) {
  console.error(`Consumer verification failed: ${error.message}`);
  process.exitCode = 1;
}
