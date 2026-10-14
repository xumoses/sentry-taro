const { resolve } = require('node:path');
const { copyFileSync, readFileSync, writeFileSync } = require('node:fs');

async function main() {
  const { build } = await import('vite');
  await build({
    configFile: false,
    build: {
      target: 'es2015',
      outDir: 'dist/worker',
      emptyOutDir: true,
      sourcemap: false,
      lib: {
        entry: resolve('src/worker/replay-compression.ts'),
        formats: ['iife'],
        name: 'ReplayCompressionWorker',
        fileName: () => 'replay-compression.js',
      },
    },
  });
  const license = readFileSync(resolve('node_modules/fflate/LICENSE'), 'utf8');
  const output = resolve('dist/worker/replay-compression.js');
  writeFileSync(
    output,
    `/*! Bundled fflate license:\n${license}\n*/\n${readFileSync(output, 'utf8')}`,
  );
  copyFileSync(resolve('node_modules/fflate/LICENSE'), resolve('dist/worker/fflate.LICENSE'));
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
