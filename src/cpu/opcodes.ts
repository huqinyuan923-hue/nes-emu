import type { u8 } from '../contract';
import {
  abs, abx, aby, ind, izx, izy, zp, zpx, zpy,
  type Access, type ModeFn,
} from './addressing';
import type { CPU6502Impl } from './CPU6502Impl';
import * as INS from './instructions';

export type ExecFn = (c: CPU6502Impl) => void;

export type AddrMode =
  | 'imp' | 'acc' | 'imm' | 'zp' | 'zpx' | 'zpy' | 'abs' | 'abx' | 'aby'
  | 'ind' | 'izx' | 'izy' | 'rel';

export interface OpcodeInfo {
  op: u8;
  name: string;
  mode: AddrMode;
  access: 'none' | Access;
  /** 指令字节数 */
  len: 1 | 2 | 3;
  /** 基础周期数（不含页跨越/分支惩罚） */
  baseCycles: number;
  /** 是否官方指令（151 个为 true） */
  official: boolean;
  /** 一期实现程度：full=语义完整；nop=按 NOP 家族占位（仅保证时序与不崩） */
  impl: 'full' | 'nop';
}

// ---------------------------------------------------------------------------
// 组合器：把寻址模式与指令操作拼成完整 handler。
// 周期数不硬编码——全部由真实总线访问次数自然累加。
// ---------------------------------------------------------------------------

type ReadOp = (c: CPU6502Impl, v: number) => void;
type RmwOp = (c: CPU6502Impl, v: number) => number;
type ImpOp = (c: CPU6502Impl) => void;

/** 读类：寻址（含哑读）+ 读目标值 */
const rdF = (mode: ModeFn, op: ReadOp): ExecFn => (c) => op(c, c.read8(mode(c, 'r')));

/** 立即数读类 */
const immF = (op: ReadOp): ExecFn => (c) => op(c, c.fetchPC());

/** 写类：寻址（含固定哑读）+ 写寄存器值 */
const wrF = (mode: ModeFn, val: (c: CPU6502Impl) => number): ExecFn => (c) =>
  c.write8(mode(c, 'w'), val(c) & 0xFF);

/** RMW 类：读 → 哑写旧值 → 写新值（对 mapper 计数器敏感的双写） */
const rmwF = (mode: ModeFn, op: RmwOp): ExecFn => (c) => {
  const addr = mode(c, 'rmw');
  const v = c.read8(addr);
  c.write8(addr, v);
  c.write8(addr, op(c, v));
};

/** 累加器操作（第二周期为 PC 哑读） */
const accF = (op: RmwOp): ExecFn => (c) => {
  c.dummyReadPC();
  c.setA(op(c, c.a));
};

/** Implied 操作（第二周期为 PC 哑读） */
const impF = (op: ImpOp): ExecFn => (c) => {
  c.dummyReadPC();
  op(c);
};

/** 分支 */
const brF = (cond: (c: CPU6502Impl) => boolean): ExecFn => (c) => c.branch(cond(c));

// ---------------------------------------------------------------------------
// 表构建
// ---------------------------------------------------------------------------

const execs: ExecFn[] = new Array(256);
const infos: OpcodeInfo[] = [];

function def(
  op: u8, name: string, mode: AddrMode, access: 'none' | Access,
  len: 1 | 2 | 3, baseCycles: number, official: boolean, impl: 'full' | 'nop',
  fn: ExecFn,
): void {
  if (execs[op] !== undefined) throw new Error(`opcode 0x${op.toString(16)} 重复定义`);
  execs[op] = fn;
  infos.push({ op, name, mode, access, len, baseCycles, official, impl });
}

