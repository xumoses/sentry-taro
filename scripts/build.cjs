const { spawnSync } = require('node:child_process');
const { cpSync, readdirSync, readFileSync, writeFileSync } = require('node:fs');
const { resolve, join, dirname, relative } = require('node:path');

const root = resolve(__dirname, '..');
function run(args) {
  const result = spawnSync('pnpm', args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

// Only the main pass clears root/dist. Other passes write to isolated output
// directories, then copy their assets without deleting existing entrypoints.
run(['run', 'build:main']);
run(['--filter', '@sentry-taro/internal-replay', 'build']);
const replayDist = join(root, 'packages/replay/dist');
for (const name of readdirSync(replayDist)) {
  if (name.endsWith('.d.ts') || name === 'index.cjs.js' || name === 'index.mjs') continue;
  cpSync(join(replayDist, name), join(root, 'dist', name), { recursive: true });
  if (name.endsWith('.map')) {
    const source = join(replayDist, name);
    const target = join(root, 'dist', name);
    const map = JSON.parse(readFileSync(source, 'utf8'));
    // Moving a map changes the base for its relative sources. Keep the map
    // tied to the same public source files after assembling the final package.
    map.sources = map.sources.map((entry) =>
      relative(dirname(target), resolve(dirname(source), entry)).replace(/\\/g, '/'),
    );
    writeFileSync(target, JSON.stringify(map));
  }
}
cpSync(join(root, 'packages/replay/devtools'), join(root, 'dist/devtools'), { recursive: true });
run(['run', 'build:types']);
