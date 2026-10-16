import { fileURLToPath } from 'node:url';
import { defineProject } from 'vite-plus/test/config';

export default defineProject({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'replay',
    clearMocks: true,
    environment: 'node',
    fileParallelism: false,
    include: ['**/*.test.ts'],
  },
});
