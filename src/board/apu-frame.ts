/**
 * 2A03 帧计数器（APU frame sequencer 的定时器部分，无音频波形）。
 *
 * 音频 APU 列二期，但 blargg 系测试 ROM 的 shell（sync_apu 例程）用帧计数器
 * 的 IRQ 标志（$4015 bit6）做 CPU 时间基准，没有它 2005 系列测试无法引导。
 * 帧计数器属于主板 $4000-$4017 IO 空间，故由本部实现。
 *
 * 语义（nesdev wiki「APU Frame Counter」）：
 * - $4017 写：bit7 = 模式（0=4-step，1=5-step）；bit6 = IRQ inhibit（1=禁止
 *   帧 IRQ 并清当前标志）。写入会复位序列器分频。
 * - 4-step：每 7457/14913/22371 个 CPU 周期为 quarter/half tick（音频用，
 *   本实现只数数），在 ~29830 周期处置帧 IRQ 标志并拉 IRQ 线（未 inhibit 时），
 *   然后序列器归零重新开始。
 * - 5-step：tick 在 7457/14913/22371/29829/37281，不产生 IRQ。
 * - $4015 读：bit6 = 帧 IRQ 标志（读后清零并释放 IRQ 线）。低 7 位（长度
 *   计数器状态）无音频通道恒 0。
 * - 简化（记录于 REPORT.md）：写 $4017 的 3-4 周期内立即置 IRQ 的硬件
 *   quirk 未复现；序列器对齐按写入时归零处理。
 */
export class FrameCounter {
  /** CPU 周期累计（当前序列器步内） */
  private cycles = 0;
  /** 当前 4/5-step 的目标断点序列（CPU 周期） */
  private mode5 = false;
  private irqInhibit = false;
  private irqFlag = false;

  constructor(private readonly assertIrq: () => void) {}

  /** $4017 写 */
  write(value: number): void {
    this.mode5 = (value & 0x80) !== 0;
    this.irqInhibit = (value & 0x40) !== 0;
    if (this.irqInhibit) {
      this.irqFlag = false;
    }
    // 写入复位序列器
    this.cycles = 0;
  }

  /** $4015 读：返回 bit6 = 帧 IRQ 标志，读后清零 */
  readStatus(): number {
    const bit = this.irqFlag ? 0x40 : 0x00;
    this.irqFlag = false;
    return bit;
  }

  /** 每个 CPU 周期步进（machine 在每条指令后调用 tick(n)） */
  tick(cycles: number): void {
    this.cycles += cycles;
    const breakpoints = this.mode5 ? [37282] : [29830];
    const limit = breakpoints[0]!;
    if (this.cycles >= limit) {
      this.cycles -= limit;
      if (!this.mode5 && !this.irqInhibit) {
        this.irqFlag = true;
        this.assertIrq();
      }
    }
  }
}
