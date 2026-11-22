/**
 * Throwaway M0 spikes (docs/fork/spikes/RESULTS.md, T1–T7). They run against a real PostgreSQL the
 * way `npm run test:db` does, so they need E2E_DATABASE_URL pointing at a database whose name says
 * test or e2e, with every migration applied:
 *
 *   E2E_DATABASE_URL=postgresql://... npx vitest run --config scripts/spikes/vitest.spikes.config.ts
 *
 * Each spike makes a workshop of its own and removes it again.
 */
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(__dirname, '../..')

export default defineConfig({
  root,
  test: {
    environment: 'node',
    globals: true,
    include: ['scripts/spikes/**/*.spike.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
  resolve: {
    alias: {
      '@': resolve(root, './src'),
      'server-only': resolve(root, './src/__tests__/stubs/server-only.ts'),
    },
  },
})
