import type { Bus, CPU6502, CpuState, u16, u8 } from '../contract';
import { B, C, I, N, U, V, Z } from './flags';
import { buildOpcodeTable, type ExecFn } from './opcodes';

/**
 * 周期精确的 6502（NES 2A03 核心）实现。
 *
 * 核心思路：把每条指令拆成一串"总线微操作"，每次 read/write 恰好 1 个 CPU 周期，
 * 周期数不再查表硬编码，而是由真实总线访问的次数自然累加——这样 dummy read、
 * RMW 双写、分支惩罚等时序细节在结构上就是对的（mapper 对这些访问敏感）。
 *
 * 中断轮询模型（与 nesdev wiki / Brad Taylor 文档一致）：
 * - 每个总线周期对 NMI/IRQ 线采样一次（tick()）；
 * - 普通指令在"倒数第二周期"的采样决定指令结束后是否进入中断序列；
 * - 被执行的分支在"最后一个周期"轮询：若线是在末周期内才拉高的，
 *   则发生"分支劫持"——分支目标被丢弃，压入跳转前的 PC。
 * - CLI/SEI 对中断屏蔽的生效延迟一条指令（轮询采样发生在 I 变更之前）；
 *   PLP/RTI 则立即生效（采样发生在其末周期，晚于拉栈）。
 */
export class CPU6502Impl implements CPU6502 {
  // ---- 寄存器（内部 P 的 bit5 恒不存储，getState 呈现时补 1）----
  a: u8 = 0;
  x: u8 = 0;
  y: u8 = 0;
  /** 上电 SP=0x00，reset() 后 (0-3)&0xFF = 0xFD */
  sp: u8 = 0x00;
  p: u8 = I;
  pc: u16 = 0;
  /** 复位以来累计 CPU 周期（reset 本身 +7；含 $4014 引发的 OAM DMA 停顿） */
  totalCycles = 0;

  // ---- 中断线与采样历史 ----
  private nmiPending = false; // NMI 请求锁存（服务时清除）
  private irqLine = false; // IRQ 请求锁存（I=1 挂起；服务时清除，电平重断言由主板再次调用 irq()）
  private nmiCur = false; // 本周期采样
  private nmiPrev = false; // 上一周期采样（≈ 倒数第二周期视角）
  private irqCur = false;
  private irqPrev = false;
  private dmaCycles = 0; // 本指令内写 $4014 累积的 OAM DMA 停顿（简化 513，无奇偶 +1）
  private brTaken = false; // 本指令是否为"已执行分支"
  private brOldPC: u16 = 0; // 分支劫持时要压回的 PC（分支指令+2）

  private readonly exec: ReadonlyArray<ExecFn>;
  /** v1.1：本指令第一个周期之前的 totalCycles 值（onAccess 指令内序号基准） */
  private instrStartCycle = 0;

  constructor(private readonly bus: Bus) {
    this.exec = buildOpcodeTable();
  }

  // ================= 契约入口 =================

  /** 复位：SP-3（上电 0x00 → 0xFD）、置 I、经总线取向量 $FFFC/$FFFD，累计 +7 周期 */
  reset(): void {
    this.sp = (this.sp - 3) & 0xFF;
    this.p = I; // 复位后 I=1；其余标志上电为 0
    // 向量读取计入 7 周期总额，不单独记账
    this.instrStartCycle = this.totalCycles;
    const lo = this.bus.read(0xFFFC) & 0xFF;
    const hi = this.bus.read(0xFFFD) & 0xFF;
    this.pc = ((hi << 8) | lo) & 0xFFFF;
    this.totalCycles += 7;
    this.nmiPending = false;
    this.irqLine = false;
  }

