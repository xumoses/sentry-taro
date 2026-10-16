const { dirname, resolve } = require('node:path');
const { copyFileSync, readFileSync, writeFileSync } = require('node:fs');

const root = resolve(__dirname, '..');

async function main() {
  const { build } = await import('vite-plus/pack');
  await build({
    config: false,
    name: 'compression-worker',
    entry: resolve(root, 'src/replay/worker/replay-compression.ts'),
    target: 'es2015',
    platform: 'browser',
    format: 'iife',
    outDir: resolve(root, '.build/worker'),
    clean: true,
    dts: false,
    sourcemap: false,
    minify: true,
    deps: { alwaysBundle: ['fflate'], onlyBundle: ['fflate'] },
    outputOptions: {
      entryFileNames: 'replay-compression.js',
      name: 'ReplayCompressionWorker',
      comments: { legal: true },
    },
  });
  const licensePath = resolve(dirname(require.resolve('fflate', { paths: [root] })), '../LICENSE');
  const license = readFileSync(licensePath, 'utf8');
  const output = resolve(root, '.build/worker/replay-compression.js');
  writeFileSync(
    output,
    `/*! Bundled fflate license:\n${license}\n*/\n${readFileSync(output, 'utf8')}`,
  );
  copyFileSync(licensePath, resolve(root, '.build/worker/fflate.LICENSE'));
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
