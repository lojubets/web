import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/**/*.test.ts', 'src/**/*.test.ts'],
    env: { DATABASE_URL: ':memory:', NODE_ENV: 'test', SESSION_SECRET: 'test-secret' },
  },
});