  /** 执行一条指令，返回其真实周期数（含页跨越/分支惩罚与 OAM DMA 513 停顿） */
  step(): number {
    const start = this.totalCycles;
    this.instrStartCycle = start;
    this.dmaCycles = 0;
    this.brTaken = false;
    // 指令开始时把采样历史对齐到当前线状态
    this.nmiPrev = this.nmiCur = this.nmiPending;
    this.irqPrev = this.irqCur = this.irqLine && (this.p & I) === 0;

    const opcode = this.read8(this.pc);
    this.pc = (this.pc + 1) & 0xFFFF;
    const fn = this.exec[opcode];
    if (fn === undefined) throw new Error(`未注册 opcode: 0x${opcode.toString(16).padStart(2, '0')}`);
    fn(this);

    // 中断判定：
    // - NMI 看倒数第二周期采样（线在末周期内拉高则推迟到下条指令之后）
    // - IRQ 看末周期采样：CLI/SEI 在末周期之后才改 I，故其效果延迟一条指令；
    //   PLP/RTI 在指令中途拉栈改 I，末周期采样已可见 → 立即生效（nesdev 行为）
    // - 已执行分支看末周期采样，且线在末周期内才拉高时发生"分支劫持"
    const nmiSvc = this.brTaken
      ? (this.nmiCur && this.nmiPending)
      : (this.nmiPrev && this.nmiPending);
    const irqSvc = this.irqCur && this.irqLine;
    if (nmiSvc || irqSvc) {
      let pushPC = this.pc;
      if (this.brTaken) {
        const seenBefore = (this.nmiPrev && this.nmiPending) || (this.irqPrev && this.irqLine);
        if (!seenBefore) pushPC = this.brOldPC; // 劫持：线在末周期内才拉高，丢弃分支目标
      }
      if (nmiSvc) this.doInterrupt('nmi', pushPC);
      else this.doInterrupt('irq', pushPC);
    }

    if (this.dmaCycles) this.totalCycles += this.dmaCycles;
    return this.totalCycles - start;
  }

  /** 请求 NMI（电平请求锁存；服务于下一条指令边界，不受 I 影响） */
  nmi(): void {
    this.nmiPending = true;
  }

  /** 请求 IRQ（电平请求锁存；I=1 时挂起直到被清开；服务时清除锁存） */
  irq(): void {
    this.irqLine = true;
  }

  getState(): CpuState {
    return {
      pc: this.pc,
      a: this.a,
      x: this.x,
      y: this.y,
      sp: this.sp,
      p: (this.p | U) & 0xFF,
      totalCycles: this.totalCycles,
    };
  }

  // ================= 总线微操作（每个恰为 1 周期） =================

  /**
   * v1.1：每次总线访问前回调 onAccess（契约可选；双数字参数零分配）。
   * 访问所占周期的绝对序号 = totalCycles + 1（tick 尚未执行）。
   */
  private notifyAccess(): void {
    this.bus.onAccess?.(this.totalCycles + 1 - this.instrStartCycle, this.totalCycles + 1);
  }

  read8(addr: u16): u8 {
    this.notifyAccess();
    const v = this.bus.read(addr) & 0xFF;
    this.tick();
    return v;
  }

  write8(addr: u16, value: u8): void {
    // OAM DMA：任何指令写 $4014 后本条指令附加 513 周期停顿
    // （幂等：RMW 双写不重复计；简化不做对齐奇偶 +1，见 README-偏差记录.md）
    if (addr === 0x4014) this.dmaCycles = 513;
    this.notifyAccess();
    this.bus.write(addr, value & 0xFF);
    this.tick();
  }

  /** 取 PC 处字节并前移 PC（1 周期） */
  fetchPC(): u8 {
    const v = this.read8(this.pc);
    this.pc = (this.pc + 1) & 0xFFFF;
    return v;
  }

  /** Implied/Accumulator 型指令的第二个周期：在 PC 处做一次哑读 */
  dummyReadPC(): void {
    this.read8(this.pc);
  }

