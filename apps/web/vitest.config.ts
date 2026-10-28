import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    globals: true,
    globalSetup: ['./vitest.global-setup.ts'],
    env: {
      // Always point the app's prisma client at the test database, whatever the shell has set.
      ...(process.env.TEST_DATABASE_URL ? { DATABASE_URL: process.env.TEST_DATABASE_URL } : {}),
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_dummy',
      CLERK_SECRET_KEY: 'sk_test_dummy',
      INSTAGRAM_APP_ID: 'dummy',
      INSTAGRAM_APP_SECRET: 'dummy',
      INSTAGRAM_REDIRECT_URI: 'https://dummy.com/auth/instagram',
      INSTAGRAM_TOKEN_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      YOUTUBE_CLIENT_ID: 'dummy',
      YOUTUBE_CLIENT_SECRET: 'dummy',
      YOUTUBE_REDIRECT_URI: 'https://dummy.com/auth/youtube',
      // Distinct from the Instagram key on purpose: the app refuses to run with both platforms on one key.
      YOUTUBE_TOKEN_ENCRYPTION_KEY: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
    },
    // Allow testing internal (non-exported) functions if needed
    // passWithNoTests: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});