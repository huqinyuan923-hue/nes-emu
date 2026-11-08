/**
 * M4 前置：NTSC 主循环与整机装配测试（假 CPU / 假 PPU 驱动）。
 * 验证：帧周期 29781/29780 交替、PPU 3 dots/CPU cycle 同步、NMI 回调接线、
 * 指令级单步、扫描行/dot 推导、SRAM 存取。
 */
import { describe, expect, it } from 'vitest';
import { NESMachine } from '../src/board/machine';
import { NTSC_FPS, cyclesForFrame } from '../src/board/timing';
import { buildINes } from './helpers/rom-builder';
import { FakeCPU, FakePPU } from './helpers/stubs';
import { DOTS_PER_SCANLINE } from '../src/contract';

function makeMachine() {
  const cpu = new FakeCPU();
  const ppu = new FakePPU(() => cpu.nmi());
  const machine = new NESMachine({
    createCpu: () => cpu,
    createPpu: (nmi) => {
      // NESMachine 内部接线：ppu 的 NMI 回调应指向 cpu.nmi
      expect(typeof nmi).toBe('function');
      return ppu;
    },
  });
  machine.loadRom(buildINes()); // NROM 32KB
  return { machine, cpu, ppu };
}

describe('M4 · NTSC 帧周期', () => {
  it('cyclesForFrame：29781/29780 交替，均值 29780.5', () => {
    expect(cyclesForFrame(0)).toBe(29781);
    expect(cyclesForFrame(1)).toBe(29780);
    expect(cyclesForFrame(2)).toBe(29781);
    expect(cyclesForFrame(3)).toBe(29780);
    // 前 100 帧总和 = 100 * 29780.5
    let sum = 0;
    for (let i = 0; i < 100; i++) sum += cyclesForFrame(i);
    expect(sum).toBe(2978050);
  });

  it('NTSC_FPS ≈ 60.0988', () => {
    expect(NTSC_FPS).toBeCloseTo(60.0988, 3);
  });

  it('stepFrame：每步 1 周期时，首帧精确执行 29781 步', () => {
    const cpu = new FakeCPU();
    cpu.defaultStepCycles = 1;
    const ppu = new FakePPU(() => cpu.nmi());
    const machine = new NESMachine({ createCpu: () => cpu, createPpu: () => ppu });
    machine.loadRom(buildINes());
    machine.stepFrame();
    expect(cpu.totalCycles).toBe(7 + 29781);
    // 访问级喂送（契约 v1.1）：是 totalCycles-7 的周期数 ×3 再加访问相位余量（0-2）
    const dots = ppu.cycleCount;
    expect(dots).toBeGreaterThanOrEqual(29781 * 3);
    expect(dots).toBeLessThanOrEqual(29781 * 3 + 3);
    expect(machine.framesRun).toBe(1);
  });

  it('连续两帧：29781 + 29780 周期', () => {
    const cpu = new FakeCPU();
    cpu.defaultStepCycles = 1;
    const ppu = new FakePPU(() => cpu.nmi());
    const machine = new NESMachine({ createCpu: () => cpu, createPpu: () => ppu });
    machine.loadRom(buildINes());
    machine.stepFrame();
    machine.stepFrame();
    expect(cpu.totalCycles).toBe(7 + 29781 + 29780);
    const dots = ppu.cycleCount;
    expect(dots).toBeGreaterThanOrEqual((29781 + 29780) * 3);
    expect(dots).toBeLessThanOrEqual((29781 + 29780) * 3 + 3);
    expect(machine.framesRun).toBe(2);
  });

  it('指令过冲结转：step 返回 7 的长指令跨帧不丢周期', () => {
    const cpu = new FakeCPU();
    cpu.defaultStepCycles = 7;
    const ppu = new FakePPU(() => cpu.nmi());
    const machine = new NESMachine({ createCpu: () => cpu, createPpu: () => ppu });
    machine.loadRom(buildINes());
    machine.stepFrame(); // 目标 29781 → 4255 条 × 7 = 29785（过冲 4 周期）(+7 复位基线)
    expect(cpu.totalCycles).toBe(7 + 4255 * 7);
    machine.stepFrame(); // 目标 59561 → 过冲后 59564 内完成
    expect(cpu.totalCycles).toBeGreaterThan(7 + 59561);
    expect(cpu.totalCycles).toBeLessThanOrEqual(7 + 59561 + 6);
  });

  it('stepFrame 不受队列残留影响（耗尽后走默认周期）', () => {
    const cpu = new FakeCPU();
    cpu.stepQueue = [3, 4];
    cpu.defaultStepCycles = 1;
    const ppu = new FakePPU(() => cpu.nmi());
    const machine = new NESMachine({ createCpu: () => cpu, createPpu: () => ppu });
    machine.loadRom(buildINes());
    machine.stepFrame();
    // 2 条特殊指令 + 其余每步 1 周期 → 总量恰为帧目标（+7 复位基线）
    expect(cpu.totalCycles).toBe(7 + 29781);
  });
});

