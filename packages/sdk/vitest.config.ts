import { fileURLToPath } from 'node:url';
import { defineProject } from 'vite-plus/test/config';

export default defineProject({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    name: 'sdk',
    environment: 'node',
    include: ['src/**/__tests__/**/*.ts', 'src/**/*.{spec,test}.ts', 'test/**/*.{spec,test}.ts'],
    setupFiles: ['./test/setup.ts'],
    testTimeout: 10_000,
    clearMocks: false,
    isolate: true,
    sequence: { hooks: 'list' },
  },
});
