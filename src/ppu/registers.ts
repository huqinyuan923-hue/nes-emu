/**
 * $2000-$2007 寄存器语义。
 *
 * 索引 0-7 对应 $2000-$2007（地址折叠由总线方完成，本模块只收 index）。
 * 逐条语义对应 nesdev wiki "PPU registers"；有意的简化均带注释并在
 * REPORT.md 汇总。
 *
 * loopy 寄存器（v/t/x/w）位布局（15 bit）：
 *   yyy NN YYYYY XXXXX
 *   │││ ││ │─────│ └── coarse X（tile 列 0-31，bit 0-4）
 *   │││ ││ └──────── coarse Y（tile 行 0-29，bit 5-9）
 *   │││ └────────── 命名表选择（bit 10=X，bit 11=Y）
 *   │└────────────── fine Y（行内点行 0-7，bit 12-14）
 *   └ （bit 14 属于 fine Y 高位；地址寻址时低 14 位有效）
 */
import type { PPUInternal } from './state';

/** $2000 增量位：0=$2007 读写后 v+=1；1=v+=32（跨 32 列） */
export function vramIncrement(p: PPUInternal): number {
  return (p.ctrl & 0x04) !== 0 ? 32 : 1;
}

/** $2000 bit4：背景图案表基址（0=$0000，1=$1000） */
export function bgPatternTable(p: PPUInternal): number {
  return (p.ctrl & 0x10) !== 0 ? 0x1000 : 0x0000;
}

/** $2000 bit3：精灵图案表基址（8×16 模式下由 tile 号 bit0 决定，忽略此位） */
export function spritePatternTable(p: PPUInternal): number {
  return (p.ctrl & 0x08) !== 0 ? 0x1000 : 0x0000;
}

/** $2000 bit5：精灵高度（0=8×8，1=8×16） */
export function spriteHeight(p: PPUInternal): number {
  return (p.ctrl & 0x20) !== 0 ? 16 : 8;
}

/** 渲染总开关：$2001 bit3（背景）或 bit4（精灵）任一使能 */
export function isRenderingEnabled(p: PPUInternal): boolean {
  return (p.mask & 0x18) !== 0;
}