function build(): void {
  // ================= 官方 151 指令 =================

  // ---- 0x0x ----
  def(0x00, 'BRK', 'imp', 'none', 1, 7, true, 'full', (c) => c.brk7());
  def(0x01, 'ORA', 'izx', 'r', 2, 6, true, 'full', rdF(izx, INS.ora));
  def(0x05, 'ORA', 'zp', 'r', 2, 3, true, 'full', rdF(zp, INS.ora));
  def(0x06, 'ASL', 'zp', 'rmw', 2, 5, true, 'full', rmwF(zp, INS.aslOp));
  def(0x08, 'PHP', 'imp', 'none', 1, 3, true, 'full', impF(INS.php));
  def(0x09, 'ORA', 'imm', 'r', 2, 2, true, 'full', immF(INS.ora));
  def(0x0A, 'ASL', 'acc', 'none', 1, 2, true, 'full', accF(INS.aslOp));
  def(0x0D, 'ORA', 'abs', 'r', 3, 4, true, 'full', rdF(abs, INS.ora));
  def(0x0E, 'ASL', 'abs', 'rmw', 3, 6, true, 'full', rmwF(abs, INS.aslOp));
  // ---- 0x1x ----
  def(0x10, 'BPL', 'rel', 'none', 2, 2, true, 'full', brF((c) => (c.p & 0x80) === 0));
  def(0x11, 'ORA', 'izy', 'r', 2, 5, true, 'full', rdF(izy, INS.ora));
  def(0x15, 'ORA', 'zpx', 'r', 2, 4, true, 'full', rdF(zpx, INS.ora));
  def(0x16, 'ASL', 'zpx', 'rmw', 2, 6, true, 'full', rmwF(zpx, INS.aslOp));
  def(0x18, 'CLC', 'imp', 'none', 1, 2, true, 'full', impF(INS.clc));
  def(0x19, 'ORA', 'aby', 'r', 3, 4, true, 'full', rdF(aby, INS.ora));
  def(0x1D, 'ORA', 'abx', 'r', 3, 4, true, 'full', rdF(abx, INS.ora));
  def(0x1E, 'ASL', 'abx', 'rmw', 3, 7, true, 'full', rmwF(abx, INS.aslOp));
  // ---- 0x2x ----
  def(0x20, 'JSR', 'abs', 'none', 3, 6, true, 'full', (c) => c.jsr6());
  def(0x21, 'AND', 'izx', 'r', 2, 6, true, 'full', rdF(izx, INS.and));
  def(0x24, 'BIT', 'zp', 'r', 2, 3, true, 'full', rdF(zp, INS.bitOp));
  def(0x25, 'AND', 'zp', 'r', 2, 3, true, 'full', rdF(zp, INS.and));
  def(0x26, 'ROL', 'zp', 'rmw', 2, 5, true, 'full', rmwF(zp, INS.rolOp));
  def(0x28, 'PLP', 'imp', 'none', 1, 4, true, 'full', impF(INS.plp));
  def(0x29, 'AND', 'imm', 'r', 2, 2, true, 'full', immF(INS.and));
  def(0x2A, 'ROL', 'acc', 'none', 1, 2, true, 'full', accF(INS.rolOp));
  def(0x2C, 'BIT', 'abs', 'r', 3, 4, true, 'full', rdF(abs, INS.bitOp));
  def(0x2D, 'AND', 'abs', 'r', 3, 4, true, 'full', rdF(abs, INS.and));
  def(0x2E, 'ROL', 'abs', 'rmw', 3, 6, true, 'full', rmwF(abs, INS.rolOp));
  // ---- 0x3x ----
  def(0x30, 'BMI', 'rel', 'none', 2, 2, true, 'full', brF((c) => (c.p & 0x80) !== 0));
  def(0x31, 'AND', 'izy', 'r', 2, 5, true, 'full', rdF(izy, INS.and));
  def(0x35, 'AND', 'zpx', 'r', 2, 4, true, 'full', rdF(zpx, INS.and));
  def(0x36, 'ROL', 'zpx', 'rmw', 2, 6, true, 'full', rmwF(zpx, INS.rolOp));
  def(0x38, 'SEC', 'imp', 'none', 1, 2, true, 'full', impF(INS.sec));
  def(0x39, 'AND', 'aby', 'r', 3, 4, true, 'full', rdF(aby, INS.and));
  def(0x3D, 'AND', 'abx', 'r', 3, 4, true, 'full', rdF(abx, INS.and));
  def(0x3E, 'ROL', 'abx', 'rmw', 3, 7, true, 'full', rmwF(abx, INS.rolOp));
  // ---- 0x4x ----
  def(0x40, 'RTI', 'imp', 'none', 1, 6, true, 'full', (c) => c.rti6());
  def(0x41, 'EOR', 'izx', 'r', 2, 6, true, 'full', rdF(izx, INS.eor));
  def(0x45, 'EOR', 'zp', 'r', 2, 3, true, 'full', rdF(zp, INS.eor));
  def(0x46, 'LSR', 'zp', 'rmw', 2, 5, true, 'full', rmwF(zp, INS.lsrOp));
  def(0x48, 'PHA', 'imp', 'none', 1, 3, true, 'full', impF(INS.pha));
  def(0x49, 'EOR', 'imm', 'r', 2, 2, true, 'full', immF(INS.eor));
  def(0x4A, 'LSR', 'acc', 'none', 1, 2, true, 'full', accF(INS.lsrOp));
  def(0x4C, 'JMP', 'abs', 'none', 3, 3, true, 'full', (c) => { c.pc = abs(c); });
  def(0x4D, 'EOR', 'abs', 'r', 3, 4, true, 'full', rdF(abs, INS.eor));
  def(0x4E, 'LSR', 'abs', 'rmw', 3, 6, true, 'full', rmwF(abs, INS.lsrOp));
  // ---- 0x5x ----
  def(0x50, 'BVC', 'rel', 'none', 2, 2, true, 'full', brF((c) => (c.p & 0x40) === 0));
  def(0x51, 'EOR', 'izy', 'r', 2, 5, true, 'full', rdF(izy, INS.eor));
  def(0x55, 'EOR', 'zpx', 'r', 2, 4, true, 'full', rdF(zpx, INS.eor));
  def(0x56, 'LSR', 'zpx', 'rmw', 2, 6, true, 'full', rmwF(zpx, INS.lsrOp));
  def(0x58, 'CLI', 'imp', 'none', 1, 2, true, 'full', impF(INS.cli));
  def(0x59, 'EOR', 'aby', 'r', 3, 4, true, 'full', rdF(aby, INS.eor));
  def(0x5D, 'EOR', 'abx', 'r', 3, 4, true, 'full', rdF(abx, INS.eor));
  def(0x5E, 'LSR', 'abx', 'rmw', 3, 7, true, 'full', rmwF(abx, INS.lsrOp));
  // ---- 0x6x ----
  def(0x60, 'RTS', 'imp', 'none', 1, 6, true, 'full', (c) => c.rts6());
  def(0x61, 'ADC', 'izx', 'r', 2, 6, true, 'full', rdF(izx, INS.adcOp));
  def(0x65, 'ADC', 'zp', 'r', 2, 3, true, 'full', rdF(zp, INS.adcOp));
  def(0x66, 'ROR', 'zp', 'rmw', 2, 5, true, 'full', rmwF(zp, INS.rorOp));
  def(0x68, 'PLA', 'imp', 'none', 1, 4, true, 'full', impF(INS.pla));
  def(0x69, 'ADC', 'imm', 'r', 2, 2, true, 'full', immF(INS.adcOp));
  def(0x6A, 'ROR', 'acc', 'none', 1, 2, true, 'full', accF(INS.rorOp));
  def(0x6C, 'JMP', 'ind', 'none', 3, 5, true, 'full', (c) => { c.pc = ind(c); });
  def(0x6D, 'ADC', 'abs', 'r', 3, 4, true, 'full', rdF(abs, INS.adcOp));
  def(0x6E, 'ROR', 'abs', 'rmw', 3, 6, true, 'full', rmwF(abs, INS.rorOp));
  // ---- 0x7x ----
  def(0x70, 'BVS', 'rel', 'none', 2, 2, true, 'full', brF((c) => (c.p & 0x40) !== 0));
  def(0x71, 'ADC', 'izy', 'r', 2, 5, true, 'full', rdF(izy, INS.adcOp));
  def(0x75, 'ADC', 'zpx', 'r', 2, 4, true, 'full', rdF(zpx, INS.adcOp));
  def(0x76, 'ROR', 'zpx', 'rmw', 2, 6, true, 'full', rmwF(zpx, INS.rorOp));
  def(0x78, 'SEI', 'imp', 'none', 1, 2, true, 'full', impF(INS.sei));
  def(0x79, 'ADC', 'aby', 'r', 3, 4, true, 'full', rdF(aby, INS.adcOp));
  def(0x7D, 'ADC', 'abx', 'r', 3, 4, true, 'full', rdF(abx, INS.adcOp));
  def(0x7E, 'ROR', 'abx', 'rmw', 3, 7, true, 'full', rmwF(abx, INS.rorOp));
  // ---- 0x8x ----
  def(0x81, 'STA', 'izx', 'w', 2, 6, true, 'full', wrF(izx, INS.sta));
  def(0x84, 'STY', 'zp', 'w', 2, 3, true, 'full', wrF(zp, INS.sty));
  def(0x85, 'STA', 'zp', 'w', 2, 3, true, 'full', wrF(zp, INS.sta));
  def(0x86, 'STX', 'zp', 'w', 2, 3, true, 'full', wrF(zp, INS.stx));
  def(0x88, 'DEY', 'imp', 'none', 1, 2, true, 'full', impF(INS.dey));
  def(0x8A, 'TXA', 'imp', 'none', 1, 2, true, 'full', impF(INS.txa));
  def(0x8C, 'STY', 'abs', 'w', 3, 4, true, 'full', wrF(abs, INS.sty));
  def(0x8D, 'STA', 'abs', 'w', 3, 4, true, 'full', wrF(abs, INS.sta));
  def(0x8E, 'STX', 'abs', 'w', 3, 4, true, 'full', wrF(abs, INS.stx));
  // ---- 0x9x ----
  def(0x90, 'BCC', 'rel', 'none', 2, 2, true, 'full', brF((c) => (c.p & 0x01) === 0));
  def(0x91, 'STA', 'izy', 'w', 2, 6, true, 'full', wrF(izy, INS.sta));
  def(0x94, 'STY', 'zpx', 'w', 2, 4, true, 'full', wrF(zpx, INS.sty));
  def(0x95, 'STA', 'zpx', 'w', 2, 4, true, 'full', wrF(zpx, INS.sta));
  def(0x96, 'STX', 'zpy', 'w', 2, 4, true, 'full', wrF(zpy, INS.stx));
  def(0x98, 'TYA', 'imp', 'none', 1, 2, true, 'full', impF(INS.tya));
  def(0x99, 'STA', 'aby', 'w', 3, 5, true, 'full', wrF(aby, INS.sta));
  def(0x9A, 'TXS', 'imp', 'none', 1, 2, true, 'full', impF(INS.txs));
  def(0x9D, 'STA', 'abx', 'w', 3, 5, true, 'full', wrF(abx, INS.sta));
  // ---- 0xAx ----
  def(0xA0, 'LDY', 'imm', 'r', 2, 2, true, 'full', immF(INS.ldy));
  def(0xA1, 'LDA', 'izx', 'r', 2, 6, true, 'full', rdF(izx, INS.lda));
  def(0xA2, 'LDX', 'imm', 'r', 2, 2, true, 'full', immF(INS.ldx));
  def(0xA4, 'LDY', 'zp', 'r', 2, 3, true, 'full', rdF(zp, INS.ldy));
  def(0xA5, 'LDA', 'zp', 'r', 2, 3, true, 'full', rdF(zp, INS.lda));
  def(0xA6, 'LDX', 'zp', 'r', 2, 3, true, 'full', rdF(zp, INS.ldx));
  def(0xA8, 'TAY', 'imp', 'none', 1, 2, true, 'full', impF(INS.tay));
  def(0xA9, 'LDA', 'imm', 'r', 2, 2, true, 'full', immF(INS.lda));
  def(0xAA, 'TAX', 'imp', 'none', 1, 2, true, 'full', impF(INS.tax));
  def(0xAC, 'LDY', 'abs', 'r', 3, 4, true, 'full', rdF(abs, INS.ldy));
  def(0xAD, 'LDA', 'abs', 'r', 3, 4, true, 'full', rdF(abs, INS.lda));
  def(0xAE, 'LDX', 'abs', 'r', 3, 4, true, 'full', rdF(abs, INS.ldx));
  // ---- 0xBx ----
  def(0xB0, 'BCS', 'rel', 'none', 2, 2, true, 'full', brF((c) => (c.p & 0x01) !== 0));
  def(0xB1, 'LDA', 'izy', 'r', 2, 5, true, 'full', rdF(izy, INS.lda));
  def(0xB4, 'LDY', 'zpx', 'r', 2, 4, true, 'full', rdF(zpx, INS.ldy));
  def(0xB5, 'LDA', 'zpx', 'r', 2, 4, true, 'full', rdF(zpx, INS.lda));
  def(0xB6, 'LDX', 'zpy', 'r', 2, 4, true, 'full', rdF(zpy, INS.ldx));
  def(0xB8, 'CLV', 'imp', 'none', 1, 2, true, 'full', impF(INS.clv));
  def(0xB9, 'LDA', 'aby', 'r', 3, 4, true, 'full', rdF(aby, INS.lda));
  def(0xBA, 'TSX', 'imp', 'none', 1, 2, true, 'full', impF(INS.tsx));
  def(0xBC, 'LDY', 'abx', 'r', 3, 4, true, 'full', rdF(abx, INS.ldy));
  def(0xBD, 'LDA', 'abx', 'r', 3, 4, true, 'full', rdF(abx, INS.lda));
  def(0xBE, 'LDX', 'aby', 'r', 3, 4, true, 'full', rdF(aby, INS.ldx));
  // ---- 0xCx ----
  def(0xC0, 'CPY', 'imm', 'r', 2, 2, true, 'full', immF(INS.cpyOp));
  def(0xC1, 'CMP', 'izx', 'r', 2, 6, true, 'full', rdF(izx, INS.cmpOp));
  def(0xC4, 'CPY', 'zp', 'r', 2, 3, true, 'full', rdF(zp, INS.cpyOp));
  def(0xC5, 'CMP', 'zp', 'r', 2, 3, true, 'full', rdF(zp, INS.cmpOp));
  def(0xC6, 'DEC', 'zp', 'rmw', 2, 5, true, 'full', rmwF(zp, INS.decOp));
  def(0xC8, 'INY', 'imp', 'none', 1, 2, true, 'full', impF(INS.iny));
  def(0xC9, 'CMP', 'imm', 'r', 2, 2, true, 'full', immF(INS.cmpOp));
  def(0xCA, 'DEX', 'imp', 'none', 1, 2, true, 'full', impF(INS.dex));
  def(0xCC, 'CPY', 'abs', 'r', 3, 4, true, 'full', rdF(abs, INS.cpyOp));
  def(0xCD, 'CMP', 'abs', 'r', 3, 4, true, 'full', rdF(abs, INS.cmpOp));
  def(0xCE, 'DEC', 'abs', 'rmw', 3, 6, true, 'full', rmwF(abs, INS.decOp));
  // ---- 0xDx ----
  def(0xD0, 'BNE', 'rel', 'none', 2, 2, true, 'full', brF((c) => (c.p & 0x02) === 0));
  def(0xD1, 'CMP', 'izy', 'r', 2, 5, true, 'full', rdF(izy, INS.cmpOp));
  def(0xD5, 'CMP', 'zpx', 'r', 2, 4, true, 'full', rdF(zpx, INS.cmpOp));
  def(0xD6, 'DEC', 'zpx', 'rmw', 2, 6, true, 'full', rmwF(zpx, INS.decOp));
  def(0xD8, 'CLD', 'imp', 'none', 1, 2, true, 'full', impF(INS.cld));
  def(0xD9, 'CMP', 'aby', 'r', 3, 4, true, 'full', rdF(aby, INS.cmpOp));
  def(0xDD, 'CMP', 'abx', 'r', 3, 4, true, 'full', rdF(abx, INS.cmpOp));
  def(0xDE, 'DEC', 'abx', 'rmw', 3, 7, true, 'full', rmwF(abx, INS.decOp));
  // ---- 0xEx ----
  def(0xE0, 'CPX', 'imm', 'r', 2, 2, true, 'full', immF(INS.cpxOp));
  def(0xE1, 'SBC', 'izx', 'r', 2, 6, true, 'full', rdF(izx, INS.sbcOp));
  def(0xE4, 'CPX', 'zp', 'r', 2, 3, true, 'full', rdF(zp, INS.cpxOp));
  def(0xE5, 'SBC', 'zp', 'r', 2, 3, true, 'full', rdF(zp, INS.sbcOp));
  def(0xE6, 'INC', 'zp', 'rmw', 2, 5, true, 'full', rmwF(zp, INS.incOp));
  def(0xE8, 'INX', 'imp', 'none', 1, 2, true, 'full', impF(INS.inx));
  def(0xE9, 'SBC', 'imm', 'r', 2, 2, true, 'full', immF(INS.sbcOp));
  def(0xEA, 'NOP', 'imp', 'none', 1, 2, true, 'full', impF(INS.nop));
  def(0xEC, 'CPX', 'abs', 'r', 3, 4, true, 'full', rdF(abs, INS.cpxOp));
  def(0xED, 'SBC', 'abs', 'r', 3, 4, true, 'full', rdF(abs, INS.sbcOp));
  def(0xEE, 'INC', 'abs', 'rmw', 3, 6, true, 'full', rmwF(abs, INS.incOp));
  // ---- 0xFx ----
  def(0xF0, 'BEQ', 'rel', 'none', 2, 2, true, 'full', brF((c) => (c.p & 0x02) !== 0));
  def(0xF1, 'SBC', 'izy', 'r', 2, 5, true, 'full', rdF(izy, INS.sbcOp));
  def(0xF5, 'SBC', 'zpx', 'r', 2, 4, true, 'full', rdF(zpx, INS.sbcOp));
  def(0xF6, 'INC', 'zpx', 'rmw', 2, 6, true, 'full', rmwF(zpx, INS.incOp));
  def(0xF8, 'SED', 'imp', 'none', 1, 2, true, 'full', impF(INS.sed));
  def(0xF9, 'SBC', 'aby', 'r', 3, 4, true, 'full', rdF(aby, INS.sbcOp));
  def(0xFD, 'SBC', 'abx', 'r', 3, 4, true, 'full', rdF(abx, INS.sbcOp));
  def(0xFE, 'INC', 'abx', 'rmw', 3, 7, true, 'full', rmwF(abx, INS.incOp));

  // ================= 非官方 105 个（一期：NOP 家族 / 简单真实实现） =================
  // 二期目标：全部按在线文档实现并与 nestest 非官方区对拍。

  // KIL（JAM）：真实硬件会停机；一期按 2 周期 1 字节 NOP 处理（有定义行为不崩）
  const kil: Array<u8> = [0x02, 0x12, 0x22, 0x32, 0x42, 0x52, 0x62, 0x72, 0x92, 0xB2, 0xD2, 0xF2];
  for (const op of kil) def(op, 'KIL', 'imp', 'none', 1, 2, false, 'nop', impF(INS.nop));

  // RMW 组合族（SLO/RLA/SRE/RRA/DCP/ISB）：原 nes-cpu 版为「双写原值」占位，
  // 集成时补全真实语义（时序不变：读 → 哑写旧值 → 写新值）。
  // 语义按 nesdev 6502 非官方指令文档，已由 nestest golden log 非官方区全量对拍。
  const sloOp: RmwOp = (c, v) => { const m = INS.aslOp(c, v); INS.ora(c, m); return m; };
  const rlaOp: RmwOp = (c, v) => { const m = INS.rolOp(c, v); INS.and(c, m); return m; };
  const sreOp: RmwOp = (c, v) => { const m = INS.lsrOp(c, v); INS.eor(c, m); return m; };
  const rraOp: RmwOp = (c, v) => { const m = INS.rorOp(c, v); INS.adcOp(c, m); return m; };
  const dcpOp: RmwOp = (c, v) => { const m = INS.decOp(c, v); INS.cmpOp(c, m); return m; };
  const isbOp: RmwOp = (c, v) => { const m = INS.incOp(c, v); INS.sbcOp(c, m); return m; };
  const rmwFamilies: Array<[string, Array<u8>, RmwOp]> = [
    ['SLO', [0x03, 0x07, 0x0F, 0x13, 0x17, 0x1B, 0x1F], sloOp],
    ['RLA', [0x23, 0x27, 0x2F, 0x33, 0x37, 0x3B, 0x3F], rlaOp],
    ['SRE', [0x43, 0x47, 0x4F, 0x53, 0x57, 0x5B, 0x5F], sreOp],
    ['RRA', [0x63, 0x67, 0x6F, 0x73, 0x77, 0x7B, 0x7F], rraOp],
    ['DCP', [0xC3, 0xC7, 0xCF, 0xD3, 0xD7, 0xDB, 0xDF], dcpOp],
    ['ISB', [0xE3, 0xE7, 0xEF, 0xF3, 0xF7, 0xFB, 0xFF], isbOp],
  ];
  const rmwModes: Array<[u8, ModeFn, number, AddrMode]> = [
    [0x03, izx, 8, 'izx'], [0x07, zp, 5, 'zp'], [0x0F, abs, 6, 'abs'],
    [0x13, izy, 8, 'izy'], [0x17, zpx, 6, 'zpx'], [0x1B, aby, 7, 'aby'], [0x1F, abx, 7, 'abx'],
  ];
  for (const [name, ops, rmwOp] of rmwFamilies) {
    for (const op of ops) {
      const [, mode, cycles, modeName] = rmwModes.find(([base]) => (op & 0x1F) === (base & 0x1F))!;
      const len: 1 | 2 | 3 = modeName === 'abs' || modeName === 'abx' || modeName === 'aby' ? 3 : 2;
      def(op, `*${name}`, modeName, 'rmw', len, cycles, false, 'full', rmwF(mode, rmwOp));
    }
  }

  // 简单真实实现的非官方指令
  def(0x0B, '*ANC', 'imm', 'r', 2, 2, false, 'full', immF((c, v) => {
    c.a = (c.a & v) & 0xFF; c.setNZ(c.a); c.setC((c.p & 0x80) !== 0); // C=N
  }));
  def(0x2B, '*ANC', 'imm', 'r', 2, 2, false, 'full', immF((c, v) => {
    c.a = (c.a & v) & 0xFF; c.setNZ(c.a); c.setC((c.p & 0x80) !== 0);
  }));
  def(0x4B, '*ALR', 'imm', 'r', 2, 2, false, 'full', immF((c, v) => {
    c.a = (c.a & v) & 0xFF; c.setA(INS.lsrOp(c, c.a));
  }));
  def(0x6B, '*ARR', 'imm', 'r', 2, 2, false, 'full', immF((c, v) => {
    // ARR（二进制语义）：A=(A&imm) 带进位右移；C=操作前 bit7；V=结果 bit7^bit6
    const t = (c.a & v) & 0xFF;
    const r = ((t >> 1) | (c.p & 0x01 ? 0x80 : 0x00)) & 0xFF;
    c.setC((t & 0x80) !== 0);
    c.setV(((r ^ (r << 1)) & 0x80) !== 0);
    c.a = r; c.setNZ(r);
  }));
  def(0xCB, '*AXS', 'imm', 'r', 2, 2, false, 'full', immF((c, v) => {
    const t = c.a & c.x;
    const r = (t - v) & 0xFF;
    c.setC(t >= v);
    c.x = r; c.setNZ(r);
  }));
  def(0xEB, '*SBC', 'imm', 'r', 2, 2, false, 'full', immF(INS.sbcOp)); // 与 $E9 完全同语义
  const lax = (c: CPU6502Impl, v: number): void => { c.a = v; c.x = v; c.setNZ(v); };
  def(0xA3, '*LAX', 'izx', 'r', 2, 6, false, 'full', rdF(izx, lax));
  def(0xA7, '*LAX', 'zp', 'r', 2, 3, false, 'full', rdF(zp, lax));
  def(0xAB, '*LXA', 'imm', 'r', 2, 2, false, 'full', immF(lax));
  def(0xAF, '*LAX', 'abs', 'r', 3, 4, false, 'full', rdF(abs, lax));
  def(0xB3, '*LAX', 'izy', 'r', 2, 5, false, 'full', rdF(izy, lax));
  def(0xB7, '*LAX', 'zpy', 'r', 2, 4, false, 'full', rdF(zpy, lax));
  // 集成修正（原 nes-cpu 版误标 'abx'）：BF = LAX absolute,Y，nestest golden
  // log 第 5482 行抓出；偏差详见 README-偏差记录.md / REPORT.md
  def(0xBF, '*LAX', 'aby', 'r', 3, 4, false, 'full', rdF(aby, lax));
  def(0x83, '*SAX', 'izx', 'w', 2, 6, false, 'full', wrF(izx, (c) => c.a & c.x));
  def(0x87, '*SAX', 'zp', 'w', 2, 3, false, 'full', wrF(zp, (c) => c.a & c.x));
  def(0x8F, '*SAX', 'abs', 'w', 3, 4, false, 'full', wrF(abs, (c) => c.a & c.x));
  def(0x97, '*SAX', 'zpy', 'w', 2, 4, false, 'full', wrF(zpy, (c) => c.a & c.x));

  // 非官方 NOP 家族（一期完整实现——读取后丢弃，时序与字节数正确）
  def(0x04, '*NOP', 'zp', 'r', 2, 3, false, 'full', rdF(zp, INS.nopRead));
  def(0x44, '*NOP', 'zp', 'r', 2, 3, false, 'full', rdF(zp, INS.nopRead));
  def(0x64, '*NOP', 'zp', 'r', 2, 3, false, 'full', rdF(zp, INS.nopRead));
  def(0x0C, '*NOP', 'abs', 'r', 3, 4, false, 'full', rdF(abs, INS.nopRead));
  for (const op of [0x14, 0x34, 0x54, 0x74, 0xD4, 0xF4]) def(op, '*NOP', 'zpx', 'r', 2, 4, false, 'full', rdF(zpx, INS.nopRead));
  for (const op of [0x1C, 0x3C, 0x5C, 0x7C, 0xDC, 0xFC]) def(op, '*NOP', 'abx', 'r', 3, 4, false, 'full', rdF(abx, INS.nopRead));
  for (const op of [0x80, 0x82, 0x89, 0xC2, 0xE2]) def(op, '*NOP', 'imm', 'r', 2, 2, false, 'full', immF(INS.nopRead));
  for (const op of [0x1A, 0x3A, 0x5A, 0x7A, 0xDA, 0xFA]) def(op, '*NOP', 'imp', 'none', 1, 2, false, 'full', impF(INS.nop));

  // 写型非官方（SHX/SHY/SHA/TAS/LAS/XAA 已含 8B）：一期按读 NOP 占位（写副作用留待二期）
  def(0x9C, '*SHY', 'abx', 'r', 3, 4, false, 'nop', rdF(abx, INS.nopRead));
  def(0x9E, '*SHX', 'aby', 'r', 3, 4, false, 'nop', rdF(aby, INS.nopRead));
  def(0x93, '*SHA', 'izy', 'r', 2, 5, false, 'nop', rdF(izy, INS.nopRead));
  def(0x9F, '*SHA', 'aby', 'r', 3, 4, false, 'nop', rdF(aby, INS.nopRead));
  def(0x9B, '*TAS', 'aby', 'r', 3, 4, false, 'nop', rdF(aby, INS.nopRead));
  def(0xBB, '*LAS', 'aby', 'r', 3, 4, false, 'nop', rdF(aby, INS.nopRead));
  def(0x8B, '*XAA', 'imm', 'r', 2, 2, false, 'nop', immF(INS.nopRead));

  // 完整性自检：256 个 opcode 必须全部有定义
  for (let i = 0; i < 256; i++) {
    if (execs[i] === undefined) throw new Error(`opcode 0x${i.toString(16)} 缺少定义`);
  }
  const official = infos.filter((i) => i.official).length;
  if (official !== 151) throw new Error(`官方指令数应为 151，实际 ${official}`);
}

build();

export const EXEC_TABLE: ReadonlyArray<ExecFn> = execs;
export const OPCODE_INFOS: ReadonlyArray<OpcodeInfo> = infos;

export function buildOpcodeTable(): ReadonlyArray<ExecFn> {
  return EXEC_TABLE;
}
