/**
 * 背景渲染管线：tile fetch → 移位寄存器 → loopy 滚动维护。
 *
 * 硬件时序（nesdev wiki "PPU rendering"，每扫描行 341 dots）：
 * - dots 1-256 / 321-336：tile fetch 流水，每 8 dots 一个 tile：
 *     相位 0（(dot-1)%8==0）读 nametable 字节
 *     相位 2 读 attribute 字节（并按象限提取 2 bit）
 *     相位 4 读图案低平面
 *     相位 6 读图案高平面
 *     相位 7 结束 → 下一个 8 的倍数 dot 上 reload 移位寄存器并 coarse X++
 * - dots 257-320：精灵评估与 pattern fetch；每 8 dots 一次 dummy nametable 读
 * - dots 337-340：两次 dummy nametable 读（本实现做 dot 337 那一次，
 *   副作用只有 mapper 感知，对 2C02 行为无影响）
 * - dot 256：coarse Y++（含 fine Y 进位、跨 29 行翻命名表）
 * - dot 257：水平滚动复制（t 的 coarseX/NT-X → v）
 * - pre-render 行 dots 280-304：垂直滚动复制（t 的 fineY/coarseY/NT-Y → v）
 *
 * 16 位移位寄存器模型：
 *   高 8 位 = 正在输出 tile 的 8 像素，低 8 位 = 预取 tile。
 *   reload 操作为 sh = ((sh << 8) & 0xFFFF) | latch —— 恰好把"待输出 tile"
 *   顶入高位、新 tile 装入低位。可见行内每输出一个像素整体左移 1 位；
 *   pre-render 行 321/329 两次 reload 后进入可见行时高位恰为 tile0。
 *   fine X 用 (0x8000 >> fineX) 取位，天然支持跨 tile 的无缝水平滚动。
 */
import type { PPUInternal } from './state';
import { bgPatternTable } from './registers';

/** 渲染中的背景 fetch 与滚动维护（可见行与 pre-render 行共用） */
export function bgTick(p: PPUInternal): void {
  const d = p.dot;
  if (d < 1 || d > 340) return;

  // 相位 0：nametable 读（含 257-320 精灵区的 dummy 读与 337 的 dummy 读）
  if (((d - 1) & 7) === 0) {
    p.bgNtLatch = p.vram.readNametable(0x2000 | (p.vReg & 0x0FFF));
  }

  // 完整 fetch 流水：dots 1-256 与 321-336
  if (d <= 256 || (d >= 321 && d <= 336)) {
    switch ((d - 1) & 7) {
      case 2:
        fetchAttribute(p);
        break;
      case 4:
        fetchPatternLow(p);
        break;
      case 6:
        fetchPatternHigh(p);
        break;
    }
  }

  // 8 dot 边界：reload + 滚动增量。
  // reload 语义按"像素时钟是否活跃"区分：
  // - dots 8-248/256：像素移位流活跃，下一 tile 已被移位顶入高位 → 装填低 8 位；
  // - dots 328/336（行尾预取，所有行）：像素时钟已停，寄存器冻结 →
  //   必须把低 8 位（上一 tile）手动顶入高 8 位再装新数据。
  if ((d & 7) === 0) {
    if (d <= 248) {
      reloadShifters(p, false);
      incrementScrollX(p);
    } else if (d === 256) {
      // 行尾：最后一个 tile reload（数据无人消费，保持流水连续），随后垂直增量
      reloadShifters(p, false);
      incrementScrollY(p);
    } else if (d >= 328 && d <= 336) {
      reloadShifters(p, true);
      incrementScrollX(p);
    }
    // dots 264-320（精灵 fetch 区）的边界：背景管线冻结
  }

  // 行中：水平滚动复制
  if (d === 257) {
    copyHorizontal(p);
  }
}

/** attribute 读：地址 0x23C0 | NT | (coarseY>>2)<<3 | (coarseX>>2)，再按象限取 2 bit */
function fetchAttribute(p: PPUInternal): void {
  const v = p.vReg;
  const addr = 0x23C0 | (v & 0x0C00) | ((v >> 4) & 0x38) | ((v >> 2) & 0x07);
  let byte = p.vram.readNametable(addr);
  // 象限：coarse 坐标 bit1 决定 2×2 tile 区块内的上下/左右
  if ((v & 0x40) !== 0) byte >>= 4; // coarse Y bit1 → 下半
  if ((v & 0x02) !== 0) byte >>= 2; // coarse X bit1 → 右半
  p.bgAtLatch = byte & 0x03;
}