describe('M4 · 指令级单步与 NMI 接线', () => {
  it('stepInstruction：返回周期数，PPU 按访问级语义同步喂 dots', () => {
    const { machine, cpu, ppu } = makeMachine();
    cpu.stepQueue = [4, 2, 3];
    expect(machine.stepInstruction()).toBe(4);
    // 4 周期 → 12 dots（±2 dots 的访问相位余量）
    expect(ppu.cycleCount).toBeGreaterThanOrEqual(12);
    expect(ppu.cycleCount).toBeLessThanOrEqual(14);
    const after1 = ppu.cycleCount;
    expect(machine.stepInstruction()).toBe(2);
    expect(ppu.cycleCount - after1).toBeGreaterThanOrEqual(6);
    expect(ppu.cycleCount - after1).toBeLessThanOrEqual(8);
    const after2 = ppu.cycleCount;
    expect(machine.stepInstruction()).toBe(3);
    expect(ppu.cycleCount - after2).toBeGreaterThanOrEqual(9);
    expect(ppu.cycleCount - after2).toBeLessThanOrEqual(11);
  });

  it('PPU cycle() 内触发的 NMI 回调直达 cpu.nmi()（忠实接线：用机器传入的回调）', () => {
    const cpu = new FakeCPU();
    const machine = new NESMachine({
      createCpu: () => cpu,
      createPpu: (nmi) => new FakePPU(nmi), // 生产接线：PPU 必须用构造器传入的回调
    });
    const ppu = machine.ppu as unknown as FakePPU;
    machine.loadRom(buildINes());
    ppu.nmiAt = 8; // 第 8 个 dot 触发（首指令 4+2=6 dots，第二条指令后覆盖）
    machine.stepInstruction();
    machine.stepInstruction();
    expect(cpu.nmiCount).toBe(1);
    expect(machine.nmiCount).toBe(1); // 机器侧同步计数（调试面板用）
    machine.reset();
    expect(machine.nmiCount).toBe(0);
  });

  it('loadRom 后整机复位：cpu.reset 与 ppu.reset 均被调用', () => {
    const { machine, cpu, ppu } = makeMachine();
    expect(cpu.resetCount).toBe(1);
    expect(ppu.resetCount).toBe(1);
    machine.reset();
    expect(cpu.resetCount).toBe(2);
    expect(ppu.resetCount).toBe(2);
  });

  it('loadRom 注入 CHR 读取器与镜像（machine → ppu 装配链）', () => {
    const { ppu } = makeMachine();
    expect(ppu.chrReader).not.toBeNull();
    expect(ppu.mirroring).toBe('horizontal');
  });
});

describe('M4 · 扫描行 / dot 推导', () => {
  it('累计 dots 与扫描行换算一致', () => {
    const { machine, cpu, ppu } = makeMachine();
    cpu.defaultStepCycles = 1;
    // 每条指令 1 周期 = 3 dots（+ 相位余量 0-2）；落点按实际喂入数推导
    const targetDots = DOTS_PER_SCANLINE * 100 + 3;
    while (ppu.cycleCount < targetDots) machine.stepInstruction();
    // scanline/dot 由机器侧 ppuDots 推导，与喂入数一致
    expect(machine.scanline).toBe(Math.floor(ppu.cycleCount / DOTS_PER_SCANLINE) % 262);
    expect(machine.dot).toBe(ppu.cycleCount % DOTS_PER_SCANLINE);
    expect(machine.scanline).toBe(100);
    expect(machine.inVblank).toBe(false);
  });

  it('扫描行 241-260 判定为 VBlank', () => {
    const { machine, cpu, ppu } = makeMachine();
    cpu.defaultStepCycles = 1;
    const targetDots = DOTS_PER_SCANLINE * 241 + 1;
    while (ppu.cycleCount < targetDots) machine.stepInstruction();
    expect(machine.scanline).toBe(241);
    expect(machine.inVblank).toBe(true);
  });
});

describe('M4 · SRAM 存取', () => {
  it('电池卡读出快照；非电池卡返回 null', () => {
    const { machine } = makeMachine();
    expect(machine.readSram()).toBeNull(); // 无电池
    const cpu = new FakeCPU();
    const ppu = new FakePPU(() => cpu.nmi());
    const m2 = new NESMachine({ createCpu: () => cpu, createPpu: () => ppu });
    m2.loadRom(buildINes({ battery: true }));
    m2.bus.write(0x6000, 0x42);
    const sram = m2.readSram();
    expect(sram).not.toBeNull();
    expect(sram![0]).toBe(0x42);
  });

  it('writeSram 写回卡带', () => {
    const cpu = new FakeCPU();
    const ppu = new FakePPU(() => cpu.nmi());
    const m = new NESMachine({ createCpu: () => cpu, createPpu: () => ppu });
    m.loadRom(buildINes({ battery: true }));
    const data = new Uint8Array(0x2000);
    data[0x123] = 0x99;
    m.writeSram(data);
    expect(m.bus.read(0x6123)).toBe(0x99);
  });
});
