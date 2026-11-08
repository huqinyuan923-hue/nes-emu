/**
 * NTSC 帧驱动：浏览器 rAF 循环，把「每帧 29780.5 CPU 周期」的节奏映射到真实时间。
 *
 * 节拍策略：累积真实经过时间，每满一个帧间隔（1/60.0988 s）执行一帧；
 * 单次 rAF 最多补 3 帧防止页面失焦回来后的螺旋追帧；纯 headless 场景
 * （Node 测试）不用本类，直接调 machine.stepFrame()。
 */
import { CPU_HZ, CPU_CYCLES_PER_FRAME } from '../contract';

/** NTSC 实际刷新率：1789773 / 29780.5 ≈ 60.0988 */
export const NTSC_FPS = CPU_HZ / CPU_CYCLES_PER_FRAME;

/** 纯时序计算：第 frameIndex 帧（0 起）的目标 CPU 周期数（29781/29780 交替） */
export function cyclesForFrame(frameIndex: number): number {
  const target = Math.round((frameIndex + 1) * CPU_CYCLES_PER_FRAME);
  const prev = Math.round(frameIndex * CPU_CYCLES_PER_FRAME);
  return target - prev;
}

export interface FrameDriverOptions {
  /** 执行一帧（含渲染上屏由回调内部完成） */
  stepFrame: () => void;
  /** 每 500ms 上报一次实测帧率 */
  onFps?: (fps: number) => void;
  /** 单次 rAF 最大补帧数，防失焦追帧风暴 */
  maxCatchUp?: number;
}

export class FrameDriver {
  private rafId = 0;
  private running = false;
  private lastTime = 0;
  private accumulator = 0;
  private frameWindowCount = 0;
  private frameWindowStart = 0;
  private readonly maxCatchUp: number;

  constructor(private readonly opts: FrameDriverOptions) {
    this.maxCatchUp = opts.maxCatchUp ?? 3;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
    this.frameWindowCount = 0;
    this.frameWindowStart = this.lastTime;
    const tick = (now: number) => {
      if (!this.running) return;
      const interval = 1000 / NTSC_FPS;
      this.accumulator += now - this.lastTime;
      this.lastTime = now;
      if (this.accumulator > interval * (this.maxCatchUp + 1)) {
        // 落后太多（切页/断点）：丢弃积压，从当前时刻重新起拍
        this.accumulator = interval;
      }
      let ran = 0;
      while (this.accumulator >= interval && ran < this.maxCatchUp) {
        this.opts.stepFrame();
        this.accumulator -= interval;
        ran++;
        this.frameWindowCount++;
      }
      if (this.opts.onFps && now - this.frameWindowStart >= 500) {
        const fps = (this.frameWindowCount * 1000) / (now - this.frameWindowStart);
        this.opts.onFps(Math.round(fps * 10) / 10);
        this.frameWindowCount = 0;
        this.frameWindowStart = now;
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  get isRunning(): boolean {
    return this.running;
  }
}
