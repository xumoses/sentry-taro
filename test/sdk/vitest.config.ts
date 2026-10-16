import { fileURLToPath } from 'node:url';
import { defineProject } from 'vite-plus/test/config';

export default defineProject({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'sdk',
    environment: 'node',
    include: ['**/*.{spec,test}.ts'],
    setupFiles: ['./setup.ts'],
    testTimeout: 10_000,
    clearMocks: false,
    isolate: true,
    sequence: { hooks: 'list' },
  },
});
