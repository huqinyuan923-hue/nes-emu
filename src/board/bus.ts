/**
 * CPU 内存总线（实现契约 Bus）。
 *
 * 地址布局：
 *   $0000-$1FFF  内部 RAM 2KB，8 次镜像（addr & 0x7FF）
 *   $2000-$3FFF  PPU 寄存器，每 8 字节折叠（addr & 7）调 ppu.readReg/writeReg
 *   $4000-$4013  APU/IO（一期无音频，开总线）
 *   $4014        OAM DMA → ppu.oamDma(page, read)（+513 周期停顿由第一部 CPU 处理）
 *   $4015        APU 状态（开总线）
 *   $4016/$4017  手柄 1/2（移位寄存器协议）
 *   $4018-$5FFF  开总线
 *   $6000-$7FFF  卡带 PRG-RAM（MMC1 受使能位控制）
 *   $8000-$FFFF  卡带 PRG / mapper 寄存器
 *
 * 开总线：记录最后一次数据总线值（近似真机残留），未映射读取返回它。
 */
import type { Bus, PPU2C02, u16, u8 } from '../contract';
import type { Cartridge } from './cartridge';
import { FrameCounter } from './apu-frame';
import { Joypad } from './joypad';

export class CPUBus implements Bus {
  /** 内部 RAM 2KB */
  readonly ram = new Uint8Array(0x800);
  readonly joypads: [Joypad, Joypad] = [new Joypad(), new Joypad()];
  /** 2A03 帧计数器（$4015 bit6 / $4017；测试 ROM shell 的时间基准，见 apu-frame.ts） */
  readonly frameCounter: FrameCounter;

  private ppu: PPU2C02 | null = null;
  private cartridge: Cartridge | null = null;
  /** 开总线残留值 */
  private openBus: u8 = 0;

  constructor(irqAssert?: () => void, ppuPump?: (cyclesAbsolute: number) => void) {
    this.frameCounter = new FrameCounter(irqAssert ?? (() => {}));
    this.ppuPump = ppuPump;
  }

  private readonly ppuPump?: (cyclesAbsolute: number) => void;

  /**
   * 契约 v1.1（Bus.onAccess）：CPU 每次总线访问前回调。
   * 让机器把 PPU 惰性喂到本访问所在周期（读 $2002 因此看到精确的
   * dot 级状态；读竞态由 PPU 依据自身位置直接判定）。
   */
  onAccess(cycleInInstruction: number, cyclesAbsolute: number): void {
    void cycleInInstruction;
    this.ppuPump?.(cyclesAbsolute);
  }

  /** machine 组装时注入 PPU（构造有先后依赖：cpu 需要 bus，ppu 需要 cpu） */
  attachPPU(ppu: PPU2C02): void {
    this.ppu = ppu;
  }

  attachCartridge(cart: Cartridge): void {
    this.cartridge = cart;
  }

  getCartridge(): Cartridge | null {
    return this.cartridge;
  }

  read(addr: u16): u8 {
    const a = addr & 0xffff;
    let value: u8;
    if (a < 0x2000) {
      value = this.ram[a & 0x7ff]!;
    } else if (a < 0x4000) {
      // $2002 读竞态无需注入：onAccess 的 pump 已把 PPU 喂到本周期 dot，
      // PPU 依据自身 (scanline,dot) 直接判定（见 registers.ts）。
      value = this.ppu ? this.ppu.readReg(a & 7) : this.openBus;
    } else if (a === 0x4015) {
      // APU 状态：无音频通道，仅帧 IRQ 标志（bit6）有效，读后清零
      value = this.frameCounter.readStatus() | (this.openBus & 0x1f);
    } else if (a === 0x4016 || a === 0x4017) {
      value = this.joypads[a - 0x4016]!.read();
    } else if (a < 0x6000) {
      // $4000-$4013 / $4018-$5FFF：音频波形未实现 + 开总线区
      value = this.openBus;
    } else if (a < 0x8000) {
      const cart = this.cartridge;
      value = cart && cart.prgRamEnabled() ? cart.prgRamRead(a & 0x1fff) : this.openBus;
    } else {
      value = this.cartridge ? this.cartridge.prgRead(a) : this.openBus;
    }
    this.openBus = value;
    return value;
  }

  write(addr: u16, value: u8): void {
    const a = addr & 0xffff;
    this.openBus = value & 0xff;
    if (a < 0x2000) {
      this.ram[a & 0x7ff] = value & 0xff;
      return;
    }
    if (a < 0x4000) {
      this.ppu?.writeReg(a & 7, value & 0xff);
      return;
    }
    if (a === 0x4014) {
      // OAM DMA：页号转发给 PPU，数据经本总线逐字节读取
      const page = (value & 0xff) << 8;
      this.ppu?.oamDma(value & 0xff, (readAddr) => this.read((page | (readAddr & 0xff)) & 0xffff));
      return;
    }
    if (a === 0x4016) {
      this.joypads[0]!.write(value & 0xff);
      return;
    }
    if (a === 0x4017) {
      // 写 $4017：帧计数器模式/IRQ inhibit（读 $4017 是手柄 2，走读分支）
      this.frameCounter.write(value & 0xff);
      return;
    }
    if (a < 0x6000) {
      return; // APU / 开总线区：写无效
    }
    if (a < 0x8000) {
      this.cartridge?.prgRamWrite(a & 0x1fff, value & 0xff);
      return;
    }
    this.cartridge?.prgWrite(a, value & 0xff);
  }
}
