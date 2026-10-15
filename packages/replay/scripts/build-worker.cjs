const { dirname, resolve } = require('node:path');
const { copyFileSync, readFileSync, writeFileSync } = require('node:fs');

const replayRoot = resolve(__dirname, '..');

async function main() {
  const { build } = await import('vite-plus/pack');
  await build({
    config: false,
    name: 'compression-worker',
    entry: resolve(replayRoot, 'src/worker/replay-compression.ts'),
    target: 'es2015',
    platform: 'browser',
    format: 'iife',
    outDir: resolve(replayRoot, 'dist/worker'),
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
  const licensePath = resolve(
    dirname(require.resolve('fflate', { paths: [replayRoot] })),
    '../LICENSE',
  );
  const license = readFileSync(licensePath, 'utf8');
  const output = resolve(replayRoot, 'dist/worker/replay-compression.js');
  writeFileSync(
    output,
    `/*! Bundled fflate license:\n${license}\n*/\n${readFileSync(output, 'utf8')}`,
  );
  copyFileSync(licensePath, resolve(replayRoot, 'dist/worker/fflate.LICENSE'));
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
