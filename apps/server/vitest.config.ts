import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolve @budget/shared to its TypeScript sources instead of the built dist.
  resolve: { conditions: ['@budget/source'] },
  ssr: { resolve: { conditions: ['@budget/source'] } },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
