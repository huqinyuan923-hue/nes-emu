/**
 * 精灵管线：OAM 扫描评估 → secondary OAM → pattern fetch → 移位输出。
 *
 * 硬件时序：dots 65-256 逐周期扫描 OAM 64 项，dots 257-320 取回至多 8 只
 * 精灵的图案字节。本实现把"评估 + pattern fetch"合并到 dot 257 一次性完成
 * （数据在下一行才被消费，两者间的中间 dot 对外无任何可观察差异，
 * 这是常见且功能等价的简化，已记入 REPORT.md）。
 *
 * 评估规则：
 * - 精灵覆盖行：nextRow - (OAM_y + 1) ∈ [0, 高度)，即 OAM_y 存的是"上移 1 行"
 *   的显示起点（硬件 quirk：y=0 的精灵从屏幕第 1 行开始显示）。
 * - 至多 8 只：按 OAM 序号优先；发现第 9 只时置 overflow 标志并停止评估。
 *   （硬件存在著名的评估 bug：找到 8 只后错误读取 OAM[n+3] 位置导致误报，
 *   任务书允许二期复现，本实现采用正确读法。）
 * - OAM[0] 被选中时记 sprite0InRow（它必然占据 secondary 槽 0，用于
 *   sprite0 hit 判定）。
 *
 * pattern fetch：
 * - 8×8：pattern 表由 $2000 bit3 选；行号 = 覆盖行。
 * - 8×16：pattern 表由 tile 号 bit0 选（$2000 bit3 被忽略，硬件如此）；
 *   tile = (tile号 & 0xFE) + (行 >= 8 ? 1 : 0)；行号 = 行 & 7。
 * - 垂直翻转：行号取 (高度-1-行)。
 * - 水平翻转：fetch 后对两个平面字节做位反转（MSB 先出的移位输出由此对齐）。
 */
import type { PPUInternal } from './state';
import { spriteHeight, spritePatternTable } from './registers';

/** 8 位字节位反转（水平翻转用） */
function reverseBits(b: number): number {
  b = ((b & 0xF0) >> 4) | ((b & 0x0F) << 4);
  b = ((b & 0xCC) >> 2) | ((b & 0x33) << 2);
  b = ((b & 0xAA) >> 1) | ((b & 0x55) << 1);
  return b & 0xFF;
}

/**
 * 为 nextRow 行做精灵评估与 pattern fetch。
 * 调用时机：可见行 0-239 与 pre-render 行 261 的 dot 257（渲染使能时）。
 * pre-render 行 nextRow=0，为屏幕第 0 行准备精灵。
 */
export function evaluateSprites(p: PPUInternal, nextRow: number): void {
  p.secOam.fill(0xFF);
  p.secOamCount = 0;
  p.sprite0InRow = false;
  const h = spriteHeight(p);
  const oam = p.vram.getOam();

  for (let i = 0; i < 64; i++) {
    const base = i * 4;
    const y = oam[base] ?? 0;
    const row = nextRow - y - 1;
    if (row < 0 || row >= h) continue;

    if (p.secOamCount >= 8) {
      // 第 9 只命中：评估终止。溢出标志不再由此置位——dot 时序由
      // spriteEvalTick 逐 pair 检测器负责（修复轮），此处只管渲染槽位。
      break;
    }
    const slot = p.secOamCount * 4;
    p.secOam[slot] = oam[base] ?? 0;
    p.secOam[slot + 1] = oam[base + 1] ?? 0;
    p.secOam[slot + 2] = oam[base + 2] ?? 0;
    p.secOam[slot + 3] = oam[base + 3] ?? 0;
    if (i === 0) p.sprite0InRow = true;
    p.secOamCount++;
  }

  // pattern fetch：为选中的精灵准备移位寄存器
  for (let i = 0; i < 8; i++) {
    if (i >= p.secOamCount) {
      p.sprValid[i] = false;
      continue;
    }
    const slot = i * 4;
    const secY = p.secOam[slot] ?? 0;
    const tile = p.secOam[slot + 1] ?? 0;
    const attr = p.secOam[slot + 2] ?? 0;
    const x = p.secOam[slot + 3] ?? 0;

    const row = nextRow - secY - 1;
    const flipH = (attr & 0x40) !== 0; // bit6：水平翻转
    const flipV = (attr & 0x80) !== 0; // bit7：垂直翻转

    let addr: number;
    let patternRow: number;
    if (h === 16) {
      // 8×16：表选择用 tile bit0；上下半 tile 由覆盖行决定
      const table = (tile & 0x01) !== 0 ? 0x1000 : 0x0000;
      const baseTile = tile & 0xFE;
      patternRow = flipV ? 15 - row : row;
      const tileSel = baseTile + (patternRow >= 8 ? 1 : 0);
      addr = table | (tileSel << 4) | (patternRow & 0x07);
    } else {
      patternRow = flipV ? 7 - row : row;
      addr = spritePatternTable(p) | (tile << 4) | patternRow;
    }

    let lo = p.vram.readChr(addr);
    let hi = p.vram.readChr(addr + 8);
    if (flipH) {
      lo = reverseBits(lo);
      hi = reverseBits(hi);
    }

    p.sprX[i] = x;
    p.sprAttr[i] = attr;
    p.sprLo[i] = lo;
    p.sprHi[i] = hi;
    p.sprValid[i] = true;
  }
}