  private tick(): void {
    this.totalCycles++;
    // 每个总线周期对中断线采样一次（供"倒数第二周期轮询"模型使用）
    this.nmiPrev = this.nmiCur;
    this.irqPrev = this.irqCur;
    this.nmiCur = this.nmiPending;
    this.irqCur = this.irqLine && (this.p & I) === 0;
  }

  // ================= 栈 =================

  push8(value: u8): void {
    this.write8(0x0100 + this.sp, value);
    this.sp = (this.sp - 1) & 0xFF; // 仅低 8 位回绕，页固定为第 1 页
  }

  pull8(): u8 {
    this.sp = (this.sp + 1) & 0xFF;
    return this.read8(0x0100 + this.sp);
  }

  /**
   * 拉栈（采样推迟版，PLP 专用）：本周期的中断线采样推迟到调用方更新 P 之后
   * 由 sampleNow() 补做——保证 PLP 载入的 I 对本指令末周期采样可见（立即生效）。
   */
  pull8Deferred(): u8 {
    this.sp = (this.sp + 1) & 0xFF;
    this.notifyAccess();
    const v = this.bus.read(0x0100 + this.sp) & 0xFF;
    this.totalCycles++;
    return v;
  }

  /** 补做一次周期采样（配合 pull8Deferred） */
  sampleNow(): void {
    this.nmiPrev = this.nmiCur;
    this.irqPrev = this.irqCur;
    this.nmiCur = this.nmiPending;
    this.irqCur = this.irqLine && (this.p & I) === 0;
  }

  // ================= 特殊指令序列（周期由微操作次数决定） =================

  /** BRK：7 周期。压 PC+2 与 P|0x30，置 I；NMI 挂起时劫取向量（压栈值仍带 B） */
  brk7(): void {
    this.read8(this.pc); // c2 填充字节（PC 前移）
    this.pc = (this.pc + 1) & 0xFFFF;
    this.push8((this.pc >> 8) & 0xFF); // c3
    this.push8(this.pc & 0xFF); // c4
    this.push8((this.p | U | B) & 0xFF); // c5，B=1
    this.p |= I;
    // NMI 挂起时 BRK 劫取向量（BRK"变成"NMI：消费 NMI 锁存，单序列语义）
    const hijackNmi = this.nmiPending;
    const vec = hijackNmi ? 0xFFFA : 0xFFFE;
    const lo = this.read8(vec);
    const hi = this.read8((vec + 1) & 0xFFFF);
    this.pc = ((hi << 8) | lo) & 0xFFFF;
    if (hijackNmi) this.nmiPending = false;
  }

  /** JSR abs：6 周期。压入"目标高字节所在地址"（= 返回地址-1） */
  jsr6(): void {
    const lo = this.fetchPC(); // c2
    this.read8(0x0100 + this.sp); // c3 内部哑读（栈）
    const ret = this.pc; // 指向指令第 3 字节
    this.push8((ret >> 8) & 0xFF); // c4
    this.push8(ret & 0xFF); // c5
    const hi = this.read8(this.pc); // c6
    this.pc = ((hi << 8) | lo) & 0xFFFF;
  }

  /** RTS：6 周期。弹回 PC 并 +1（末周期在"返回地址-1"处哑读后前移） */
  rts6(): void {
    this.dummyReadPC(); // c2 伪读
    this.read8(0x0100 + this.sp); // c3 栈顶伪读（SP 未变）
    const lo = this.pull8(); // c4
    const hi = this.pull8(); // c5
    const pulled = (hi << 8) | lo;
    this.read8(pulled); // c6 哑读（返回地址-1）
    this.pc = (pulled + 1) & 0xFFFF;
  }

  /** RTI：6 周期。末周期即拉 PCH，无额外哑读（区别于 RTS） */
  rti6(): void {
    this.dummyReadPC(); // c2 伪读
    this.read8(0x0100 + this.sp); // c3 栈顶伪读（SP 未变）
    this.p = this.pull8() & ~(U | B); // c4 弹 P：bit5/bit4 均不入库（呈现时补 bit5）
    const lo = this.pull8(); // c5
    const hi = this.pull8(); // c6
    this.pc = ((hi << 8) | lo) & 0xFFFF;
  }

