/**
 * 整机装配与运行循环。
 *
 * 组装顺序（存在依赖环：cpu 需要 bus，ppu 的 NMI 需要 cpu）：
 *   1. bus（纯数据结构，无依赖）
 *   2. cpu = createCPU(bus)
 *   3. ppu = createPPU(nmiCallback = () => cpu.nmi())
 *   4. bus.attachPPU(ppu)
 *
 * NTSC 主循环（任务书规定）：
 *   每帧 29780/29781 CPU 周期交替（累计 29780.5 取整实现）；
 *   内层严格 `n = cpu.step(); for (i = 0; i < n*3; i++) ppu.cycle()`，
 *   即 PPU 以 3 dots / CPU cycle 被动跟拍，VBlank NMI 由 PPU 在 cycle() 内回调。
 *
 * 调试面板的扫描行/dot/VBlank 为机器侧从喂入的 PPU 周期数推导（dot 计数器），
 * 不触碰 $2002（读它会清掉 VBlank 标志，干扰运行状态）。
 */
import {
  CPU_CYCLES_PER_FRAME,
  DOTS_PER_SCANLINE,
  SCANLINES_PER_FRAME,
  type Bus,
  type CPU6502,
  type CpuState,
  type Framebuffer,
  type PPU2C02,
  type u16,
  type u8,
} from '../contract';
import { CPUBus } from './bus';
import { type Cartridge, createCartridge } from './cartridge';
import { parseINes } from './ines';

export interface MachineFactories {
  /** 第一部产出：createCPU6502(bus) */
  createCpu(bus: Bus): CPU6502;
  /** 第二部产出：createPPU2C02(nmiCallback) */
  createPpu(nmiCallback: () => void): PPU2C02;
}

export class NESMachine {
  readonly bus: CPUBus;
  readonly cpu: CPU6502;
  readonly ppu: PPU2C02;
  cartridge: Cartridge | null = null;

  constructor(factories: MachineFactories) {
    // 组装顺序：bus（IRQ 线 + PPU pump 闭包都延迟到字段赋值后生效）→ cpu → ppu
    this.bus = new CPUBus(
      () => this.cpu.irq(),
      (cyclesAbsolute) => this.pumpPPU(cyclesAbsolute),
    );
    this.cpu = factories.createCpu(this.bus);
    this.ppu = factories.createPpu(() => {
      this.nmiCount++;
      this.cpu.nmi();
    });
    this.bus.attachPPU(this.ppu);
  }

  /** 已开始的帧数（stepFrame 计数，决定帧目标 = round(frameIndex × 29780.5)） */
  private frameIndex = 0;
  /** 帧周期累计目标（整数化后的绝对周期数） */
  private frameTarget = 0;
  /** 本帧窗口内已执行的 CPU 周期（指令过冲自然结转下一帧） */
  private frameCycles = 0;
  /** 复位以来喂给 PPU 的 dot 总数（调试面板用） */
  private ppuDots = 0;
  /** 复位以来完整执行帧数 */
  framesRun = 0;
  /** 复位以来 PPU 触发的 NMI 次数（接线回调处计数，调试面板用） */
  nmiCount = 0;

  /** 解析 iNES 并装入卡带，随后整机复位。 */
  loadRom(bytes: Uint8Array): void {
    const rom = parseINes(bytes);
    this.cartridge = createCartridge(rom);
    this.bus.attachCartridge(this.cartridge);
    this.reset();
  }

  /** 整机复位：PPU 先复位再注入 CHR 读取器/写入器与镜像（复位可能清空注入），CPU 最后。 */
  reset(): void {
    this.ppu.reset();
    const cart = this.cartridge;
    if (cart) {
      this.ppu.setChrReader((addr) => cart.chrRead(addr));
      this.ppu.setMirroring(cart.getMirroring());
      // 集成侧 CHR 写通路（契约缺口补全，见 README-偏差记录.md §2.2）：
      // 鸭子类型探测，PPU 未实现时（如测试桩）静默跳过
      const writer = (this.ppu as { setChrWriter?: (w: (a: u16, v: u8) => void) => void }).setChrWriter;
      writer?.call(this.ppu, (addr, value) => cart.chrWrite(addr, value));
    }
    this.cpu.reset();
    this.frameIndex = 0;
    this.frameTarget = 0;
    this.frameCycles = 0;
    this.ppuDots = 0;
    this.framesRun = 0;
    this.nmiCount = 0;
  }

