/**
 * 性能基准（独立 bench 套件——**不在 `npm test` 里做 gate**）。
 *
 * 为什么移出 gate（收尾任务书 §二.1 / H3）：perf 的墙钟数值受外部负载影响，
 * 在主会话的外部负载复跑中曾翻车（8/124）。正确性测试必须与机器负载无关，
 * 性能观测应单独测量。60fps 的真实验收是浏览器实测（croom 59.5fps /
 * 240pee 60fps，见 REPORT §6）。
 *
 * 本 bench 仍然保留一个**宽松上限**（100ms）用于捕捉灾难性退化（如每像素
 * 分配导致的 GC 风暴：修复轮 1 前实测 33ms 尖峰、并发下 39ms）。
 * 正常值应在 7-9ms（中位批均）。
 *
 * 运行：npm run bench
 */
import { describe, expect, it } from 'vitest';
import { NESMachine } from '../src/board/machine';
import { getMachineFactories } from '../src/board/integration';
import { loadRomBytes } from '../tests/blargg-harness';

function benchFrame(machine: NESMachine): number {
  const t0 = performance.now();
  machine.stepFrame();
  // 把 framebuffer 摸一遍，模拟上屏前的拷贝成本
  const fb = machine.getFramebuffer();
  let acc = 0;
  for (let i = 0; i < fb.length; i += 64) acc += fb[i]!;
  return performance.now() - t0 + (acc === -1 ? 1 : 0);
}

describe('性能基准（bench，不 gate 正确性）', () => {
  it('单帧执行（含 PPU 渲染 + framebuffer）：记录数值 + 宽松上限 100ms', () => {
    const machine = new NESMachine(getMachineFactories());
    machine.loadRom(loadRomBytes('nestest.nes'));

    // 预热 120 帧（JIT 完全升级 + GC 相对平稳）
    for (let i = 0; i < 120; i++) machine.stepFrame();

    const samples: number[] = [];
    const batchAvgs: number[] = [];
    for (let batch = 0; batch < 3; batch++) {
      let batchSum = 0;
      for (let i = 0; i < 100; i++) {
        const ms = benchFrame(machine);
        batchSum += ms;
        samples.push(ms);
      }
      batchAvgs.push(batchSum / 100);
    }
    samples.sort((a, b) => a - b);
    const medianBatch = [...batchAvgs].sort((a, b) => a - b)[1]!;
    const avg = samples.reduce((s, v) => s + v, 0) / samples.length;
    const p50 = samples[Math.floor(samples.length * 0.5)]!;
    const p99 = samples[Math.floor(samples.length * 0.99)]!;
    const max = samples[samples.length - 1]!;

    console.log(
      `[bench] 单帧 ms —— 批均值 ${batchAvgs.map((v) => v.toFixed(2)).join('/')} | ` +
        `中位批均 ${medianBatch.toFixed(3)} | 全量 avg ${avg.toFixed(3)} | ` +
        `p50 ${p50.toFixed(3)} | p99 ${p99.toFixed(3)} | max ${max.toFixed(3)} | ` +
        `60fps 预算 16.6，目标线 8`,
    );
    // 只捕捉灾难性退化；正常值 7-9ms。正确性 gate 不在此。
    expect(medianBatch, `灾难性退化：批均值中位数 ${medianBatch.toFixed(2)}ms > 100ms`).toBeLessThan(100);
  });
});