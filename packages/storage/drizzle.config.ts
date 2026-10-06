import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  // The canonical tables plus the retention tables (M14.6) — one migration set, both sources.
  schema: ['./src/schema/tables.ts', './src/retention/tables.ts'],
  out: './migrations',
});
