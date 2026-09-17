import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/ai/**/*.test.ts'], testTimeout: 15000, hookTimeout: 15000, maxWorkers: 1, fileParallelism: false } });
