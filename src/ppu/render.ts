/**
 * 像素合成：背景位流 + 精灵位流 + 调色板 → RGBA 帧缓冲。
 *
 * 优先级规则（每可见像素）：
 * 1. 精灵不透明 且 (背景透明 或 精灵优先级=前景) → 精灵色
 * 2. 否则背景不透明 → 背景色
 * 3. 否则 → universal backdrop（$3F00）
 *
 * 调色板索引构造：
 * - 背景：attr<<2 | pattern 两 bit（$3F00 区）
 * - 精灵：0x10 | pal<<2 | pattern 两 bit（$3F10 区）
 * - 索引 0（背景 pattern 0）不查 $3F04（硬件上该单元对背景不可见），
 *   直接用 backdrop，即 $3F00（$3F10 已被镜像折叠到 $3F00）。
 *
 * sprite0 hit 条件（全部满足才置位）：
 * - 精灵槽 0 来自 OAM[0] 且当前像素精灵不透明且背景不透明
 * - 背景与精灵渲染均使能（透明判定隐含了左右 8 像素裁剪）
 * - x != 255（硬件 quirk：最右列不产生 hit）
 */
import type { PPUInternal } from './state';
import { colorLutFor } from './palette';
import { shiftSprites } from './sprites';

/** 渲染一个可见像素（可见行 dots 1-256；x = dot-1），并推进两条移位流水 */
export function renderPixel(p: PPUInternal, x: number): void {
  const bgOn = (p.mask & 0x08) !== 0;
  const sprOn = (p.mask & 0x10) !== 0;
  const showLeftBg = (p.mask & 0x02) !== 0;
  const showLeftSpr = (p.mask & 0x04) !== 0;

  // ---- 背景取样 -----------------------------------------------------------
  let bgPix = 0;
  let bgPal = 0;
  if (bgOn && (showLeftBg || x >= 8)) {
    const bit = 0x8000 >> p.fineX;
    const shLo = p.bgShiftLo;
    const shHi = p.bgShiftHi;
    bgPix = ((shHi & bit) !== 0 ? 2 : 0) | ((shLo & bit) !== 0 ? 1 : 0);
    if (bgPix !== 0) {
      const atLo = p.bgAttrLo;
      const atHi = p.bgAttrHi;
      bgPal = ((atHi & bit) !== 0 ? 2 : 0) | ((atLo & bit) !== 0 ? 1 : 0);
    }
  }

  // ---- 精灵取样（低 index 优先；透明像素让位给后面的精灵） -------------------
  // 热路径：secOamCount === 0（本行无精灵）时整段跳过；数组提升为局部量
  let sprPix = 0;
  let sprPal = 0;
  let sprBehind = false;
  let isSprite0 = false;
  if (sprOn && (showLeftSpr || x >= 8) && p.secOamCount !== 0) {
    const sprX = p.sprX;
    const sprLo = p.sprLo;
    const sprHi = p.sprHi;
    const sprAttr = p.sprAttr;
    const sprValid = p.sprValid;
    const count = p.secOamCount < 8 ? p.secOamCount : 8;
    for (let i = 0; i < count; i++) {
      if (!sprValid[i]) continue;
      if (sprX[i] !== 0) continue;
      const pix = ((sprHi[i]! & 0x80) !== 0 ? 2 : 0) | ((sprLo[i]! & 0x80) !== 0 ? 1 : 0);
      if (pix === 0) continue;
      sprPix = pix;
      sprPal = sprAttr[i]! & 0x03;
      sprBehind = (sprAttr[i]! & 0x20) !== 0; // bit5：0=前景，1=背景后
      isSprite0 = i === 0 && p.sprite0InRow;
      break;
    }
  }

  // ---- sprite0 命中 -------------------------------------------------------
  if (isSprite0 && sprPix !== 0 && bgPix !== 0 && x !== 255) {
    p.sprite0Flag = true;
  }

  // ---- 调色板合成 ---------------------------------------------------------
  let palIndex: number;
  if (sprPix !== 0 && (bgPix === 0 || !sprBehind)) {
    palIndex = 0x10 | (sprPal << 2) | sprPix;
  } else if (bgPix !== 0) {
    palIndex = (bgPal << 2) | bgPix;
  } else {
    palIndex = 0; // universal backdrop（$3F00）
  }

  // 预着色 LUT（按 $2001 懒重建，零分配，见 palette.ts colorLutFor）
  const rgb = colorLutFor(p.mask)[p.vram.readPal(palIndex)] ?? 0;
  const o = (p.scanline * 256 + x) * 4;
  p.fb[o] = (rgb >> 16) & 0xFF;
  p.fb[o + 1] = (rgb >> 8) & 0xFF;
  p.fb[o + 2] = rgb & 0xFF;
  p.fb[o + 3] = 0xFF;

  // ---- 推进移位流水（输出像素后每 dot 一次） --------------------------------
  p.bgShiftLo = (p.bgShiftLo << 1) & 0xFFFF;
  p.bgShiftHi = (p.bgShiftHi << 1) & 0xFFFF;
  p.bgAttrLo = (p.bgAttrLo << 1) & 0xFFFF;
  p.bgAttrHi = (p.bgAttrHi << 1) & 0xFFFF;
  shiftSprites(p);
}

/**
 * 渲染禁用时的可见行像素：输出 backdrop（$3F00）。
 * 硬件 quirk（禁用时输出"v 指向的调色板地址"内容）未复现，见 REPORT.md。
 */
export function renderBackdropPixel(p: PPUInternal, x: number): void {
  const rgb = colorLutFor(p.mask)[p.vram.readPal(0)] ?? 0;
  const o = (p.scanline * 256 + x) * 4;
  p.fb[o] = (rgb >> 16) & 0xFF;
  p.fb[o + 1] = (rgb >> 8) & 0xFF;
  p.fb[o + 2] = rgb & 0xFF;
  p.fb[o + 3] = 0xFF;
}