  /**
   * 分支：2 周期（不跳）/ +1（同页跳）/ +2（跨页跳）。
   * 已执行分支置 brTaken，由 step() 末尾做"末周期轮询"与劫持判定。
   */
  branch(cond: boolean): void {
    const off = this.fetchPC(); // c2
    if (!cond) return;
    const base = this.pc; // 指令+2，即不跳时的下一指令地址（劫持压栈值）
    const rel = off < 0x80 ? off : off - 0x100;
    const target = (base + rel) & 0xFFFF;
    this.read8(base); // c3 伪读
    if ((base & 0xFF00) !== (target & 0xFF00)) {
      this.read8((base & 0xFF00) | (target & 0xFF)); // c4 跨页修正哑读
    }
    this.brTaken = true;
    this.brOldPC = base;
    this.pc = target;
  }

  /** 中断序列：7 周期。两次伪取指 → 压 PCH/PCL/P → 取向量。硬件中断压栈 B=0、bit5=1，并置 I */
  private doInterrupt(kind: 'nmi' | 'irq', pcToPush: u16): void {
    this.read8(this.pc); // c1 伪取指（PC 不前移）
    this.read8(this.pc); // c2 伪取指
    this.push8((pcToPush >> 8) & 0xFF); // c3
    this.push8(pcToPush & 0xFF); // c4
    this.push8((this.p | U) & 0xFF); // c5，B=0（以 nesdev wiki 为准）
    this.p |= I; // IRQ/NMI 序列都置 I
    const vec = kind === 'nmi' ? 0xFFFA : 0xFFFE;
    const lo = this.read8(vec);
    const hi = this.read8((vec + 1) & 0xFFFF);
    this.pc = ((hi << 8) | lo) & 0xFFFF;
    if (kind === 'nmi') this.nmiPending = false;
    else this.irqLine = false;
  }

  // ================= 算术/标志辅助 =================

  setA(v: u8): void {
    this.a = v & 0xFF;
  }

  /** 按结果设置 N/Z */
  setNZ(v: u8): void {
    this.p = (this.p & ~(N | Z)) | (v & N) | (v === 0 ? Z : 0);
  }

  setC(on: boolean): void {
    this.p = on ? this.p | C : this.p & ~C;
  }

  setV(on: boolean): void {
    this.p = on ? this.p | V : this.p & ~V;
  }

  get carry(): boolean {
    return (this.p & C) !== 0;
  }

  /** ADC（2A03 无十进制模式，恒二进制） */
  adc(v: u8): void {
    const c0 = this.p & C ? 1 : 0;
    const sum = this.a + v + c0;
    const carry = sum > 0xFF;
    // 有符号溢出：两操作数同号而结果异号
    const overflow = (~(this.a ^ v) & (this.a ^ sum) & 0x80) !== 0;
    this.p = (this.p & ~(C | V)) | (carry ? C : 0) | (overflow ? V : 0);
    this.a = sum & 0xFF;
    this.setNZ(this.a);
  }

  /** SBC（= ADC(~v)，无十进制） */
  sbc(v: u8): void {
    this.adc((~v) & 0xFF);
  }

  /** CMP/CPX/CPY：按 reg-v 置 C（reg>=v 进位）、N/Z */
  compare(reg: u8, v: u8): void {
    const r = (reg - v) & 0xFF;
    this.setC(reg >= v);
    this.setNZ(r);
  }

  /** BIT：Z=(A&v)==0；N=v 的 bit7；V=v 的 bit6 */
  bit(v: u8): void {
    this.p = (this.p & ~(Z | V | N)) | (v & (V | N)) | ((this.a & v) === 0 ? Z : 0);
  }
}
