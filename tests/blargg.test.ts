/**
 * M6：blargg 测试 ROM（$6000 结果码协议族，新版：0=通过）。
 *
 * 未集成 CPU/PPU（M5 未完成）时整组跳过；ROM 文件缺失时跳过并提示
 * 先跑 `npm run fetch:test-roms`。
 *
 * 必须项：ppu_vbl_nmi 综合 + 10 分项、oam_read、oam_stress。
 * 2005 老协议族（sprite_hit / sprite_overflow / vbl_nmi_timing /
 * blargg_ppu_tests）见 blargg-legacy.test.ts（蜂鸣计码）。
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import {
  createIntegratedMachine,
  isIntegrated,
  loadRomBytes,
  romPath,
  runBlarggRom,
  type BlarggResult,
} from './blargg-harness';

const integrated = isIntegrated();

function romAvailable(rel: string): boolean {
  return existsSync(romPath(rel));
}

/** 断言结果码为 0（新版协议：0=通过，1-0x7F=错误码），失败时附错误消息 */
function expectPass(result: BlarggResult): void {
  const detail = result.message ? ` — ${result.message.trim()}` : '';
  expect(
    result.code,
    `结果码 ${result.code}（0x${result.code.toString(16)}）${detail} [${result.frames} 帧]`,
  ).toBe(0);
}

const conditionalIt = integrated ? it : it.skip;

describe('M6 · blargg ppu_vbl_nmi（VBlank/NMI 全家桶）', () => {
  conditionalIt('综合 ROM：ppu_vbl_nmi.nes（10 子测试，自动按复位推进）', () => {
    const machine = createIntegratedMachine();
    const result = runBlarggRom(machine, loadRomBytes('ppu_vbl_nmi.nes'), { maxFrames: 7200 });
    expectPass(result);
  });

  const singles = [
    'ppu_vbl_nmi/singles/01-vbl_basics.nes',
    'ppu_vbl_nmi/singles/02-vbl_set_time.nes',
    'ppu_vbl_nmi/singles/03-vbl_clear_time.nes',
    'ppu_vbl_nmi/singles/04-nmi_control.nes',
    'ppu_vbl_nmi/singles/05-nmi_timing.nes',
    'ppu_vbl_nmi/singles/06-suppression.nes',
    'ppu_vbl_nmi/singles/07-nmi_on_timing.nes',
    'ppu_vbl_nmi/singles/08-nmi_off_timing.nes',
    'ppu_vbl_nmi/singles/09-even_odd_frames.nes',
    'ppu_vbl_nmi/singles/10-even_odd_timing.nes',
  ];
  for (const single of singles) {
    conditionalIt(`分项：${single}`, () => {
      const machine = createIntegratedMachine();
      expectPass(runBlarggRom(machine, loadRomBytes(single)));
    });
  }
});

describe('M6 · blargg OAM', () => {
  conditionalIt('oam_read', () => {
    const machine = createIntegratedMachine();
    expectPass(runBlarggRom(machine, loadRomBytes('oam_read.nes')));
  });

  conditionalIt('oam_stress', () => {
    const machine = createIntegratedMachine();
    expectPass(runBlarggRom(machine, loadRomBytes('oam_stress.nes'), { maxFrames: 2400 }));
  });
});

describe('M6 · blargg 尽力项（新协议）', () => {
  conditionalIt('cpu_timing_test（可能耗时较长）', () => {
    const machine = createIntegratedMachine();
    expectPass(runBlarggRom(machine, loadRomBytes('cpu_timing_test.nes'), { maxFrames: 3600 }));
  });
});

// 防呆：ROM 缺失时给出明确提示（不作为失败）
describe('M6 · 测试资产', () => {
  it('测试 ROM 已下载（npm run fetch:test-roms）', () => {
    if (!integrated) {
      console.warn('M5 未集成，blargg 套件整体跳过');
      return;
    }
    expect(romAvailable('ppu_vbl_nmi.nes')).toBe(true);
  });
});
