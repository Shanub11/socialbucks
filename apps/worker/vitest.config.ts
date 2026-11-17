import { defineConfig } from 'vitest/config';
import path from 'path';

// Mirrors apps/web/vitest.config.ts: node environment, the shared database
// safety guard, serial files (one database, shared TRUNCATE/schemas) and
// DATABASE_URL always pointed at TEST_DATABASE_URL so a stray shell variable
// can never send a test run at a real database.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: true,
    globalSetup: ['./vitest.global-setup.ts'],
    fileParallelism: false, // shared database + schema-level fixtures cannot run in parallel
    env: {
      // Always point the shared Prisma client at the test database, whatever the shell has set.
      ...(process.env.TEST_DATABASE_URL ? { DATABASE_URL: process.env.TEST_DATABASE_URL } : {}),
    },
  },
  resolve: {
    alias: {
      // The worker imports the settlement code from apps/web/src (ADR-0005 D4),
      // so tests resolve '@/' exactly the way the worker does.
      '@': path.resolve(__dirname, '../web/src'),
    },
  },
});