/**
 * 每个可见渲染 dot 的精灵推进：X 计数器倒计数；计数为 0 后每 dot
 * 左移一位（MSB 先出）。渲染 8 个像素后寄存器自然清零（透明）。
 * 8 位寄存器 + X 计数器模型天然处理 x>248 的右边缘裁剪与 x=255 越界。
 */
export function shiftSprites(p: PPUInternal): void {
  for (let i = 0; i < 8; i++) {
    if (!p.sprValid[i]) continue;
    if ((p.sprX[i] ?? 0) > 0) {
      p.sprX[i] = (p.sprX[i] ?? 0) - 1;
    } else {
      p.sprLo[i] = ((p.sprLo[i] ?? 0) << 1) & 0xFF;
      p.sprHi[i] = ((p.sprHi[i] ?? 0) << 1) & 0xFF;
    }
  }
}

/**
 * 逐 dot 精灵评估检测器（修复轮新增，nesdev wiki「PPU sprite evaluation」）。
 *
 * 硬件在可见行 dots 65-256 以「奇 dot 读 / 偶 dot 写」的 pair 节奏评估 OAM；
 * 溢出标志的置位 dot 由该过程决定（sprite_overflow 3.Timing 要求 ±1-2 CPU
 * clock）。原实现把评估合并到 dot 257 一次性完成（渲染功能等价），但标志
 * 时序不对。本检测器与渲染管线并行运行、只维护溢出标志，不碰渲染槽位。
 *
 * 阶段：
 *   scan（found<8）：pair 内 odd 读 OAM[n][0]，even 判定——在范围则
 *     found++ 并进入 4 字节复制（3 个额外 pair，复制期间 n 不前进）；
 *     out-of-range 则 n++。found==8 → 进入溢出检查（2c：禁写）。
 *   overflow（found==8）：odd 读 OAM[(4n+m)&0xFF]（对角扫描）；even 判定：
 *     在范围 → 置溢出标志并结束；out-of-range → n++ 且 m++（硬件 bug，
 *     wiki 3b「without carry」，产生对角读）→ n 回绕 0 或耗尽 → 结束。
 *
 * 注意：评估只在可见行发生（pre-render 行硬件不评估）；渲染使能
 * （$2001 任一层开）即运行。OAMADDR 非零的硬件刷新 bug 未复现（记 REPORT）。
 */
export function spriteEvalTick(p: PPUInternal): void {
  const d = p.dot;
  if (d < 65 || d > 256) return;
  if (d === 65) {
    p.evalN = 0;
    p.evalM = 0;
    p.evalFound = 0;
    p.evalMode = 0;
    p.evalPending = 0;
    p.evalCopyLeft = 0;
  }
  if (p.evalMode === 2) return;

  const oam = p.vram.getOam();
  const h = spriteHeight(p);
  const line = p.scanline;
  // 硬件范围比较是无借位语义：Y > 扫描行（含 Y=240-255 的"离屏"区）一律不在
  // 范围，不回绕（sprite_overflow 2.Details #7 标定：Y=255 在扫描行 0-6 不置位）
  const inRange = (y: number): boolean => line >= y && line - y < h;

  if ((d & 1) === 1) {
    // 奇 dot：读。扫描阶段读 OAM[n][字节]；复制期间按字节推进；
    // 溢出检查阶段按「对角」读：字节号 = m mod 4（m 与 n 锁步递增）——
    // 精灵 9 的字节 0、10 的字节 1、11 的字节 2……（4.Obscure readme 序列）。
    // 4.Obscure 标定：字面 4n+m 寻址会在 m 回绕后扫进低 OAM 造成假阳性。
    let addr: number;
    if (p.evalMode === 1) {
      addr = (p.evalN * 4 + (p.evalM & 3)) & 0xFF;
    } else if (p.evalCopyLeft > 0) {
      addr = p.evalN * 4 + (4 - p.evalCopyLeft);
    } else {
      addr = p.evalN * 4;
    }
    p.evalPending = oam[addr] ?? 0;
    return;
  }

  // 偶 dot：判定
  if (p.evalMode === 0) {
    // 扫描（found < 8）
    if (p.evalCopyLeft > 0) {
      p.evalCopyLeft--;
      if (p.evalCopyLeft === 0) {
        p.evalN++;
        if (p.evalFound === 8) {
          p.evalMode = 1;
          p.evalM = 0;
        } else if (p.evalN > 63) {
          p.evalMode = 2;
        }
      }
      return;
    }
    if (inRange(p.evalPending)) {
      p.evalFound++;
      p.evalCopyLeft = 3; // 剩余 3 字节占 3 个 pair
      if (p.evalFound === 8) {
        // 第 8 只：复制完 3 字节后进入溢出检查（2c）
      }
    } else {
      p.evalN++;
      if (p.evalN > 63) p.evalMode = 2;
    }
    return;
  }

  // 溢出检查（found == 8）
  if (inRange(p.evalPending)) {
    p.overflowFlag = true; // 置位于本 even dot（3a）
    p.evalMode = 2;
    return;
  }
  // 3b：n++ 且 m++（硬件 bug，对角扫描）；n 回绕 0 → 结束
  p.evalN++;
  p.evalM++;
  if (p.evalN > 63) p.evalMode = 2;
}
