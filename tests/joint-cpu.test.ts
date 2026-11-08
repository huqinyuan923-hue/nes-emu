/**
 * M5 前置：真 CPU（第一部产出）× 本部总线 × 假 PPU 的联合冒烟测试。
 *
 * 用 nestest 官方 golden trace（qmtpro.com 标准逐指令日志）逐指令对拍：
 * 验证「CPU 读指/数据经我的总线」语义正确——reset 向量、PRG 映射、RAM 镜像、
 * PPU 寄存器折叠写入、周期累计（契约 totalCycles 含 reset 的 7 周期，
 * 与日志 CYCLE 列同基准）。
 *
 * 说明：nestest 的 CPU 测试段不依赖 PPU 结果，假 PPU（寄存器读恒 0）即可。
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NESMachine } from '../src/board/machine';
import { createCPU6502 } from '../src/cpu/createCPU';
import { FakePPU } from './helpers/stubs';
import { loadRomBytes } from './blargg-harness';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = join(HERE, 'roms', 'nestest.log');

interface TraceLine {
  pc: number;
  a: number;
  x: number;
  y: number;
  p: number;
  sp: number;
  cycle: number;
}

/** 解析 nestest.log 一行（分词式） */
function parseTraceLine(line: string): TraceLine | null {
  // 示例：C000  4C F5 C5  JMP $C5F5    A:00 X:00 Y:00 P:24 SP:FD PPU:  0, 21 CYCLE:7
  const parts = line.trim().split(/\s+/);
  if (parts.length < 8) return null;
  const pcPart = parts[0];
  if (!pcPart || pcPart.length !== 4) return null;

  const get = (prefix: string, radix = 16): number => {
    const found = parts.find((s) => s.startsWith(prefix + ':'));
    if (!found) return -1;
    const value = parseInt(found.slice(prefix.length + 1), radix);
    return Number.isNaN(value) ? -1 : value;
  };

  const pc = parseInt(pcPart, 16);
  const a = get('A');
  const sp = get('SP');
  const cycle = get('CYC', 10); // CYC 列为十进制
  if (Number.isNaN(pc) || a < 0 || sp < 0 || cycle < 0) return null;
  return { pc, a, x: get('X'), y: get('Y'), p: get('P'), sp, cycle };
}

function loadTrace(): TraceLine[] {
  const text = readFileSync(LOG_PATH, 'utf8');
  const lines: TraceLine[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const parsed = parseTraceLine(line);
    if (parsed) lines.push(parsed);
  }
  return lines;
}

describe('M5 前置 · nestest golden trace × 本部总线（真 CPU + 假 PPU）', () => {
  const cpuAvailable = existsSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cpu', 'createCPU.ts'),
  );
  const logAvailable = existsSync(LOG_PATH);
  const conditionalIt = cpuAvailable && logAvailable ? it : it.skip;

  conditionalIt('逐指令对拍 CPU 状态与周期（golden log 全量）', () => {
    // nestest 复位向量指向图形模式入口 $C004，golden log 从自动化入口 $C000 起拍。
    // 标准做法：测试侧总线代理把复位向量改挂到 $C000。
    const machine = new NESMachine({
      createCpu: (bus) =>
        createCPU6502({
          read: (addr) => {
            if (addr === 0xfffc) return 0x00;
            if (addr === 0xfffd) return 0xc0;
            return bus.read(addr);
          },
          write: (addr, value) => bus.write(addr, value),
        }),
      createPpu: (nmi) => new FakePPU(nmi),
    });
    machine.loadRom(loadRomBytes('nestest.nes'));

    const trace = loadTrace();
    expect(trace.length, 'golden log 应解析出足够行数').toBeGreaterThan(5000);

    for (let i = 0; i < trace.length; i++) {
      const expected = trace[i]!;
      const state = machine.getCpuState();
      const ok =
        state.pc === expected.pc &&
        state.a === expected.a &&
        state.x === expected.x &&
        state.y === expected.y &&
        state.p === expected.p &&
        state.sp === expected.sp &&
        state.totalCycles === expected.cycle;
      if (!ok) {
        // 失败信息带上下文，定位第一条分歧指令
        expect(
          false,
          `第 ${i + 1} 行分歧：期望 PC=${expected.pc.toString(16).padStart(4, '0')} ` +
            `A=${expected.a.toString(16)} P=${expected.p.toString(16)} CYCLE=${expected.cycle}；` +
            `实际 PC=${state.pc.toString(16).padStart(4, '0')} A=${state.a.toString(16)} ` +
            `P=${state.p.toString(16)} CYCLE=${state.totalCycles}`,
        ).toBe(true);
      }
      machine.stepInstruction();
    }
  });
});
