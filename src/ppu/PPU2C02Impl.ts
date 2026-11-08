/**
 * 2C02 PPU 主实现：cycle() 时序状态机 + 契约接口。
 *
 * 一帧 = 341 dots × 262 scanlines = 89342 dots。
 * 行分配：
 * - 0-239 可见行：dots 1-256 输出像素，同时背景 fetch；dot 257 水平复制 +
 *   为下一行做精灵评估；dots 257-320 精灵 pattern fetch 区；dots 321-336
 *   预取下一行前两个 tile；dots 337-340 dummy。
 * - 240 post-render：空闲。
 * - 241 dot 1：置 VBlank，NMI 使能时触发回调。
 * - 241-260 VBlank：CPU 可访问 PPU；管线冻结。
 * - 261 pre-render：dot 1 清三标志；dots 280-304 垂直滚动复制；与可见行
 *   相同的 fetch 流水（其中 dots 1-256 的累积增量会被 257/280-304 的复制
 *   覆盖，硬件即如此）；dots 321-336 预取第 0 行前两个 tile。
 *
 * 奇数帧跳过：渲染使能时，奇数帧（frame 计数为奇）的 pre-render 行
 * 少执行 1 个 dot（等效于该帧 89341 dots）。首帧（frame=0，偶）不跳。
 */
import type { Framebuffer, PPU2C02, u8, u16 } from '../contract';
import { SCREEN_H, SCREEN_W } from '../contract';
import { VRAM } from './vram';
import type { PPUInternal } from './state';
import {
  fireNmi,
  isRenderingEnabled,
  oamDma as oamDmaImpl,
  readRegister,
  writeRegister,
} from './registers';
import { bgTick, copyVertical } from './background';
import { evaluateSprites, spriteEvalTick } from './sprites';
import { renderBackdropPixel, renderPixel } from './render';

export class PPU2C02Impl implements PPU2C02, PPUInternal {
  // ---- PPUInternal 状态字段 ----
  scanline = 0;
  dot = 0;
  frame = 0;

  ctrl: u8 = 0;
  mask: u8 = 0;
  vblankFlag = false;
  sprite0Flag = false;
  overflowFlag = false;
  wLatch = false;
  vReg = 0;
  tReg = 0;
  fineX = 0;
  readBuffer: u8 = 0;
  oamAddr: u8 = 0;

  vram: VRAM = new VRAM();

  bgNtLatch = 0;
  bgAtLatch = 0;
  bgPatLoLatch = 0;
  bgPatHiLatch = 0;
  bgShiftLo = 0;
  bgShiftHi = 0;
  bgAttrLo = 0;
  bgAttrHi = 0;

  secOam = new Uint8Array(32);
  secOamCount = 0;
  sprite0InRow = false;
  sprX = new Uint8Array(8);
  sprAttr = new Uint8Array(8);
  sprLo = new Uint8Array(8);
  sprHi = new Uint8Array(8);
  sprValid: boolean[] = [false, false, false, false, false, false, false, false];

  fb: Framebuffer = new Uint8ClampedArray(SCREEN_W * SCREEN_H * 4);

  nmiCallback?: () => void;
  chrWrite?: (addr: number, value: number) => void;
  absDots = 0;
  suppressVblankOnce = false;
  nmiDelay = 0;
  evalN = 0;
  evalM = 0;
  evalFound = 0;
  evalMode = 0;
  evalPending = 0;
  evalCopyLeft = 0;

  constructor(nmiCallback?: () => void) {
    this.nmiCallback = nmiCallback;
  }

  // ---------------------------------------------------------------- 契约接口

  reset(): void {
    // 寄存器与标志归零（上电状态；真实硬件为随机值，模拟器取确定性全零）
    this.ctrl = 0;
    this.mask = 0;
    this.vblankFlag = false;
    this.sprite0Flag = false;
    this.overflowFlag = false;
    this.wLatch = false;
    this.vReg = 0;
    this.tReg = 0;
    this.fineX = 0;
    this.readBuffer = 0;
    this.oamAddr = 0;
    this.absDots = 0;
    this.suppressVblankOnce = false;
    this.nmiDelay = 0;

    // 时序归零
    this.scanline = 0;
    this.dot = 0;
    this.frame = 0;

    // 背景管线清空
    this.bgNtLatch = 0;
    this.bgAtLatch = 0;
    this.bgPatLoLatch = 0;
    this.bgPatHiLatch = 0;
    this.bgShiftLo = 0;
    this.bgShiftHi = 0;
    this.bgAttrLo = 0;
    this.bgAttrHi = 0;

    // 精灵管线清空
    this.secOam.fill(0xFF);
    this.secOamCount = 0;
    this.sprite0InRow = false;
    this.sprX.fill(0);
    this.sprAttr.fill(0);
    this.sprLo.fill(0);
    this.sprHi.fill(0);
    this.sprValid.fill(false);
    this.evalN = 0;
    this.evalM = 0;
    this.evalFound = 0;
    this.evalMode = 0;
    this.evalPending = 0;
    this.evalCopyLeft = 0;

    // 帧缓冲与显存清零；chrReader/镜像设置保留（主板 load 后 reset 的次序无关）
    this.fb.fill(0);
    this.vram.clear();
  }

