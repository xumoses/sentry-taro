import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const root = import.meta.dirname;
const portableSource = (source) => {
  const normalized = source.replace(/\\/g, '/');
  const start = normalized.lastIndexOf('/node_modules/');
  return start < 0 ? normalized : `../node_modules/${normalized.slice(start + 14)}`;
};

export default defineConfig(({ mode }) => {
  const umd = mode === 'umd';
  const notices = readFileSync(resolve(root, 'THIRD_PARTY_NOTICES'), 'utf8');
  return {
    // Keep Vite 6's UMD helper replacement away from minified `$&&` identifiers.
    ...(umd ? { esbuild: { minifyIdentifiers: false } } : {}),
    define: { __DEV__: false },
    build: {
      target: 'es2015',
      minify: 'esbuild',
      sourcemap: true,
      outDir: 'dist',
      emptyOutDir: !umd,
      lib: { entry: resolve(root, 'src/index.ts'), name: 'SentryTaro' },
      rollupOptions: {
        // The root contains the single SDK/core/coordinator graph. Framework
        // runtime imports belong only to the separate React/Taro entrypoints.
        external: [],
        output: (umd
          ? [{ format: 'umd', entryFileNames: 'sentry-taro.umd.js', name: 'SentryTaro' }]
          : [{ format: 'es', entryFileNames: 'index.mjs' }, { format: 'cjs', entryFileNames: 'index.cjs.js' }]
        ).map((output) => ({
          ...output,
          exports: 'named',
          banner: `/*!\n${notices}\n*/`,
          sourcemapPathTransform: portableSource,
        })),
      },
    },
  };
});
