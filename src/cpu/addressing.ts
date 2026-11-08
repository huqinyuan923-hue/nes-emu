import type { u16, u8 } from '../contract';
import type { CPU6502Impl } from './CPU6502Impl';

/** 访问类别：读 / 写 / 读改写（RMW）——决定哑读与附加周期的差异 */
export type Access = 'r' | 'w' | 'rmw';

/** 寻址模式函数：执行该模式全部总线访问（含哑读），返回有效地址 */
export type ModeFn = (c: CPU6502Impl, access: Access) => u16;

/** 立即数：操作数字节本身随取指读入（第二周期），直接返回 PC 形式的"地址"由调用方特判 */
export const imm = (c: CPU6502Impl): u16 => c.fetchPC();

/** 零页 */
export const zp = (c: CPU6502Impl): u16 => c.fetchPC();

/** 零页,X / 零页,Y：先在未加索引的零页地址上做一次哑读，低 8 位回绕 */
const zpxy = (idx: (c: CPU6502Impl) => u8): ModeFn => (c) => {
  const z = c.fetchPC();
  c.read8(z); // 哑读（加 X/Y 前的地址）
  return (z + idx(c)) & 0xFF;
};

export const zpx = zpxy((c) => c.x);
export const zpy = zpxy((c) => c.y);

/** 绝对 */
export const abs = (c: CPU6502Impl): u16 => {
  const lo = c.fetchPC();
  const hi = c.fetchPC();
  return ((hi << 8) | lo) & 0xFFFF;
};

/**
 * 绝对,X / 绝对,Y：
 * - 读指令：仅跨页时多一个周期（在错误页地址上哑读，再读正确地址）；
 * - 写/RMW 指令：无论是否跨页都固定哑读（写 STA abs,X 恒 5 周期、RMW 恒 7 周期）。
 */
const absxy = (idx: (c: CPU6502Impl) => u8): ModeFn => (c, access) => {
  const lo = c.fetchPC();
  const hi = c.fetchPC();
  const base = ((hi << 8) | lo) & 0xFFFF;
  const addr = (base + idx(c)) & 0xFFFF;
  if (access !== 'r' || (addr & 0xFF00) !== (base & 0xFF00)) {
    c.read8((base & 0xFF00) | (addr & 0xFF)); // 哑读（可能落在错误页）
  }
  return addr;
};

export const abx = absxy((c) => c.x);
export const aby = absxy((c) => c.y);

/** (间接,X)：先在指针原址哑读，指针加 X 后按零页回绕取两字节 */
export const izx = (c: CPU6502Impl): u16 => {
  const z = c.fetchPC();
  c.read8(z); // 哑读（加 X 前）
  const p = (z + c.x) & 0xFF;
  const lo = c.read8(p);
  const hi = c.read8((p + 1) & 0xFF);
  return ((hi << 8) | lo) & 0xFFFF;
};

/** (间接),Y：基址两字节取自零页（页内回绕），加 Y 后与 abs,X 同样的哑读规则 */
export const izy = (c: CPU6502Impl, access: Access): u16 => {
  const z = c.fetchPC();
  const lo = c.read8(z);
  const hi = c.read8((z + 1) & 0xFF);
  const base = ((hi << 8) | lo) & 0xFFFF;
  const addr = (base + c.y) & 0xFFFF;
  if (access !== 'r' || (addr & 0xFF00) !== (base & 0xFF00)) {
    c.read8((base & 0xFF00) | (addr & 0xFF)); // 哑读
  }
  return addr;
};

/** JMP (abs) 专用：指针低 8 位回绕 bug——$xxFF 的高字节取自 $xx00 */
export const ind = (c: CPU6502Impl): u16 => {
  const lo = c.fetchPC();
  const hi = c.fetchPC();
  const ptr = ((hi << 8) | lo) & 0xFFFF;
  const l = c.read8(ptr);
  const h = c.read8((ptr & 0xFF00) | ((ptr + 1) & 0xFF)); // 回绕 bug
  return ((h << 8) | l) & 0xFFFF;
};
