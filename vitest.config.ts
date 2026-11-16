import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Each test spawns nnc and talks SSH; give them room.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
