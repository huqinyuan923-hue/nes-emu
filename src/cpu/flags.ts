/**
 * 6502 状态寄存器 P 的标志位常量。
 * 位序：N V 1 B D I Z C（bit7 → bit0）。
 * 说明：
 * - bit5（U）在物理寄存器中不存在，压栈/呈现时恒为 1（见 CPU6502Impl.getState）。
 * - bit4（B）也没有独立物理位：PHP/BRK 压栈时恒置 1；IRQ/NMI 压栈时恒为 0
 *   （以 nesdev wiki 为准，与任务书要点一节"硬件中断 push P|0x10"的说法相左，
 *   差异记录见 README-偏差记录.md）。内部 P 会保留 PLP/RTI 拉回的 bit4 值
 *   （nestest.log 非官方区可见 P:EF，证明该位可被呈现）。
 */
export const C = 0x01; // 进位
export const Z = 0x02; // 零
export const I = 0x04; // 中断禁止
export const D = 0x08; // 十进制（2A03 上存在但 ADC/SBC 恒按二进制执行）
export const B = 0x10; // 压栈时的 B 标记（无物理位）
export const U = 0x20; // 无用位，压栈/呈现时恒为 1
export const V = 0x40; // 溢出
export const N = 0x80; // 负
