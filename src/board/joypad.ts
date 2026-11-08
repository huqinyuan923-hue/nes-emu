/**
 * 标准手柄（4021 移位寄存器协议）。
 *
 * CPU 视角：
 *   - 写 $4016：bit0 = strobe。strobe=1 期间连续把当前按键状态装入移位寄存器；
 *     strobe 1→0 的下降沿锁存一次。strobe 恒 1 时读操作永远返回 A 键。
 *   - 读 $4016/$4017：bit0 依次输出 A、B、Select、Start、Up、Down、Left、Right，
 *     读满 8 次后溢出，官方手柄返回 1（第三方返回 0，这里按官方语义）。
 *   - bit1-5 为开总线残留，真机通常读到 0x40，这里补齐 0x40 高位。
 *
 * UI 侧通过 setButtons(mask) 按位设置：bit0=A, bit1=B, bit2=Select,
 * bit3=Start, bit4=Up, bit5=Down, bit6=Left, bit7=Right。
 */
export const JOY_A = 1 << 0;
export const JOY_B = 1 << 1;
export const JOY_SELECT = 1 << 2;
export const JOY_START = 1 << 3;
export const JOY_UP = 1 << 4;
export const JOY_DOWN = 1 << 5;
export const JOY_LEFT = 1 << 6;
export const JOY_RIGHT = 1 << 7;

const READ_ORDER = [
  JOY_A,
  JOY_B,
  JOY_SELECT,
  JOY_START,
  JOY_UP,
  JOY_DOWN,
  JOY_LEFT,
  JOY_RIGHT,
] as const;

export class Joypad {
  /** UI 实时按键位掩码 */
  private buttons = 0;
  /** strobe 锁存后的移位寄存器快照 */
  private latched = 0;
  private strobe = false;
  /** 已移出的位数（0-8），>=8 视为溢出 */
  private shiftPos = 0;

  /** 由输入系统调用：整字覆盖当前按键状态 */
  setButtons(mask: number): void {
    this.buttons = mask & 0xff;
  }

  getButtons(): number {
    return this.buttons;
  }

  /** CPU 写 $4016（P1）/ $4017（P2） */
  write(value: number): void {
    const newStrobe = (value & 1) !== 0;
    if (this.strobe && !newStrobe) {
      // 下降沿：锁存当前按键
      this.latched = this.buttons;
      this.shiftPos = 0;
    }
    this.strobe = newStrobe;
    if (this.strobe) {
      // strobe 保持期间持续重装
      this.latched = this.buttons;
      this.shiftPos = 0;
    }
  }

  /** CPU 读 $4016/$4017，返回值 bit0 有效，高位 0x40 开总线 */
  read(): number {
    let bit: number;
    if (this.strobe) {
      bit = (this.buttons & JOY_A) !== 0 ? 1 : 0; // strobe 恒 1 → 恒返回 A
    } else if (this.shiftPos < 8) {
      bit = (this.latched & READ_ORDER[this.shiftPos]!) !== 0 ? 1 : 0;
      this.shiftPos++;
    } else {
      bit = 1; // 官方手柄溢出后返回 1
    }
    return 0x40 | bit;
  }
}
