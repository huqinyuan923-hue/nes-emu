/**
 * 卡带抽象与 mapper 一期实现：NROM(0) / MMC1(1) / UxROM(2) / CNROM(3)。
 *
 * 卡带侧职责（见任务书）：
 *   - PRG ROM：CPU $8000-$FFFF
 *   - PRG-RAM：CPU $6000-$7FFF（含电池存档数据，供 UI 序列化）
 *   - CHR：PPU $0000-$FFF，经 setChrReader 注入 PPU（bus/machine 负责）
 *   - 镜像模式上报：getMirroring()
 *
 * 统一决策（记录于 REPORT.md）：
 *   - 一期所有 mapper 都提供 8KB PRG-RAM 映射到 $6000-$7FFF。真实硬件上
 *     NROM/UNROM 板通常没有 PRG-RAM，但提供它无害（游戏不会依赖不存在的
 *     RAM 来工作），且 blargg 测试 ROM 的结果协议恰好用 $6000-$7FFF，
 *     有了它自动化测试才成立。MMC1 保留 PRG-RAM 使能位语义。
 *   - chr === null 视为 CHR-RAM：8KB 可写，写前读后不清零，power-on 随机
 *     （这里填 0，可玩性无影响）。
 *   - UxROM 已知总线冲突（写入 bank 寄存器时值被 ROM 内容 AND）按常见
 *     模拟器做法忽略。
 */
import type { Mirroring, u16, u8 } from '../contract';
import type { INesRom } from './ines';

export interface Cartridge {
  /** mapper 编号（iNES 头解析所得） */
  readonly mapperNumber: number;
  /** PRG ROM 数据 */
  readonly prg: Uint8Array;
  /** CHR 数据（CHR-RAM 时为构造分配的 8KB RAM） */
  readonly chr: Uint8Array;
  /** 是否 CHR-RAM（chrUnits=0 的 ROM） */
  readonly chrIsRam: boolean;
  /** CPU 读 PRG（addr: $8000-$FFFF） */
  prgRead(addr: u16): u8;
  /** CPU 写 PRG 空间（mapper 寄存器写入） */
  prgWrite(addr: u16, value: u8): void;
  /** CPU 读 PRG-RAM（addr: $6000-$7FFF） */
  prgRamRead(addr: u16): u8;
  prgRamWrite(addr: u16, value: u8): void;
  /** PRG-RAM 当前是否可读写（MMC1 有使能位；其余恒 true） */
  prgRamEnabled(): boolean;
  /** PPU 读 CHR / 名表图案表（addr: $0000-$1FFF） */
  chrRead(addr: u16): u8;
  /** PPU 写 CHR（仅 CHR-RAM 有效） */
  chrWrite(addr: u16, value: u8): void;
  /** 当前镜像模式（MMC1 会被软件改写） */
  getMirroring(): Mirroring;
  /** 是否声明电池存档 */
  readonly battery: boolean;
  /** PRG-RAM 原始数据（存档序列化用） */
  readonly prgRam: Uint8Array;
}

const PRG_RAM_SIZE = 0x2000; // 8KB，$6000-$7FFF

/** 公共基类：持有 PRG/CHR/PRG-RAM 与默认镜像。 */
abstract class BaseCartridge implements Cartridge {
  readonly mapperNumber: number;
  readonly prg: Uint8Array;
  /** 构造后恒非空：CHR-ROM 或兜底分配的 8KB CHR-RAM */
  readonly chr: Uint8Array;
  readonly chrIsRam: boolean;
  readonly prgRam = new Uint8Array(PRG_RAM_SIZE);
  readonly battery: boolean;
  protected mirroring: Mirroring;

  constructor(rom: INesRom) {
    this.mapperNumber = rom.mapper;
    this.prg = rom.prg;
    this.chr = rom.chr ?? new Uint8Array(0x2000); // CHR-RAM 8KB
    this.chrIsRam = rom.chr === null;
    this.battery = rom.battery;
    this.mirroring = rom.mirroring;
  }

  prgRamEnabled(): boolean {
    return true;
  }

  prgRamRead(addr: u16): u8 {
    return this.prgRam[addr & 0x1fff] ?? 0;
  }

  prgRamWrite(addr: u16, value: u8): void {
    this.prgRam[addr & 0x1fff] = value;
  }

  chrRead(addr: u16): u8 {
    return this.chr[addr & 0x1fff] ?? 0;
  }

  chrWrite(addr: u16, value: u8): void {
    if (this.chrIsRam) {
      this.chr[addr & 0x1fff] = value;
    }
    // CHR ROM 不可写，静默忽略
  }

