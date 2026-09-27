import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    globals: true,
    env: {
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_dummy',
      CLERK_SECRET_KEY: 'sk_test_dummy',
      INSTAGRAM_APP_ID: 'dummy',
      INSTAGRAM_APP_SECRET: 'dummy',
      INSTAGRAM_REDIRECT_URI: 'https://dummy.com/auth/instagram',
      INSTAGRAM_TOKEN_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      YOUTUBE_CLIENT_ID: 'dummy',
      YOUTUBE_CLIENT_SECRET: 'dummy',
      YOUTUBE_REDIRECT_URI: 'https://dummy.com/auth/youtube',
      YOUTUBE_TOKEN_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
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