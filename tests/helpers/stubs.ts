/**
 * 测试辅助：契约接口的假实现（Fake CPU / Fake PPU）。
 * machine / bus / timing 的单元测试在第一部、第二部代码未就位时也能全量驱动。
 */
import type {
  CPU6502,
  CpuState,
  Framebuffer,
  Mirroring,
  PPU2C02,
  u16,
  u8,
} from '../../src/contract';
import { SCREEN_H, SCREEN_W } from '../../src/contract';

/** 可编程的假 CPU：step() 按游标读队列返回周期数，记录 NMI/IRQ/复位调用。 */
export class FakeCPU implements CPU6502 {
  /** 契约：复位以来的累计周期数（reset 本身计 7 周期） */
  totalCycles = 0;
  resetCount = 0;
  nmiCount = 0;
  irqCount = 0;
  /** 每次 step() 返回的周期数序列（游标推进）；耗尽后走 defaultStepCycles */
  stepQueue: number[] = [];
  private queueIndex = 0;
  /** 队列耗尽后的默认周期数 */
  defaultStepCycles = 2;
  state: CpuState = { pc: 0xc000, a: 0, x: 0, y: 0, sp: 0xfd, p: 0x24, totalCycles: 0 };

  step(): number {
    const n =
      this.queueIndex < this.stepQueue.length
        ? this.stepQueue[this.queueIndex++]!
        : this.defaultStepCycles;
    this.totalCycles += n;
    this.state = { ...this.state, totalCycles: this.totalCycles };
    return n;
  }

  reset(): void {
    this.resetCount++;
    // 契约：reset 本身计 7 周期（机器 pump 以 totalCycles-7 为 dot 原点）
    if (this.resetCount === 1) this.totalCycles = 7;
    this.state = { ...this.state, totalCycles: this.totalCycles };
  }

  nmi(): void {
    this.nmiCount++;
  }

  irq(): void {
    this.irqCount++;
  }

  getState(): CpuState {
    return { ...this.state };
  }
}

/** 可编程的假 PPU：计数 cycle、记录寄存器读写、可在指定 dot 触发 NMI。 */
export class FakePPU implements PPU2C02 {
  cycleCount = 0;
  resetCount = 0;
  nmiCount = 0;
  writeLog: Array<{ index: number; value: u8 }> = [];
  readLog: number[] = [];
  readMap = new Map<number, u8>();
  mirroring: Mirroring | null = null;
  chrReader: ((addr: u16) => u8) | null = null;
  oamDmaLog: Array<{ page: u8; data: u8[] }> = [];
  /** cycleCount 达到该值时触发一次 NMI 回调（null = 不触发） */
  nmiAt: number | null = null;
  readonly fb: Framebuffer = new Uint8ClampedArray(SCREEN_W * SCREEN_H * 4);

  constructor(private readonly nmiCallback: () => void) {}

  reset(): void {
    this.resetCount++;
    this.cycleCount = 0;
  }

  setChrReader(read: (addr: u16) => u8): void {
    this.chrReader = read;
  }

  setMirroring(mode: Mirroring): void {
    this.mirroring = mode;
  }

  cycle(): void {
    this.cycleCount++;
    if (this.nmiAt !== null && this.cycleCount === this.nmiAt) {
      this.nmiCount++;
      this.nmiCallback();
    }
  }

  readReg(index: u8): u8 {
    this.readLog.push(index & 7);
    return this.readMap.get(index & 7) ?? 0;
  }

  writeReg(index: u8, value: u8): void {
    this.writeLog.push({ index: index & 7, value: value & 0xff });
  }

  oamDma(page: u8, readFn: (addr: u16) => u8): void {
    const data: u8[] = [];
    for (let i = 0; i < 256; i++) {
      data.push(readFn(((page << 8) | i) & 0xffff));
    }
    this.oamDmaLog.push({ page, data });
  }

  getFramebuffer(): Framebuffer {
    return this.fb;
  }
}

/** 组装一套假机器三件套（ppu 的 NMI 回调指向 cpu.nmi，与真机装配一致） */
export function makeFakeParts(): { cpu: FakeCPU; ppu: FakePPU } {
  const cpu = new FakeCPU();
  const ppu = new FakePPU(() => cpu.nmi());
  return { cpu, ppu };
}
