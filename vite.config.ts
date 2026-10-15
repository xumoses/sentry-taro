import { defineConfig } from 'vite-plus';
import { lint } from './config/lint.ts';
import { pack } from './config/pack.ts';

export default defineConfig({
  fmt: {
    singleQuote: true,
    sortPackageJson: false,
    ignorePatterns: [
      '**/dist/**',
      '**/node_modules/**',
      '.artifacts/**',
      'pnpm-lock.yaml',
      'THIRD_PARTY_NOTICES',
    ],
  },
  lint,
  test: {
    projects: ['packages/sdk/vitest.config.ts', 'packages/replay/vitest.config.ts'],
    coverage: {
      provider: 'v8',
      // Vitest 5 resolves these globs from each selected project's root.
      include: ['**/src/**/*.ts'],
      exclude: ['**/*.d.ts', '**/src/index.ts'],
      reportsDirectory: 'packages/sdk/coverage',
      reporter: ['text', 'lcov', 'html'],
    },
  },
  pack,
});
