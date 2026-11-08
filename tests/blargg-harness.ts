/**
 * blargg 测试 ROM 自动化 harness。
 *
 * 结果协议（blargg 标准新版，见各 ROM readme；任务书原文的「0x01 成功」
 * 为 2005 老约定，新版以官方 readme 为准）：
 *   $6001-$6003 = DE B0 61（签名，判定 PRG-RAM 数据有效）
 *   $6000       = 0x80 运行中；0x81 = 需要按 RESET（多子测试 ROM 用复位推进）；
 *                 0x00-$7F = 完成，0 = 通过，1-0x7F = 错误码
 *   $6004+      = ASCII 错误信息（0 结尾）
 *
 * 任务书必须项 ppu_vbl_nmi.nes 综合版运行中会多次写 0x81 请求复位，
 * harness 检测到后调 machine.reset()（语义等同真机 RESET 键：CPU/PPU 复位、
 * 卡带 mapper 状态保留）继续推进子测试。
 *
 * 2005.09.15b 老版 PPU 测试不走该协议（屏幕显示 + 蜂鸣，1=通过），由
 * tests/blargg-legacy.test.ts 单独处理。
 *
 * 注意：依赖 M5 集成（真实 CPU/PPU）。未集成时 isIntegrated() 为 false，
 * 测试套件整体跳过。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NESMachine } from '../src/board/machine';
import { getMachineFactories } from '../src/board/integration';

export interface BlarggResult {
  /** 结果码：1 = 通过；其他 = 失败；0x80 = 超时未出结果 */
  code: number;
  /** ASCII 消息（可能为空） */
  message: string;
  /** 实际运行的帧数 */
  frames: number;
  /** 是否在帧数上限内得到确定结果 */
  finished: boolean;
}

export const ROM_DIR = join(dirname(fileURLToPath(import.meta.url)), 'roms');

export function romPath(name: string): string {
  return join(ROM_DIR, name);
}

export function loadRomBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(romPath(name)));
}

/** M5 是否已完成（CPU/PPU 已拷入并接线） */
export function isIntegrated(): boolean {
  try {
    getMachineFactories();
    return true;
  } catch {
    return false;
  }
}

export function createIntegratedMachine(): NESMachine {
  return new NESMachine(getMachineFactories());
}

export interface RunOptions {
  /** 帧数上限（默认 1800 ≈ 30 秒模拟时间） */
  maxFrames?: number;
  /** 每次轮询结果的帧间隔（默认 60） */
  pollFrames?: number;
}

/**
 * 运行到结果码稳定或超时。每 pollFrames 帧检查一次 $6000。
 */
export function runBlarggRom(machine: NESMachine, romBytes: Uint8Array, opts: RunOptions = {}): BlarggResult {
  const maxFrames = opts.maxFrames ?? 1800;
  const pollFrames = opts.pollFrames ?? 60;
  machine.loadRom(romBytes);

  let frames = 0;
  let code = 0x80;
  let message = '';
  let finished = false;

  const readStatus = (): { status: number; text: string } => {
    const bus = machine.bus;
    const status = bus.read(0x6000);
    let text = '';
    for (let i = 0; i < 200; i++) {
      const ch = bus.read(0x6004 + i);
      if (ch === 0) break;
      text += String.fromCharCode(ch);
    }
    return { status, text };
  };

  while (frames < maxFrames) {
    for (let i = 0; i < pollFrames; i++) machine.stepFrame();
    frames += pollFrames;
    const { status, text } = readStatus();
    const signatureOk =
      machine.bus.read(0x6001) === 0xde &&
      machine.bus.read(0x6002) === 0xb0 &&
      machine.bus.read(0x6003) === 0x61;
    if (signatureOk && status === 0x81) {
      // 请求按 RESET：模拟复位键推进子测试（CPU/PPU 复位，mapper 保留）
      machine.reset();
      continue;
    }
    if (signatureOk && status < 0x80) {
      code = status;
      message = text;
      finished = true;
      break;
    }
    // status === 0x80 或签名未就绪：继续跑
  }

  return { code, message, frames, finished };
}
