import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import dts from 'vite-plugin-dts';

// This internal build is useful when inspecting the imported SDK in isolation.
// The published package is built once from the repository's unified entry point.
export default defineConfig({
  build: {
    target: 'es2015',
    sourcemap: true,
    minify: 'esbuild',
    lib: {
      entry: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
      formats: ['es', 'cjs'],
      fileName: (format) => (format === 'es' ? 'index.mjs' : 'index.cjs'),
    },
    rollupOptions: {
      external: [],
      output: {
        exports: 'named',
        sourcemapPathTransform(sourcePath) {
          const normalized = sourcePath.replace(/\\/g, '/');
          const dependencyStart = normalized.lastIndexOf('/node_modules/');
          return dependencyStart >= 0
            ? `../node_modules/${normalized.slice(dependencyStart + '/node_modules/'.length)}`
            : normalized;
        },
      },
    },
  },
  plugins: [
    dts({
      include: ['src/**/*'],
      exclude: ['src/**/*.test.ts', 'test/**/*'],
      outDir: 'dist/types',
    }),
  ],
  define: { __DEV__: false },
});
