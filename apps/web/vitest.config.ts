import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['@budget/source'] },
  define: { __APP_BUILD__: JSON.stringify('test') },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
