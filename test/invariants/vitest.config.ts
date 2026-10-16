import { fileURLToPath } from 'node:url';
import { defineProject } from 'vite-plus/test/config';

export default defineProject({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'invariants',
    environment: 'node',
    include: ['**/*.test.ts'],
  },
});
