import { defineConfig } from 'drizzle-kit';

// Only used to generate SQL migrations from src/db/schema.ts (`pnpm db:generate`).
// The server applies the generated files itself at startup.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
});
