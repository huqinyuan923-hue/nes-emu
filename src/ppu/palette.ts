/**
 * NTSC 系统调色板与输出色彩处理。
 *
 * 2C02 的 64 项系统调色板是固定 ROM，模拟器需要一张"调色板索引 → RGB"的公认映射表。
 * 本实现采用 OneLoneCoder（olc2C02 教程）所使用的派生表——它是社区广泛流传的
 * NTSC 2C02 近似映射之一（同一张表也被众多教程/简易模拟器采用）。
 * 真实硬件输出依赖 NTSC 信号相位与 CRT 特性，任何 RGB 静态映射都是近似；
 * 选表依据与来源已同步记录在 REPORT.md。
 *
 * 表中部分索引在真实硬件上不可用或为黑色（0x0D 为"超黑陷阱"等），统一填 0x000000。
 * 0x2D/0x3D 在该表中为灰阶条目（0x3C3C3C / 0xA0A2A0）。
 */
export const SYSTEM_PALETTE: readonly number[] = [
  // 0x00-0x0F
  0x54_54_54, 0x00_1E_74, 0x08_10_90, 0x30_00_88, 0x44_00_64, 0x5C_00_30, 0x54_04_00, 0x3C_18_00,
  0x20_2A_00, 0x08_3C_00, 0x00_40_00, 0x00_3C_00, 0x00_32_3C, 0x00_00_00, 0x00_00_00, 0x00_00_00,
  // 0x10-0x1F
  0x98_96_98, 0x08_4C_C4, 0x30_32_EC, 0x5C_1E_E4, 0x88_14_B0, 0xA0_14_64, 0x98_22_20, 0x78_3C_00,
  0x54_5A_00, 0x28_72_00, 0x08_7C_00, 0x00_76_28, 0x00_66_78, 0x00_00_00, 0x00_00_00, 0x00_00_00,
  // 0x20-0x2F
  0xEC_EE_EC, 0x4C_9A_EC, 0x78_7C_EC, 0xB0_62_EC, 0xE4_54_EC, 0xEC_58_B4, 0xEC_6A_64, 0xD4_88_20,
  0xA0_AA_00, 0x74_C4_00, 0x4C_D0_20, 0x38_CC_6C, 0x38_B4_CC, 0x3C_3C_3C, 0x00_00_00, 0x00_00_00,
  // 0x30-0x3F
  0xEC_EE_EC, 0xA8_CC_EC, 0xBC_BC_EC, 0xD4_B2_EC, 0xEC_A6_EC, 0xEC_A6_D4, 0xEC_B2_B0, 0xE4_C4_90,
  0xCC_D2_78, 0xB4_DE_78, 0xA8_E2_90, 0x98_E2_B4, 0xA0_D6_E4, 0xA0_A2_A0, 0x00_00_00, 0x00_00_00,
];

/**
 * 按掩码规则处理一个 RGB 值，返回写入帧缓冲的三元组。
 *
 * - 灰度（PPUMASK bit0）：真实硬件将 NTSC 信号的色度分量置零，RGB 近似为
 *   每通道 & 0x30（业界通行简化）。
 * - 强调色（PPUMASK bit5/6/7 = R/G/B）：真实硬件使 NTSC 相位偏移，无法用简单
 *   逐通道运算精确复现。本实现采用常见近似：未被强调的通道衰减到 75%
 *   （例如强调 R 时 G、B 衰减）。近似导致色偏方向正确但程度偏弱，
 *   已在 REPORT.md 的"已知限制"中记录。
 *
 * @param rgb 系统调色板 RGB 值（0xRRGGBB）
 * @param maskByte PPUMASK（$2001）原始字节
 */
export function colorizePixel(rgb: number, maskByte: number): [number, number, number] {
  let r = (rgb >> 16) & 0xFF;
  let g = (rgb >> 8) & 0xFF;
  let b = rgb & 0xFF;

  if ((maskByte & 0x01) !== 0) {
    // 灰度：优先于强调色处理（硬件上两者同时生效，灰度占主导观感）
    r &= 0x30;
    g &= 0x30;
    b &= 0x30;
  } else {
    const emph = (maskByte >> 5) & 0x07;
    if (emph !== 0) {
      // 强调某通道 = 提亮它 = 其余通道相对变暗（近似为 ×0.75）
      if ((emph & 0x01) === 0) r = (r * 3 / 4) | 0; // 未强调 R
      if ((emph & 0x02) === 0) g = (g * 3 / 4) | 0;
      if ((emph & 0x04) === 0) b = (b * 3 / 4) | 0;
    }
  }
  return [r, g, b];
}

/**
 * 性能关键路径（修复轮优化）：按 $2001 当前值预着色的 64 项查找表。
 *
 * colorizePixel 每像素返回新数组，一帧 6 万次分配造成 GC 压力（基准
 * avg 8.5ms/帧的主要构成）。掩码字节变化频率极低（多数游戏整局不变），
 * 这里按掩码懒重建 0xRRGGBB 打包 LUT，渲染热循环零分配零分支。
 * 语义与 colorizePixel 完全一致（同一套灰度/强调近似规则）。
 */
let lutMaskByte = -1;
const colorLut = new Uint32Array(64); // 0xRRGGBB

export function colorLutFor(maskByte: number): Uint32Array {
  const m = maskByte & 0xFF;
  if (m !== lutMaskByte) {
    for (let i = 0; i < 64; i++) {
      const [r, g, b] = colorizePixel(SYSTEM_PALETTE[i]!, m);
      colorLut[i] = ((r & 0xFF) << 16) | ((g & 0xFF) << 8) | (b & 0xFF);
    }
    lutMaskByte = m;
  }
  return colorLut;
}
