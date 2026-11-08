/**
 * 2005 老协议 blargg 测试自动化（蜂鸣计数方案）。
 *
 * 覆盖 ROM 族（16KB PRG + CHR-RAM 的 2005 壳，含任务书必须项
 * sprite_hit_tests_2005.10.05 / sprite_overflow_tests / vram_access / palette_ram）：
 *   - 结果不写 $6000 协议（$6000 区保持全零，壳做 PRG-RAM 探测后放弃写协议；
 *     实测 sprite_hit 01.basics 全程零写入）
 *   - 不在屏幕打印（nametable 全空格）
 *   - 唯一机器可读信号：结果码按次数蜂鸣（2005 老约定：1=通过，2+=失败码）
 *
 * 蜂鸣检测：square1 长度计数器重载 = $4003 写（square2/triangle/noise 为
 * $4007/$400B/$400F，一并用钩子计数；实测 01.basics 恰好 1 次写入 @f30，
 * 与 $F8 结果变量=01 一致）。跑满帧数窗口后统计写入次数 = 结果码。
 *
 * 注意：依赖 M5 集成。未集成时整体跳过。
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NESMachine } from '../src/board/machine';
import { getMachineFactories, } from '../src/board/integration';
import { loadRomBytes, isIntegrated, romPath } from './blargg-harness';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 安装蜂鸣检测钩子：长度计数器重载寄存器（$4003/$4007/$400B/$400F）的写入帧序列 */
function installBeepProbe(machine: NESMachine): number[] {
  const frames: number[] = [];
  const origWrite = machine.bus.write.bind(machine.bus);
  machine.bus.write = (addr: number, value: number) => {
    if (addr === 0x4003 || addr === 0x4007 || addr === 0x400b || addr === 0x400f) {
      frames.push(machine.framesRun);
    }
    origWrite(addr, value);
  };
  return frames;
}

/** 跑满帧数并返回蜂鸣计数（结果码） */
function runLegacyRom(rel: string, frames: number): number {
  const machine = new NESMachine(getMachineFactories());
  const beepFrames = installBeepProbe(machine);
  machine.loadRom(loadRomBytes(rel));
  for (let f = 0; f < frames; f++) machine.stepFrame();
  return beepFrames.length;
}

function expectLegacyPass(rel: string, code: number, frames: number): void {
  expect(
    code,
    `${rel} 结果码（蜂鸣次数）= ${code}，期望 1（2005 老约定 1=通过）`,
  ).toBe(1);
}

const integrated = isIntegrated();
const conditionalIt = integrated ? it : it.skip;

const romAvailable = (rel: string) => existsSync(romPath(rel));

describe('M6 · 2005 老协议族（蜂鸣计码：1=通过）', () => {
  // ---- 任务书必须项 ----
  conditionalIt('vram_access（必须项）', () => {
    const code = runLegacyRom('vram_access.nes', 600);
    expectLegacyPass('vram_access', code, 600);
  });

  conditionalIt('palette_ram（必须项）', () => {
    const code = runLegacyRom('palette_ram.nes', 600);
    expectLegacyPass('palette_ram', code, 600);
  });

  const spriteHit = [
    '01.basics',
    '02.alignment',
    '03.corners',
    '04.flip',
    '05.left_clip',
    '06.right_edge',
    '07.screen_bottom',
    '08.double_height',
    '09.timing_basics',
    '10.timing_order',
    '11.edge_timing',
  ];
  for (const t of spriteHit) {
    conditionalIt(`sprite_hit：${t}（必须项）`, () => {
      expectLegacyPass(t, runLegacyRom(`sprite_hit/${t}.nes`, 600), 600);
    });
  }

  const spriteOverflow = ['1.Basics', '2.Details', '3.Timing', '4.Obscure', '5.Emulator'];
  for (const t of spriteOverflow) {
    conditionalIt(`sprite_overflow：${t}（必须项）`, () => {
      expectLegacyPass(t, runLegacyRom(`sprite_overflow/${t}.nes`, 600), 600);
    });
  }

  // ---- 尽力项 ----
  conditionalIt('sprite_ram（尽力项）', () => {
    expectLegacyPass('sprite_ram', runLegacyRom('sprite_ram.nes', 600), 600);
  });

  conditionalIt('vbl_clear_time 2005（尽力项）', () => {
    expectLegacyPass('vbl_clear_time', runLegacyRom('vbl_clear_time_2005.nes', 600), 600);
  });

  conditionalIt('power_up_palette（尽力项，1=与 blargg 主机一致 2=不一致，均可接受）', () => {
    const code = runLegacyRom('power_up_palette.nes', 600);
    expect(
      code === 1 || code === 2,
      `power_up_palette 结果码 = ${code}（期望 1 或 2）`,
    ).toBe(true);
    console.log(`[power_up_palette] 结果码 ${code}（1=一致 2=不一致）`);
  });

  const vblTiming = [
    '1.frame_basics',
    '2.vbl_timing',
    '3.even_odd_frames',
    '4.vbl_clear_timing',
    '5.nmi_suppression',
    '6.nmi_disable',
    '7.nmi_timing',
  ];
  for (const t of vblTiming) {
    conditionalIt(`vbl_nmi_timing：${t}（尽力项）`, () => {
      if (!romAvailable(join('vbl_nmi_timing', `${t}.nes`))) {
        console.warn(`${t} 未下载，跳过`);
        return;
      }
      expectLegacyPass(t, runLegacyRom(`vbl_nmi_timing/${t}.nes`, 600), 600);
    });
  }

  it('老协议 ROM 资产存在', () => {
    if (!integrated) {
      console.warn('M5 未集成，跳过');
      return;
    }
    expect(romAvailable('vram_access.nes')).toBe(true);
    expect(romAvailable('sprite_hit/01.basics.nes')).toBe(true);
  });
});
