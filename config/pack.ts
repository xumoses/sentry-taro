import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PackUserConfig } from 'vite-plus/pack';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const notices = readFileSync(resolve(root, 'THIRD_PARTY_NOTICES'), 'utf8');

function portableSource(source: string): string {
  const normalized = source.replace(/\\/g, '/');
  const dependencyStart = normalized.lastIndexOf('/node_modules/');
  return dependencyStart < 0
    ? normalized
    : `../node_modules/${normalized.slice(dependencyStart + '/node_modules/'.length)}`;
}

const modules: PackUserConfig = {
  // The development Node version is independent of the mini-program syntax floor.
  target: 'es2015',
  platform: 'browser',
  format: ['esm', 'cjs'],
  dts: false,
  clean: true,
  sourcemap: true,
  minify: true,
  define: { __DEV__: 'false' },
  // tsdown selects Node dependency conditions for CJS. The explicit browser
  // subpath prevents fflate's Node worker/createRequire code from entering it.
  alias: { fflate: 'fflate/browser' },
  // Keep the historical names understood by native mini-program npm tooling.
  outExtensions: ({ format }) => ({ js: format === 'es' ? '.mjs' : '.cjs.js' }),
  outputOptions: {
    exports: 'named',
    comments: { legal: true },
    sourcemapPathTransform: portableSource,
  },
};

const main: PackUserConfig = {
  ...modules,
  entry: { index: resolve(root, 'src/index.ts') },
  outDir: resolve(root, 'dist'),
  outputOptions: {
    ...modules.outputOptions,
    banner: `/*!\n${notices}\n*/`,
    codeSplitting: false,
  },
};

export const pack: PackUserConfig[] = [
  {
    ...main,
    name: 'sdk-esm',
    format: ['esm'],
    deps: {
      alwaysBundle: ['@sentry/core'],
      onlyBundle: ['@sentry/core', '@sentry/conventions'],
      onlyImport: ['fflate'],
    },
    plugins: [
      {
        name: 'fflate-browser-boundary',
        resolveId: {
          order: 'pre',
          handler(id) {
            if (id === 'fflate' || id === 'fflate/browser') {
              // Preserve fflate's own sideEffects metadata in ESM consumers;
              // flattening its initialization tables makes them unshakable.
              return { id: 'fflate/browser', external: true };
            }
          },
        },
      },
    ],
  },
  {
    ...main,
    name: 'sdk-cjs',
    format: ['cjs'],
    // The native entry must load without resolving another runtime module.
    deps: {
      alwaysBundle: ['@sentry/core', 'fflate'],
      onlyBundle: ['@sentry/core', '@sentry/conventions', 'fflate'],
    },
  },
  {
    ...modules,
    name: 'adapters',
    entry: {
      react: resolve(root, 'packages/replay/src/react/index.ts'),
      'react-root': resolve(root, 'packages/replay/src/react/root.ts'),
      'taro-lifecycle': resolve(root, 'packages/replay/src/taro/lifecycle.ts'),
    },
    // Isolate cleaning from the main build; build.cjs assembles the public dist.
    outDir: resolve(root, 'packages/replay/dist'),
    deps: { neverBundle: ['@sentry/core', '@tarojs/runtime', '@tarojs/taro', 'react'] },
  },
];
