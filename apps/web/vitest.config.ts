import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['@budget/source'] },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
