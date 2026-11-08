/**
 * NES 模拟器 · 共享契约 v1.1（冻结文件）
 * 三部共同遵守，禁止修改。缺陷一律写 README-偏差记录.md。
 * 语义注释见任务书附录；NTSC 时序；PPU 寄存器镜像折叠由总线方完成。
 *
 * v1.0 → v1.1（修复轮，仅加法，详见 src/contract-CHANGELOG.md）：
 * - 新增 Bus.onAccess?：CPU 每次总线访问前的子周期定位回调
 * - 新增 BusAccess 载荷接口
 * - 新增 PPU2C02.setChrWriter?：CHR 写通路（CHR-RAM 支持）
 * 全部为可选成员，v1.0 实现零修改兼容。
 */

export type u8 = number;
export type u16 = number;

export const CPU_HZ = 1789773;
export const DOTS_PER_SCANLINE = 341;
export const SCANLINES_PER_FRAME = 262;
export const PPU_DOTS_PER_CPU = 3;
export const CPU_CYCLES_PER_FRAME = 29780.5;
export const SCREEN_W = 256;
export const SCREEN_H = 240;

export interface Bus {
  read(addr: u16): u8;
  write(addr: u16, value: u8): void;
  /** v1.1 可选：CPU 在每次总线访问（读/写，含哑读）发生前回调；
   *  仅当总线实现提供时才被调用。供 dot 级时序（$2002 读竞态等）使用。
   *  参数为双数字（非对象载荷）：回调处于最热路径，必须零分配。
   *  @param cycleInInstruction 指令内周期序号（1 基）
   *  @param cyclesAbsolute 复位以来累计周期序号（1 基绝对值，含 reset 的 7 周期） */
  onAccess?(cycleInInstruction: number, cyclesAbsolute: number): void;
}

export interface CpuState {
  pc: u16;
  a: u8;
  x: u8;
  y: u8;
  sp: u8;
  p: u8;
  totalCycles: number;
}

export interface CPU6502 {
  reset(): void;
  step(): number;
  nmi(): void;
  irq(): void;
  getState(): CpuState;
}

export type Framebuffer = Uint8ClampedArray;

export type Mirroring =
  | 'horizontal'
  | 'vertical'
  | 'four'
  | 'single-lower'
  | 'single-upper';

export interface PPU2C02 {
  reset(): void;
  setChrReader(read: (addr: u16) => u8): void;
  /** v1.1 可选：注入 CHR 写通路（CHR-RAM 支持；未注入时 $2007 对
   *  $0000-$1FFF 的写无效，CHR-ROM 由卡带侧忽略） */
  setChrWriter?(write: (addr: u16, value: u8) => void): void;
  setMirroring(mode: Mirroring): void;
  cycle(): void;
  readReg(index: u8): u8;
  writeReg(index: u8, value: u8): void;
  oamDma(page: u8, readFn: (addr: u16) => u8): void;
  getFramebuffer(): Framebuffer;
}