  getMirroring(): Mirroring {
    return this.mirroring;
  }

  abstract prgRead(addr: u16): u8;
  abstract prgWrite(addr: u16, value: u8): void;
}

/** NROM(0)：16KB 镜像两份或 32KB 线性；无 bank 切换。 */
export class NRomCartridge extends BaseCartridge {
  constructor(rom: INesRom) {
    super(rom);
    if (rom.mapper !== 0) throw new Error(`NRomCartridge 收到 mapper ${rom.mapper}`);
  }

  prgRead(addr: u16): u8 {
    // $8000-$FFFF → PRG 内偏移 0-$7FFF；16KB 时按 16KB 周期镜像
    const off = addr - 0x8000;
    return this.prg[this.prg.length <= 0x4000 ? off & 0x3fff : off] ?? 0;
  }

  prgWrite(): void {
    // NROM 无寄存器，写 $8000-$FFFF 无效果
  }
}

/** CNROM(3)：同 NROM，外加一个 8KB CHR bank 寄存器（$8000-$FFFF 任意写）。 */
export class CnromCartridge extends BaseCartridge {
  private chrBank = 0;
  private readonly chrBankMask: number;

  constructor(rom: INesRom) {
    super(rom);
    if (rom.mapper !== 3) throw new Error(`CnromCartridge 收到 mapper ${rom.mapper}`);
    // CHR 8KB bank 总数；CHR-RAM 时固定 1
    const banks = this.chrIsRam ? 1 : this.chr.length >> 13;
    this.chrBankMask = banks - 1;
  }

  prgRead(addr: u16): u8 {
    const off = addr - 0x8000;
    return this.prg[this.prg.length <= 0x4000 ? off & 0x3fff : off] ?? 0;
  }

  prgWrite(addr: u16, value: u8): void {
    this.chrBank = value & this.chrBankMask;
    void addr;
  }

  override chrRead(addr: u16): u8 {
    // CNROM 整 8KB 切换：$0000-$1FFF 全部来自所选 bank；CHR-RAM 时为固定映射
    if (this.chrIsRam) return this.chr[addr & 0x1fff] ?? 0;
    const off = (this.chrBank << 13) | (addr & 0x1fff);
    return this.chr[off] ?? 0;
  }
}

/** UxROM(2)：$8000-$BFFF 16KB 可切换，$C000-$FFFF 固定最后一 bank；CHR-RAM 8KB。 */
export class UxromCartridge extends BaseCartridge {
  private bank = 0;
  private readonly bankMask: number;

  constructor(rom: INesRom) {
    super(rom);
    if (rom.mapper !== 2) throw new Error(`UxromCartridge 收到 mapper ${rom.mapper}`);
    const banks = Math.max(1, this.prg.length >> 14);
    this.bankMask = banks - 1;
  }

  prgRead(addr: u16): u8 {
    if (addr < 0xc000) {
      const off = (this.bank << 14) | (addr & 0x3fff);
      return this.prg[off] ?? 0;
    }
    // 固定区：最后一个 16KB bank
    const off = this.prg.length - 0x4000 + (addr & 0x3fff);
    return this.prg[off] ?? 0;
  }

  prgWrite(addr: u16, value: u8): void {
    // 已知硬件总线冲突（写入值与 ROM 内容 AND）按惯例忽略
    this.bank = value & this.bankMask;
    void addr;
  }
}

/**
 * MMC1(1)：5 次写串行移位寄存器协议，4 个内部寄存器：
 *   R0 ($8000-$9FFF) CHR 模式 | 镜像 | PRG 模式
 *   R1 ($A000-$BFFF) CHR bank 0（4KB 单位）
 *   R2 ($C000-$DFFF) CHR bank 1（4KB 单位）
 *   R3 ($E000-$FFFF) PRG bank（16KB 单位低 2 位）| PRG-RAM 使能
 * 任意写入时 bit7=1 → 复位移位寄存器（并按惯例把 R0 的 PRG 模式恢复为 3）。
 */
export class Mmc1Cartridge extends BaseCartridge {
  private shift = 0; // 移位寄存器（高位先进，共 5 位）
  private shiftCount = 0;
  private readonly regs = new Uint8Array(4);
  private readonly chr4kBankMask: number; // 4KB bank 掩码
  private readonly prg16kBankMask: number;

  private fourScreen: boolean;

