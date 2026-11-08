import { defineConfig } from 'vitest/config';

/**
 * 独立 bench 配置：只用 `bench/**\/*.bench.ts`。
 * 与 `npm test`（tests/**\/*.test.ts）完全隔离——性能数值不做正确性 gate
 * （收尾任务书 §二.1 / H3）。
 */
export default defineConfig({
  test: {
    globals: true,
    include: ['bench/**/*.bench.ts'],
    testTimeout: 120_000,
    fileParallelism: false,
  },
});