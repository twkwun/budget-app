import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolve @budget/shared to its TypeScript sources instead of the built dist
  // (CI runs the tests before anything is built).
  resolve: { conditions: ['@budget/source'] },
  ssr: { resolve: { conditions: ['@budget/source'] } },
  define: { __APP_BUILD__: JSON.stringify('test') },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