/** 图案低平面读：基址 | tile*16 | fineY（v 的 bit12-14） */
function fetchPatternLow(p: PPUInternal): void {
  const addr = bgPatternTable(p) | (p.bgNtLatch << 4) | ((p.vReg >> 12) & 0x07);
  p.bgPatLoLatch = p.vram.readChr(addr);
}

/** 图案高平面读：低平面地址 +8 */
function fetchPatternHigh(p: PPUInternal): void {
  const addr = bgPatternTable(p) | (p.bgNtLatch << 4) | ((p.vReg >> 12) & 0x07);
  p.bgPatHiLatch = p.vram.readChr(addr + 8);
}

/**
 * reload：把锁存的 tile 装入移位寄存器。属性 2 bit 扩展为 0xFF/0x00 的
 * 8 位重复，与图案位流同步移位，取位时与图案共用 (0x8000 >> fineX) 掩码。
 *
 * 两种场景的数据流不同（16 位模型的 reload 语义）：
 * - 可见行（prime=false）：像素时钟持续移位，下一 tile 已被移位流顶入
 *   高 8 位、低 8 位空出 —— 只需装填低 8 位（等价 |=）。
 * - pre-render 行（prime=true）：321-336 fetch 期间没有像素时钟，寄存器
 *   冻结 —— 必须把低 8 位（上一 tile）手动顶入高 8 位再装新数据。
 *   328/336 两次 reload 后进入可见行时高 8 位恰为 tile0。
 */
export function reloadShifters(p: PPUInternal, prime: boolean): void {
  if (prime) {
    p.bgShiftLo = ((p.bgShiftLo & 0x00FF) << 8) | p.bgPatLoLatch;
    p.bgShiftHi = ((p.bgShiftHi & 0x00FF) << 8) | p.bgPatHiLatch;
    p.bgAttrLo = ((p.bgAttrLo & 0x00FF) << 8) | ((p.bgAtLatch & 0x01) !== 0 ? 0xFF : 0x00);
    p.bgAttrHi = ((p.bgAttrHi & 0x00FF) << 8) | ((p.bgAtLatch & 0x02) !== 0 ? 0xFF : 0x00);
  } else {
    p.bgShiftLo = (p.bgShiftLo & 0xFF00) | p.bgPatLoLatch;
    p.bgShiftHi = (p.bgShiftHi & 0xFF00) | p.bgPatHiLatch;
    p.bgAttrLo = (p.bgAttrLo & 0xFF00) | ((p.bgAtLatch & 0x01) !== 0 ? 0xFF : 0x00);
    p.bgAttrHi = (p.bgAttrHi & 0xFF00) | ((p.bgAtLatch & 0x02) !== 0 ? 0xFF : 0x00);
  }
}

/**
 * coarse X 增量（dots 8,16,…,248,328,336）：tile 列 +1，
 * 越过 31 回卷到 0 并翻转水平命名表位（v bit 10）。
 */
export function incrementScrollX(p: PPUInternal): void {
  if ((p.vReg & 0x001F) === 31) {
    p.vReg &= ~0x001F;        // coarse X 归零
    p.vReg ^= 0x0400;         // 翻转 NT-X
  } else {
    p.vReg += 1;
  }
}

/**
 * Y 方向增量（dot 256）：fine Y 先行，进位到 coarse Y；
 * coarse Y 越过 29 回卷到 0 并翻转垂直命名表位（v bit 11）；
 * 硬件上 coarse Y 到 31 是非法值（30/31 为 attribute 表区域），同样回卷但不翻位。
 */
export function incrementScrollY(p: PPUInternal): void {
  if ((p.vReg & 0x7000) !== 0x7000) {
    p.vReg += 0x1000;          // fine Y 未满 7，直接 +1
  } else {
    p.vReg &= ~0x7000;         // fine Y 回零
    const coarseY = (p.vReg >> 5) & 0x1F;
    if (coarseY === 29) {
      p.vReg &= ~0x03E0;       // coarse Y 归零
      p.vReg ^= 0x0800;       // 翻转 NT-Y
    } else if (coarseY === 31) {
      p.vReg &= ~0x03E0;       // 非法区回卷，不翻 NT 位
    } else {
      p.vReg += 0x20;          // coarse Y +1
    }
  }
}

/** 水平复制（dot 257）：t 的 coarseX 与 NT-X 位拷入 v，其余位保持 */
export function copyHorizontal(p: PPUInternal): void {
  p.vReg = (p.vReg & ~0x041F) | (p.tReg & 0x041F);
}

/** 垂直复制（pre-render 行 dots 280-304）：t 的 fineY/coarseY/NT-Y 位拷入 v */
export function copyVertical(p: PPUInternal): void {
  p.vReg = (p.vReg & ~0x7BE0) | (p.tReg & 0x7BE0);
}
