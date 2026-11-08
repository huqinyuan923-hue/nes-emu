import type { u8 } from '../contract';
import { B, C, D, I, N, U, V, Z } from './flags';
import type { CPU6502Impl } from './CPU6502Impl';

/** 读取类操作的值参数类型（number 即 u8） */
type u8v = number;

/**
 * 指令级操作。读取类 (c, v) => void；RMW / 累加器类 (c, v) => u8（返回写回值）。
 * 标志位语义细节（以 nesdev wiki 为准）：
 * - 2A03 无十进制模式：ADC/SBC 恒二进制，D 标志只存不作用；
 * - SBC 的 V：同号相减结果异号（等价于 ADC(~v) 的公式）；
 * - BIT 的 N/V 直接来自操作数的 bit7/bit6。
 */

// ---- 装载 ----
export const lda = (c: CPU6502Impl, v: u8v): void => { c.a = v; c.setNZ(v); };
export const ldx = (c: CPU6502Impl, v: u8v): void => { c.x = v; c.setNZ(v); };
export const ldy = (c: CPU6502Impl, v: u8v): void => { c.y = v; c.setNZ(v); };

// ---- 存储 ----
export const sta = (c: CPU6502Impl): number => c.a;
export const stx = (c: CPU6502Impl): number => c.x;
export const sty = (c: CPU6502Impl): number => c.y;

// ---- 传输 ----
export const tax = (c: CPU6502Impl): void => { c.x = c.a; c.setNZ(c.x); };
export const tay = (c: CPU6502Impl): void => { c.y = c.a; c.setNZ(c.y); };
export const txa = (c: CPU6502Impl): void => { c.a = c.x; c.setNZ(c.a); };
export const tya = (c: CPU6502Impl): void => { c.a = c.y; c.setNZ(c.a); };
export const tsx = (c: CPU6502Impl): void => { c.x = c.sp; c.setNZ(c.x); };
export const txs = (c: CPU6502Impl): void => { c.sp = c.x; }; // TXS 不改标志

// ---- 栈 ----
export const pha = (c: CPU6502Impl): void => { c.push8(c.a); };
export const php = (c: CPU6502Impl): void => { c.push8((c.p | U | B) & 0xFF); }; // B 恒 1
// PLA/PLP 为 4 周期：取指 → PC 哑读 → 栈哑读（旧 SP）→ 拉取
export const pla = (c: CPU6502Impl): void => {
  c.read8(0x0100 + c.sp); // 栈哑读
  c.a = c.pull8();
  c.setNZ(c.a);
};
export const plp = (c: CPU6502Impl): void => {
  c.read8(0x0100 + c.sp); // 栈哑读
  c.p = c.pull8Deferred() & ~(U | B); // bit5/bit4 均不入库（呈现时补 bit5）
  c.sampleNow(); // P 已更新后补采样：新 I 对本指令生效（PLP 立即生效语义）
};

// ---- 逻辑 ----
export const and = (c: CPU6502Impl, v: u8v): void => { c.a = (c.a & v) & 0xFF; c.setNZ(c.a); };
export const ora = (c: CPU6502Impl, v: u8v): void => { c.a = (c.a | v) & 0xFF; c.setNZ(c.a); };
export const eor = (c: CPU6502Impl, v: u8v): void => { c.a = (c.a ^ v) & 0xFF; c.setNZ(c.a); };

// ---- 算术 ----
export const adcOp = (c: CPU6502Impl, v: u8v): void => { c.adc(v); };
export const sbcOp = (c: CPU6502Impl, v: u8v): void => { c.sbc(v); };

// ---- 比较 ----
export const cmpOp = (c: CPU6502Impl, v: u8v): void => { c.compare(c.a, v); };
export const cpxOp = (c: CPU6502Impl, v: u8v): void => { c.compare(c.x, v); };
export const cpyOp = (c: CPU6502Impl, v: u8v): void => { c.compare(c.y, v); };

// ---- BIT ----
export const bitOp = (c: CPU6502Impl, v: u8v): void => { c.bit(v); };

// ---- 加 1 / 减 1（寄存器） ----
export const inx = (c: CPU6502Impl): void => { c.x = (c.x + 1) & 0xFF; c.setNZ(c.x); };
export const iny = (c: CPU6502Impl): void => { c.y = (c.y + 1) & 0xFF; c.setNZ(c.y); };
export const dex = (c: CPU6502Impl): void => { c.x = (c.x - 1) & 0xFF; c.setNZ(c.x); };
export const dey = (c: CPU6502Impl): void => { c.y = (c.y - 1) & 0xFF; c.setNZ(c.y); };

// ---- 加 1 / 减 1（内存，RMW） ----
export const incOp = (c: CPU6502Impl, v: u8): number => { const r = (v + 1) & 0xFF; c.setNZ(r); return r; };
export const decOp = (c: CPU6502Impl, v: u8): number => { const r = (v - 1) & 0xFF; c.setNZ(r); return r; };

// ---- 移位（累加器与内存共用） ----
export const aslOp = (c: CPU6502Impl, v: u8): number => {
  c.setC((v & 0x80) !== 0);
  const r = (v << 1) & 0xFF;
  c.setNZ(r);
  return r;
};
export const lsrOp = (c: CPU6502Impl, v: u8): number => {
  c.setC((v & 0x01) !== 0);
  const r = v >> 1;
  c.setNZ(r);
  return r;
};
export const rolOp = (c: CPU6502Impl, v: u8): number => {
  const cIn = c.p & C;
  c.setC((v & 0x80) !== 0);
  const r = ((v << 1) | (cIn ? 1 : 0)) & 0xFF;
  c.setNZ(r);
  return r;
};
export const rorOp = (c: CPU6502Impl, v: u8): number => {
  const cIn = c.p & C;
  c.setC((v & 0x01) !== 0);
  const r = (v >> 1) | (cIn ? 0x80 : 0x00);
  c.setNZ(r);
  return r;
};

// ---- 标志 ----
export const clc = (c: CPU6502Impl): void => { c.p &= ~C; };
export const sec = (c: CPU6502Impl): void => { c.p |= C; };
export const cli = (c: CPU6502Impl): void => { c.p &= ~I; };
export const sei = (c: CPU6502Impl): void => { c.p |= I; };
export const cld = (c: CPU6502Impl): void => { c.p &= ~D; };
export const sed = (c: CPU6502Impl): void => { c.p |= D; };
export const clv = (c: CPU6502Impl): void => { c.p &= ~V; }; // V 只能被清除
export const nop = (_c: CPU6502Impl): void => { /* 无操作 */ };

// ---- 空操作（读取后丢弃，用于一期非官方 NOP 家族） ----
export const nopRead = (_c: CPU6502Impl, _v: u8v): void => { /* 读后丢弃 */ };
/** RMW 型空操作：按 RMW 时序双写原值，语义不变（一期占位，二期替换为真实实现） */
export const nopRmw = (_c: CPU6502Impl, v: u8): number => v;

// ---- 分支条件 ----
export const flagN = (c: CPU6502Impl): boolean => (c.p & N) !== 0;
export const flagZ = (c: CPU6502Impl): boolean => (c.p & Z) !== 0;
export const flagC = (c: CPU6502Impl): boolean => (c.p & C) !== 0;
export const flagV = (c: CPU6502Impl): boolean => (c.p & V) !== 0;