/** 触发 NMI 回调（回调不存在时为空操作） */
export function fireNmi(p: PPUInternal): void {
  p.nmiCallback?.();
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

export function readRegister(p: PPUInternal, index: number): number {
  switch (index & 7) {
    case 2: {
      // PPUSTATUS：VBlank | sprite0 | overflow；读清 VBlank 并复位写锁存 w。
      // 简化：低 5 位（渲染期 OLED 残留/open bus）恒返回 0，见 REPORT.md。
      //
      // VBlank 读竞态（契约 v1.1 访问级同步的直接产物，REPORT.md 修复轮 §F3）：
      // 总线在每次 CPU 访问前把 PPU 喂到该周期对应的 dot（machine.pumpPPU），
      // 因此此刻 PPU 的 (scanline,dot) 就是读采样点的精确位置：
      // - vblankFlag 已置 → 返回 V（并清除）
      // - 未置且下一待喂 dot 正是置位 dot (241,1) → 读数 0 并抑制本帧置位
      //   （含 NMI）：硬件同拍读的行为，02-vbl_set_time 期望表 "T+4 行 - -" 标定
      // - 否则 → 0（置位尚未发生）
      if (!p.vblankFlag && p.scanline === 241 && p.dot === 1) {
        p.suppressVblankOnce = true;
        p.wLatch = false;
        return (p.sprite0Flag ? 0x40 : 0) | (p.overflowFlag ? 0x20 : 0);
      }
      const v = (p.vblankFlag ? 0x80 : 0) | (p.sprite0Flag ? 0x40 : 0) | (p.overflowFlag ? 0x20 : 0);
      p.vblankFlag = false;
      p.wLatch = false;
      return v;
    }
    case 4:
      // OAMDATA 读：返回 OAM[oamAddr]，地址不自动递增。
      // 简化：渲染期间的 secondary OAM 直通/错位行为未复现，见 REPORT.md。
      return p.vram.readOam(p.oamAddr);
    case 7:
      return readPPUData(p);
    default:
      // $2000/$2001/$2003/$2005/$2006 为只写寄存器；硬件读返回内部总线残留
      // （open bus）。本实现恒返回 0，见 REPORT.md。
      return 0;
  }
}

/**
 * $2007 PPUDATA 读：缓冲读。
 * - 非调色板地址：返回内部缓冲（上一字节），然后把新地址内容装入缓冲 ——
 *   这是因为 VRAM 读对 CPU 有 1 周期延迟（硬件为 palette 直读设计的 pipeline）。
 * - 调色板地址（$3F00-$3FFF）：palette RAM 直读返回（无延迟），但内部缓冲
 *   仍被"灰读"污染：装入该地址在命名表镜像空间（v & 0x2FFF）的内容。
 * 读后 v 按增量位递增。
 */
function readPPUData(p: PPUInternal): number {
  const addr = p.vReg & 0x3FFF;
  let result: number;
  if (addr >= 0x3F00) {
    result = p.vram.readPal(addr & 0x1F);
    // 灰读污染：缓冲装入命名表镜像位置的值（硬件总线行为）
    p.readBuffer = p.vram.readNametable(addr & 0x2FFF);
  } else {
    result = p.readBuffer;
    p.readBuffer = fetchVRam(p, addr);
  }
  p.vReg = (p.vReg + vramIncrement(p)) & 0x7FFF;
  return result;
}

/** PPU 地址空间读（$2007 用的原始通路；调色板区不会走到这里） */
function fetchVRam(p: PPUInternal, addr: number): number {
  if (addr < 0x2000) return p.vram.readChr(addr);
  return p.vram.readNametable(addr);
}

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

export function writeRegister(p: PPUInternal, index: number, value: number): void {
  const v = value & 0xFF;
  switch (index & 7) {
    case 0:
      // PPUCTRL：命名表选择进 t（bit10-11）；NMI 使能 0→1 且处于 VBlank 时补触发
      // （NMI 需要比较覆盖前的旧值，逻辑独立在 writeCtrl 中）。
      writeCtrl(p, v);
      break;
    case 1:
      // PPUMASK：直接保存（渲染合成按位解释）
      p.mask = v;
      break;
    case 3:
      // OAMADDR
      p.oamAddr = v;
      break;
    case 4:
      // OAMDATA 写：写入并地址自增（环绕）
      p.vram.writeOam(p.oamAddr, v);
      p.oamAddr = (p.oamAddr + 1) & 0xFF;
      break;
    case 5:
      // PPUSCROLL 双写：第一次=fineX+coarseX；第二次=fineY+coarseY
      writeScroll(p, v);
      break;
    case 6:
      // PPUADDR 双写：第一次=高 6 位；第二次=低 8 位，且 v=t 立即生效
      writeAddr(p, v);
      break;
    case 7:
      writePPUData(p, v);
      break;
  }
}

/**
 * $2000 PPUCTRL 的正确写流程（NMI 补触发需要覆盖前的旧值，独立成函数）。
 *
 * 硬件上在 VBlank 期间使能 NMI 会触发一次 NMI，但输出同样有约 2 dots 的
 * 延迟、并在输出时重新检查 vblankFlag 与 bit7（07-nmi_on_timing 期望
 * "VBL 末尾使能太晚则不触发"即此模型）。
 */
export function writeCtrl(p: PPUInternal, value: number): void {
  const v = value & 0xFF;
  const oldNmi = (p.ctrl & 0x80) !== 0;
  p.ctrl = v;
  p.tReg = (p.tReg & 0xF3FF) | ((v & 0x03) << 10);
  const newNmi = (v & 0x80) !== 0;
  if (newNmi && !oldNmi && p.vblankFlag) {
    p.nmiDelay = 3;
  }
}

/** $2005 PPUSCROLL：双写锁存 w */
export function writeScroll(p: PPUInternal, value: number): void {
  if (!p.wLatch) {
    // 第一次写：fine X = value 低 3 位；coarse X = value 高 5 位 → t bit0-4
    p.fineX = value & 0x07;
    p.tReg = (p.tReg & 0x7FE0) | (value >> 3);
    p.wLatch = true;
  } else {
    // 第二次写：fine Y = value 低 3 位 → t bit12-14；coarse Y = value 高 5 位 → t bit5-9
    p.tReg = (p.tReg & 0x0C1F) | ((value & 0x07) << 12) | ((value & 0xF8) << 2);
    p.wLatch = false;
  }
}

/** $2006 PPUADDR：双写锁存 w；第二次写完成后 v = t 立即生效 */
export function writeAddr(p: PPUInternal, value: number): void {
  if (!p.wLatch) {
    // 第一次写：bit 13-8（高 6 位；bit 14 不可经 $2006 写入，硬件即如此）
    p.tReg = (p.tReg & 0x00FF) | ((value & 0x3F) << 8);
    p.wLatch = true;
  } else {
    // 第二次写：低 8 位，随后 t 全量拷入 v
    p.tReg = (p.tReg & 0x7F00) | value;
    p.vReg = p.tReg;
    p.wLatch = false;
  }
}

/**
 * $2007 PPUDATA 写。
 * - 调色板区：写 palette RAM（经镜像折叠）；硬件同时会用命名表镜像值污染
 *   内部缓冲，本实现同样处理。
 * - 图案表区（$0000-$1FFF）：经 chrWrite 通路转发主板（CHR-RAM 必需；
 *   CHR ROM 由 cartridge 侧静默忽略）。原第二部实现因契约无写通路而丢弃
 *   CHR 写，属契约缺口，集成侧补通路，见 README-偏差记录.md §2.2。
 * - 命名表区：正常写入。
 * 写后 v 按增量位递增。
 */
function writePPUData(p: PPUInternal, value: number): void {
  const addr = p.vReg & 0x3FFF;
  if (addr >= 0x3F00) {
    p.vram.writePal(addr & 0x1F, value);
    p.readBuffer = p.vram.readNametable(addr & 0x2FFF);
  } else if (addr >= 0x2000) {
    p.vram.writeNametable(addr, value);
  } else {
    p.chrWrite?.(addr & 0x1FFF, value);
  }
  p.vReg = (p.vReg + vramIncrement(p)) & 0x7FFF;
}

/**
 * OAM DMA：$4014 写入时由总线调用。
 * 从 OAM[oamAddr] 起环绕写 256 字节；DMA 结束后 oamAddr 不变
 * （硬件上 OAMADDR 递增 256 次后回到原值）。
 */
export function oamDma(p: PPUInternal, page: number, readFn: (addr: number) => number): void {
  const base = (page & 0xFF) << 8;
  for (let i = 0; i < 256; i++) {
    const value = readFn(base + i) & 0xFF;
    p.vram.writeOam(p.oamAddr + i, value);
  }
}
