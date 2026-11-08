import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    // blargg 综合版 ROM（10 个子测试 + 复位推进）与 cpu_timing_test 需要数分钟
    testTimeout: 300_000,
    hookTimeout: 30_000,
    // 串行跑文件：perf 基准与 blargg 的帧预算都依赖独占 CPU。
    // 并行时会互相抢占（实测 perf 从 8ms 漂到 39ms），破坏确定性。
    fileParallelism: false,
  },
});