  constructor(rom: INesRom) {
    super(rom);
    if (rom.mapper !== 1) throw new Error(`Mmc1Cartridge 收到 mapper ${rom.mapper}`);
    this.fourScreen = rom.fourScreen;
    // 上电默认：R0=0x0C（PRG 模式 3：$8000 可切换 + $C000 固定末 bank）、镜像取头
    this.regs[0] = 0x0c;
    this.chr4kBankMask = this.chrIsRam ? 0 : (this.chr.length >> 12) - 1;
    const banks = Math.max(1, this.prg.length >> 14);
    this.prg16kBankMask = banks - 1;
  }

  prgWrite(addr: u16, value: u8): void {
    if ((value & 0x80) !== 0) {
      // 复位：清移位状态；同时把 PRG 模式位（R0 bits2-3）锁回 3，
      // 镜像位与 CHR 模式位保持（0x13 = bit4 | bits0-1）
      this.shift = 0;
      this.shiftCount = 0;
      this.regs[0] = (this.regs[0]! & 0x13) | 0x0c;
      return;
    }
    // 串行装入：value bit0 进移位寄存器最高位
    this.shift = ((this.shift >> 1) | ((value & 1) << 4)) & 0x1f;
    this.shiftCount++;
    if (this.shiftCount < 5) return;

    // 第 5 次写：锁存到对应寄存器并清空移位状态
    const regIndex = (addr >> 13) & 0x03; // $8000-$9FFF→0, $A000-$BFFF→1, ...
    this.regs[regIndex] = this.shift;
    this.shift = 0;
    this.shiftCount = 0;
  }

  prgRead(addr: u16): u8 {
    const prgMode = (this.regs[0]! >> 2) & 0x03;
    const r3 = this.regs[3]!;
    const off16 = addr & 0x3fff;
    const hi = addr >= 0xc000 ? 1 : 0;
    if (prgMode <= 1) {
      // 32KB 模式：整体 32KB 切换，bank 对由 R3 低 4 位（去掉最低位）选择
      const bank = ((r3 & 0x0e) & (this.prg16kBankMask & 0x0e)) | hi;
      return this.prg[(bank << 14) | off16] ?? 0;
    }
    let bank: number;
    if (prgMode === 2) {
      // $8000 固定第一 bank，$C000 切换
      bank = hi ? r3 & this.prg16kBankMask : 0;
    } else {
      // 模式 3：$8000 切换，$C000 固定末 bank
      bank = hi ? this.prg16kBankMask : r3 & this.prg16kBankMask;
    }
    return this.prg[(bank << 14) | off16] ?? 0;
  }

  override chrRead(addr: u16): u8 {
    if (this.chrIsRam) return this.chr[addr & 0x1fff] ?? 0;
    const chrMode = (this.regs[0]! >> 4) & 1;
    const half = (addr >> 12) & 1; // $0000-$0FFF=0 / $1000-$1FFF=1
    let bank: number;
    if (chrMode === 0) {
      // 8KB 模式：R1 选 8KB（最低位忽略），后半 4KB 用 bank+1
      bank = ((this.regs[1]! & 0x1e) & (this.chr4kBankMask & 0x1e)) | half;
    } else {
      // 4KB 模式：$0000-$0FFF 用 R1，$1000-$1FFF 用 R2
      const raw = half ? this.regs[2]! : this.regs[1]!;
      bank = raw & this.chr4kBankMask;
    }
    const off = (bank << 12) | (addr & 0x0fff);
    return this.chr[off] ?? 0;
  }

  override prgRamEnabled(): boolean {
    // MMC1B 语义（nesdev wiki）：R3 bit4 = 0 → PRG RAM 使能；1 → 禁用（读开总线）。
    // 上电 R3=0 即默认使能。
    return (this.regs[3]! & 0x10) === 0;
  }

  override getMirroring(): Mirroring {
    // 四屏镜像的 MMC1 卡（极少）不覆盖；常规按 R0 bits0-1
    if (this.fourScreen) return 'four';
    switch (this.regs[0]! & 0x03) {
      case 0:
        return 'single-lower';
      case 1:
        return 'single-upper';
      case 2:
        return 'vertical';
      default:
        return 'horizontal';
    }
  }
}

/** 按 mapper 编号构造卡带。一期仅支持 0/1/2/3。 */
export function createCartridge(rom: INesRom): Cartridge {
  switch (rom.mapper) {
    case 0:
      return new NRomCartridge(rom);
    case 1:
      return new Mmc1Cartridge(rom);
    case 2:
      return new UxromCartridge(rom);
    case 3:
      return new CnromCartridge(rom);
    default:
      throw new Error(`不支持的 mapper: ${rom.mapper}（一期支持 0/1/2/3，MMC3 列二期）`);
  }
}