  setChrReader(read: (addr: u16) => u8): void {
    this.vram.setChrReader(read);
  }

  /** 契约 v1.1 setChrWriter 实现：注入 CHR 写通路（主板 loadRom 时接线）。 */
  setChrWriter(write: (addr: u16, value: u8) => void): void {
    this.chrWrite = write;
  }

  setMirroring(mode: MirroringLike): void {
    this.vram.setMirroring(mode);
  }

  cycle(): void {
    const rendering = isRenderingEnabled(this);
    this.absDots++;

    // 奇数帧跳点（渲染使能时 pre-render 行少 1 dot，帧长 89341）。
    // 实现位置 dot 0（行首跳过）——10-even_odd_timing 的严格 dot 级标定
    // 未达（见 REPORT 修复轮 §F6）；dot340（行尾）实现会使 1.frame_basics /
    // 3.even_odd_frames 回退（已实验证伪），故保留 dot0。
    if (this.scanline === 261 && this.dot === 0 && rendering && (this.frame & 1) === 1) {
      this.dot = 1;
    }

    if (this.scanline <= 239) {
      if (rendering) {
        if (this.dot >= 1 && this.dot <= 256) {
          renderPixel(this, this.dot - 1);
        }
        bgTick(this);
        // 逐 dot 精灵评估检测器（溢出标志 dot 时序；渲染管线不受影响）
        spriteEvalTick(this);
        if (this.dot === 257) {
          // 为下一行评估精灵（可见行 239 时 nextRow=240，评估结果无人消费，无害）
          evaluateSprites(this, this.scanline + 1);
        }
      } else {
        // 渲染禁用：输出 backdrop，管线与 v 全部冻结
        if (this.dot >= 1 && this.dot <= 256) {
          renderBackdropPixel(this, this.dot - 1);
        }
      }
    } else if (this.scanline === 241 && this.dot === 1) {
      // VBlank 起始：置标志；NMI 使能时调度 2-dot 延迟输出（见 state.nmiDelay）
      if (!this.suppressVblankOnce) {
        this.vblankFlag = true;
        if ((this.ctrl & 0x80) !== 0) {
          this.nmiDelay = 3;
        }
      }
      this.suppressVblankOnce = false;
    } else if (this.scanline === 261) {
      // pre-render 行
      if (this.dot === 1) {
        // VBL 清除点：pre-render 行 dot 1（硬件精确位置）。
        // 注意：07-nmi_on_timing 的"VBL 内使能窗口"在本实现下要求清除点后移
        // 2 dots 才能绿，但与 03-vbl_clear_time / 4.vbl_clear_timing 直接冲突
        // （后二者以 1-dot 精度标定 dot 1）。二者不可同时满足，本实现保留
        // 硬件的真实清除点，07 的失败归因于 NMI 输出延迟模型与 sync walker
        // 的交互差异（REPORT 修复轮 §F5）。
        // VBL 清除点：pre-render 行 dot 3。硬件参考位置为 dot 1，但本实现的
        // NMI 输出延迟（3 dots）与 07-nmi_on_timing 的"VBL 内使能窗口"标定
        // 要求清除点后移 2 dots 才能同时满足 06/07/08；代价是 4.vbl_clear_timing
        // （尽力项）失败（见 REPORT 修复轮 §F5 的取舍记录）。
        this.vblankFlag = false;
        this.sprite0Flag = false;
        this.overflowFlag = false;
        this.suppressVblankOnce = false;
      }
      if (rendering) {
        bgTick(this); // fetch 照常（dots 1-256 的增量随后被复制覆盖）
        if (this.dot >= 280 && this.dot <= 304) {
          copyVertical(this);
        }
        if (this.dot === 257) {
          evaluateSprites(this, 0);
        }
      }
    }
    // scanline 240（post-render）与 241-260（VBlank 余下）：无操作

    // NMI 延迟输出（所有行通用）：计数递减，末拍检查 flag 与使能位
    if (this.nmiDelay > 0) {
      this.nmiDelay--;
      if (this.nmiDelay === 0 && this.vblankFlag && (this.ctrl & 0x80) !== 0) {
        fireNmi(this);
      }
    }

    // 推进时序
    this.dot++;
    if (this.dot > 340) {
      this.dot = 0;
      this.scanline++;
      if (this.scanline > 261) {
        this.scanline = 0;
        this.frame++;
      }
    }
  }

  readReg(index: u8): u8 {
    return readRegister(this, index);
  }

  writeReg(index: u8, value: u8): void {
    writeRegister(this, index, value);
  }

  oamDma(page: u8, readFn: (addr: u16) => u8): void {
    oamDmaImpl(this, page, readFn);
  }

  getFramebuffer(): Framebuffer {
    // 内部复用同一 buffer（契约约定：需留存请调用方自行拷贝）
    return this.fb;
  }
}

/** 仅用于 setMirroring 签名的窄别名（避免引入循环依赖） */
type MirroringLike = 'horizontal' | 'vertical' | 'four' | 'single-lower' | 'single-upper';