  /** 精确执行一条 CPU 指令并同步 PPU（访问级喂送，见 pumpPPU）。返回该指令周期数。 */
  stepInstruction(): number {
    const n = this.cpu.step();
    // 访问级 pump 已在各 onAccess 回调中推进；此处补齐指令末尾余量
    this.flushPPU();
    this.bus.frameCounter.tick(n);
    this.frameCycles += n;
    return n;
  }

  /**
   * 执行满一帧：目标 = round(帧序号 × 29780.5)，差分自然形成 29781/29780
   * 交替（与 timing.cyclesForFrame 同一公式）。指令跨界过冲（最多 7 周期）
   * 自然结转，不重试也不截断。
   *
   * 注：修复轮 2 曾实验「PPU dot 为帧边界权威」（89342/89341），实测相位差
   * 序列与旧实现完全相同（H1 证伪），且破坏帧周期单元测试，已回退。
   * 见 REPORT.md §5.4。
   */
  stepFrame(): void {
    this.frameIndex++;
    this.frameTarget = Math.round(this.frameIndex * CPU_CYCLES_PER_FRAME);
    while (this.frameCycles < this.frameTarget) {
      this.stepInstruction();
    }
    this.framesRun++;
  }

  getFramebuffer(): Framebuffer {
    return this.ppu.getFramebuffer();
  }

  /** 调试面板：当前扫描行（0-261，由 dot 计数推导） */
  get scanline(): number {
    return Math.floor(this.ppuDots / DOTS_PER_SCANLINE) % SCANLINES_PER_FRAME;
  }

  /** 调试面板：当前扫描行内 dot（0-340） */
  get dot(): number {
    return this.ppuDots % DOTS_PER_SCANLINE;
  }

  /** 调试面板：是否处于 VBlank 区间（扫描行 241-260，推导值） */
  get inVblank(): boolean {
    const sl = this.scanline;
    return sl >= 241 && sl <= 260;
  }

  getCpuState(): CpuState {
    return this.cpu.getState();
  }

  /** 电池存档读出（无卡带或无电池返回 null） */
  readSram(): Uint8Array | null {
    const cart = this.cartridge;
    return cart && cart.battery ? cart.prgRam.slice() : null;
  }

  /** 电池存档写回 */
  writeSram(data: Uint8Array): void {
    const cart = this.cartridge;
    if (cart && cart.battery && data.length <= cart.prgRam.length) {
      cart.prgRam.set(data);
    }
  }

  // -------------------------------------------------------------- 访问级同步
  // 契约 v1.1（Bus.onAccess）消费方（REPORT.md 修复轮 §F2）：
  // 每个 CPU 总线周期开始时把 PPU 喂到该周期对应的 dot，使 $2002 读看到
  // 的子周期状态与真机一致（指令级喂送只能给指令边界的快照，dot 级读竞态
  // 与 NMI 相对时序无法复现）。CPU totalCycles 含 reset 的 7 周期，
  // 故 dot 原点 = totalCycles-7；phase 为读采样点在周期内的 dot 偏移。
  private static readonly RESET_CYCLES = 7;
  private static readonly ACCESS_PHASE_DOTS = 2;

  /** 把一个 CPU 周期序号折算成应已喂的 dot 总数 */
  private dotsForCycle(cyclesAbsolute: number): number {
    const rel = cyclesAbsolute - 1 - NESMachine.RESET_CYCLES;
    return rel > 0 ? rel * 3 + NESMachine.ACCESS_PHASE_DOTS : 0;
  }

  /**
   * 总线 onAccess 回调的实际入口（CPUBus 持有该闭包）。
   * 惰性推进 PPU 到本访问所在周期的 dot 位置。
   */
  pumpPPU(cyclesAbsolute: number): void {
    const target = this.dotsForCycle(cyclesAbsolute);
    const ppu = this.ppu;
    let fed = this.ppuDots;
    while (fed < target) {
      ppu.cycle();
      fed++;
    }
    this.ppuDots = fed;
  }

  /** 指令结束补齐：喂到指令末尾（下一周期起点前） */
  private flushPPU(): void {
    const n = this.cpu.getState().totalCycles;
    this.pumpPPU(n + 1);
  }
}

/** 便捷读取（调试/测试用）：直通总线读一个字节 */
export function peek(machine: NESMachine, addr: u16): number {
  return machine.bus.read(addr);
}
