/**
 * 2C02 显存模型。
 *
 * 地址空间划分（14 位，$0000-$3FFF）：
 * - $0000-$1FFF 图案表（CHR）：**不在 PPU 内部**，经 setChrReader 注入读取函数，
 *   由主板/mapper 提供（CHR-RAM 同样走这条通道，mapper 在其内部实现可写性）。
 * - $2000-$2EFF 命名表（nametable）：内部 2KB（两页 × 1KB），布局由镜像模式决定。
 * - $2F00-$3EFF 命名表镜像（$2000-$2EFF 以 $1000 周期重复，mapNT 已折叠处理）。
 * - $3F00-$3FFF 调色板 RAM（32 字节有效，外部以 32 字节周期镜像）。
 *
 * 镜像模式术语对照（nesdev wiki）：
 * - vertical  （竖向排列，iNES flags6 bit0=1）：$2000≡$2400、$2800≡$2C00，
 *   即水平翻页时左右两页内容独立 → 横向滚动游戏（SMB1）使用。
 * - horizontal（横向排列，iNES flags6 bit0=0）：$2000≡$2800、$2400≡$2C00，
 *   即垂直翻页时上下两页内容独立 → 纵向滚动游戏使用。
 * - single-lower / single-upper：四页全部折叠到低/高 1KB。
 * - four：需要 4KB 独立显存，本实现内部 VRAM 仅 2KB，**降级为 vertical**
 *   （契约注释允许，偏差记录见 README-偏差记录.md / REPORT.md）。
 */
import type { Mirroring, u8, u16 } from '../contract';

export class VRAM {
  /** 内部命名表 2KB = 2 页 × 1KB */
  private nametable = new Uint8Array(0x800);
  /** 调色板 RAM 32 字节（有效位 6 bit，硬件即如此，读回值 & 0x3F） */
  private pal = new Uint8Array(0x20);
  /** 对象属性内存 OAM（精灵属性表）256 字节 */
  private oam = new Uint8Array(0x100);
  /** 实际生效的镜像模式（'four' 已降级） */
  private mirroring: Mirroring = 'horizontal';
  /** CHR 读取函数（$0000-$1FFF），未注入时读 0 */
  private chrReader: (addr: u16) => u8 = () => 0;

  /** 设置镜像模式；多次调用以最后一次为准；'four' 降级为 'vertical' 并记录 */
  setMirroring(mode: Mirroring): void {
    if (mode === 'four') {
      // 契约规定：'four'（4 页独立显存）超出内部 2KB 容量，降级处理。
      // 影响面：使用 4 页镜像的极少数卡带会出现左右两屏内容重复，见偏差记录。
      this.mirroring = 'vertical';
      return;
    }
    this.mirroring = mode;
  }

  /** 供测试/调试查看实际生效的镜像模式 */
  getEffectiveMirroring(): Mirroring {
    return this.mirroring;
  }

  /** 注入 CHR/图案表读取函数（主板加载 ROM 后调用） */
  setChrReader(read: (addr: u16) => u8): void {
    this.chrReader = read;
  }

  /** 图案表读：$0000-$1FFF，超出位自动截断到 13 位 */
  readChr(addr: u16): u8 {
    return this.chrReader(addr & 0x1FFF);
  }

  // ---------------------------------------------------------------- 命名表

  /** 命名表读：addr 为 PPU 地址 $2000-$2FFF 范围（其他位忽略） */
  readNametable(addr: u16): u8 {
    return this.nametable[this.mapNT(addr)] ?? 0;
  }

  /** 命名表写：同上范围 */
  writeNametable(addr: u16, value: u8): void {
    this.nametable[this.mapNT(addr)] = value & 0xFF;
  }

  /**
   * 把 $2000-$2FFF 区间地址折叠到内部 2KB（0-0x7FF）。
   * 页选择：
   * - horizontal：页 = 地址 bit 11（$2000≡$2800，$2400≡$2C00）
   * - vertical：  页 = 地址 bit 10（$2000≡$2400，$2800≡$2C00）
   * - single-*：  页恒 0 / 恒 1
   */
  private mapNT(addr: u16): u16 {
    const a = addr & 0x0FFF; // 页内 12 位（4KB = 4 页语义空间）
    let page: number;
    switch (this.mirroring) {
      case 'horizontal': page = (a >> 11) & 1; break;
      case 'vertical': page = (a >> 10) & 1; break;
      case 'single-lower': page = 0; break;
      case 'single-upper': page = 1; break;
      default: page = (a >> 10) & 1; break; // 'four' 已在 setMirroring 降级，防御性兜底
    }
    return ((page << 10) | (a & 0x3FF)) & 0x7FF;
  }

  // ---------------------------------------------------------------- 调色板

  /**
   * 调色板读（$3F00-$3FFF 经 $2007 读时调用）。
   * $3F10/$3F14/$3F18/$3F1C（精灵通用底色位）硬件上与 $3F00/$3F04/$3F08/$3F0C
   * 是同一存储单元，读写均镜像。
   */
  readPal(index: number): u8 {
    return this.pal[this.mapPal(index)] ?? 0;
  }

  /** 调色板写（写值只保留低 6 位，硬件调色板 RAM 每项 6 bit） */
  writePal(index: number, value: u8): void {
    this.pal[this.mapPal(index)] = value & 0x3F;
  }

  private mapPal(index: number): number {
    const i = index & 0x1F;
    // 0x13 = 0b10011：命中 $3F10/14/18/1C（bit4=1 且低 2 位为 0）
    return (i & 0x13) === 0x10 ? i & 0x0F : i;
  }

  // ---------------------------------------------------------------- OAM

  /** OAM 读（index 自动 & 0xFF 环绕） */
  readOam(index: number): u8 {
    return this.oam[index & 0xFF] ?? 0;
  }

  /** OAM 写 */
  writeOam(index: number, value: u8): void {
    this.oam[index & 0xFF] = value & 0xFF;
  }

  /** OAM 数组直引用（渲染评估与 DMA 用；内部共享，勿在外部长期持有） */
  getOam(): Uint8Array {
    return this.oam;
  }

  // ---------------------------------------------------------------- 复位

  /**
   * 清空显存内容（命名表/调色板/OAM）。
   * 设计决策：reset() **保留** chrReader 与镜像设置——主板在加载 ROM 时注入它们，
   * reset 后不应失效；显存内容按"确定性测试"原则清零
   * （真实硬件上电内容随机，模拟器选择清零，见 REPORT.md）。
   */
  clear(): void {
    this.nametable.fill(0);
    this.pal.fill(0);
    this.oam.fill(0);
  }
}
