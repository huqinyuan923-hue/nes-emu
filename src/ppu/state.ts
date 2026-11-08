/**
 * PPU 内部状态形状。
 *
 * 所有渲染管线子模块（background / sprites / render / registers）共享同一份
 * PPUInternal 状态对象，模块函数签名统一为 (p: PPUInternal, ...)，避免类继承
 * 或循环依赖。PPU2C02Impl 负责实现契约接口并驱动 cycle() 状态机。
 */
import type { Framebuffer, u8 } from '../contract';
import type { VRAM } from './vram';

export interface PPUInternal {
  // ---- 时序计数器 -------------------------------------------------------
  /** 扫描行：0-239 可见行，240 post-render，241-260 VBlank，261 pre-render */
  scanline: number;
  /** 行内点：0-340（奇数帧跳过 pre-render 的 dot 0） */
  dot: number;
  /** 帧计数（从 0 起；用于奇数帧跳过判定与测试） */
  frame: number;

  // ---- 寄存器原始字节与标志 ---------------------------------------------
  /** $2000 PPUCTRL 原始值 */
  ctrl: u8;
  /** $2001 PPUMASK 原始值 */
  mask: u8;
  /** $2002 bit7：VBlank 进行中 */
  vblankFlag: boolean;
  /** $2002 bit6：sprite0 命中（本帧） */
  sprite0Flag: boolean;
  /** $2002 bit5：精灵溢出（本帧） */
  overflowFlag: boolean;
  /** 写锁存 w：false=第一次写，true=第二次写（$2005/$2006 双写用） */
  wLatch: boolean;
  /** loopy v：当前 VRAM 地址（15 bit，实际寻址用低 14 位） */
  vReg: number;
  /** loopy t：临时 VRAM 地址（15 bit） */
  tReg: number;
  /** loopy x：fine X 滚动（0-7） */
  fineX: number;
  /** $2007 缓冲读的内部缓冲 */
  readBuffer: u8;
  /** $2003 OAMADDR */
  oamAddr: u8;

  // ---- 显存 -------------------------------------------------------------
  vram: VRAM;

  // ---- 背景管线 ----------------------------------------------------------
  /** nametable 字节锁存（fetch 相位 0 读入） */
  bgNtLatch: number;
  /** attribute 字节经象限提取后的 2 bit 属性锁存 */
  bgAtLatch: number;
  /** 图案低/高平面字节锁存 */
  bgPatLoLatch: number;
  bgPatHiLatch: number;
  /** 背景 16 位移位寄存器（高 8 位=正在输出 tile，低 8 位=下一 tile） */
  bgShiftLo: number;
  bgShiftHi: number;
  /** 属性 16 位移位寄存器（0xFF/0x00 重复填充，与图案同步移位） */
  bgAttrLo: number;
  bgAttrHi: number;

  // ---- 精灵管线 ----------------------------------------------------------
  /** secondary OAM 32 字节（本行选中的至多 8 只精灵，每只 4 字节） */
  secOam: Uint8Array;
  /** 本行选中的精灵数量（0-8） */
  secOamCount: number;
  /** OAM[0] 是否在本行被选中（命中判定用；选中时必在 secondary 槽 0） */
  sprite0InRow: boolean;
  /** 8 只精灵的渲染快照：屏幕 X 计数器（倒计数） */
  sprX: Uint8Array;
  /** 8 只精灵的属性字节（palette/优先级，翻转已在 pattern fetch 时应用） */
  sprAttr: Uint8Array;
  /** 8 只精灵的图案低/高平面移位寄存器（8 bit，MSB 先出） */
  sprLo: Uint8Array;
  sprHi: Uint8Array;
  /** 槽位有效性（前 secOamCount 个为 true） */
  sprValid: boolean[];

  // ---- 逐 dot 精灵评估检测器（溢出标志 dot 时序，修复轮新增） ------------
  /** OAM 精灵序号 n（0-63） */
  evalN: number;
  /** 次级 OAM 字节序号 m（0-31，溢出检查的对角扫描用） */
  evalM: number;
  /** 已找到的本行精灵数（0-8） */
  evalFound: number;
  /** 评估阶段：0=扫描（<8 只）1=溢出检查（8 只后）2=完成 */
  evalMode: number;
  /** 奇 dot 读入的待判定字节 */
  evalPending: number;
  /** 扫描阶段在范围精灵的剩余复制字节数（0 = 无复制进行） */
  evalCopyLeft: number;

  // ---- 输出 -------------------------------------------------------------
  /** 256×240 RGBA 帧缓冲（内部复用，getFramebuffer 返回同一 buffer） */
  fb: Framebuffer;

  // ---- 回调 -------------------------------------------------------------
  nmiCallback?: () => void;
  /**
   * CHR 写通路（契约 v1.1 setChrWriter 的实现字段，README-偏差记录.md §2.2）：
   * $2007 写 $0000-$1FFF 时转发给主板 cartridge.chrWrite（CHR-RAM 游戏依赖）。
   */
  chrWrite?: (addr: number, value: number) => void;

  // ---- VBlank 读竞态（契约 v1.1 访问级同步的直接产物，REPORT.md 修复轮 §F3）----
  /** 已喂 dot 绝对计数（每 cycle() +1；调试与竞态诊断用） */
  absDots: number;
  /** 本帧置位点是否被读竞态抑制（(241,1) 消费后复位；pre-render 行亦复位） */
  suppressVblankOnce: boolean;
  /**
   * NMI 输出延迟计数（dot）：硬件 NMI 并非在 VBlank 置位同 dot 拉低，而是
   * 约 2 dots 后输出，且输出时检查 vblankFlag 与 $2000 bit7 仍有效——
   * 读 $2002 清 flag 或关 NMI 会抑制尚未输出的 NMI。
   * 由 06-suppression / 07-nmi_on_timing / 08-nmi_off_timing 期望表联合标定。
   * 0 = 无待输出；>0 = 剩余 dots。
   */
  nmiDelay: number;
}
