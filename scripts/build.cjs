const { spawnSync } = require('node:child_process');
const { cpSync, readdirSync, readFileSync, writeFileSync } = require('node:fs');
const { resolve, join, dirname, relative } = require('node:path');

const root = resolve(__dirname, '..');
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

// Only the main pass clears root/dist. Other passes write to isolated output
// directories, then copy their assets without deleting existing entrypoints.
run('vp', ['run', 'build:main']);
run(process.execPath, [join(root, 'scripts/build-worker.cjs')]);
for (const [replayDist, destination] of [
  [join(root, '.build/adapters'), join(root, 'dist')],
  [join(root, '.build/worker'), join(root, 'dist/worker')],
  [join(root, '.build/taro-plugin'), join(root, 'dist/taro-plugin')],
]) {
  for (const name of readdirSync(replayDist)) {
    if (name.endsWith('.d.ts')) continue;
    cpSync(join(replayDist, name), join(destination, name), { recursive: true });
    if (name.endsWith('.map')) {
      const source = join(replayDist, name);
      const target = join(destination, name);
      const map = JSON.parse(readFileSync(source, 'utf8'));
      // Moving a map changes the base for its relative sources. Keep the map
      // tied to the same public source files after assembling the final package.
      map.sources = map.sources.map((entry) =>
        entry.startsWith('../node_modules/')
          ? relative(
              dirname(target),
              join(root, 'node_modules', entry.slice('../node_modules/'.length)),
            ).replace(/\\/g, '/')
          : relative(dirname(target), resolve(dirname(source), entry)).replace(/\\/g, '/'),
      );
      writeFileSync(target, JSON.stringify(map));
    }
  }
}
cpSync(
  join(root, 'src/taro-plugin/THIRD_PARTY_NOTICES'),
  join(root, 'dist/taro-plugin/THIRD_PARTY_NOTICES'),
);
cpSync(join(root, 'devtools'), join(root, 'dist/devtools'), { recursive: true });
run('vp', ['run', 'build:types']);
