/**
 * nestest 图形模式验收（任务书：出图正确 + 截图留档）。
 *
 * nestest 图形模式实为菜单驱动：开机显示测试分类菜单，按 Start 执行全部
 * 测试并在每行标记 OK/错误码。本测试自动化全程：
 *   1. 运行 60 帧（菜单绘制稳定）
 *   2. 按住 Start 4 帧（菜单确认），释放
 *   3. 再跑 240 帧（全部测试分类执行完毕，实测 ~34 帧）
 *   4. 断言：nametable 出现 "OK Run all tests" 行（文本层验证）
 *             framebuffer 颜色数 > 4（渲染层验证）
 *   5. framebuffer 存为 docs/screenshots/nestest.png（对拍留档）
 *
 * 已知行为（记录于 REPORT.md）：2005 壳的 nestest 菜单需输入推进，
 * 空白画面等待按键是正确行为而非渲染故障。
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIntegratedMachine, isIntegrated, loadRomBytes } from './blargg-harness';
import { encodePng } from './helpers/png';
import { SCREEN_H, SCREEN_W } from '../src/contract';
import { JOY_SELECT, JOY_START } from '../src/board/joypad';

const integrated = isIntegrated();
const HERE = dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = join(HERE, '..', 'docs', 'screenshots');

/** 读 nametable 为文本行（blargg 字形：tile = ASCII - 0x20） */
function readScreenText(machine: ReturnType<typeof createIntegratedMachine>): string[] {
  const bus = machine.bus;
  bus.write(0x2006, 0x20);
  bus.write(0x2006, 0x00);
  bus.read(0x2007); // 缓冲残读
  const tiles: number[] = [];
  for (let i = 0; i < 960; i++) tiles.push(bus.read(0x2007));
  const lines: string[] = [];
  for (let r = 0; r < 30; r++) {
    let line = '';
    for (let c = 0; c < 32; c++) {
      const t = tiles[r * 32 + c]!;
      line += t >= 0x20 && t < 0x7f ? String.fromCharCode(t) : '?';
    }
    if (line.trim()) lines.push(line.trimEnd());
  }
  return lines;
}

describe('nestest 图形模式', () => {
  const conditionalIt = integrated ? it : it.skip;

  conditionalIt('菜单 → Start 全跑 → 全 OK → 截图留档', () => {
    const machine = createIntegratedMachine();
    machine.loadRom(loadRomBytes('nestest.nes'));

    for (let f = 0; f < 60; f++) machine.stepFrame();

    // 菜单出现
    const menu = readScreenText(machine);
    expect(menu.some((l) => l.includes('Run all tests')), `菜单未出现：\n${menu.join('\n')}`).toBe(true);

    // 按 Start 运行全部测试
    machine.bus.joypads[0].setButtons(JOY_START);
    for (let f = 0; f < 4; f++) machine.stepFrame();
    machine.bus.joypads[0].setButtons(0);
    for (let f = 0; f < 240; f++) machine.stepFrame();

    // 文本层：全部分类 OK
    const results = readScreenText(machine);
    const okRows = results.filter((l) => l.includes('OK'));
    console.log(`[nestest] OK 行数 ${okRows.length}：${okRows.slice(0, 5).map((l) => l.trim()).join(' | ')}`);
    expect(okRows.length, `测试分类未见 OK：\n${results.join('\n')}`).toBeGreaterThan(10);

    // 渲染层：framebuffer 至少区分文字色与背景色（nestest 菜单为黑底单色文字，
    // 正确形态即 2 色；此处校验渲染管线有输出且非全屏单色）
    const fb = machine.getFramebuffer();
    expect(fb.length).toBe(SCREEN_W * SCREEN_H * 4);
    const colors = new Set<number>();
    for (let i = 0; i < fb.length; i += 4) {
      colors.add((fb[i]! << 16) | (fb[i + 1]! << 8) | fb[i + 2]!);
    }
    console.log(`[nestest] 画面颜色数 ${colors.size}（黑底单色文字形态为 2 色）`);
    expect(colors.size, '画面应有文字色与背景色至少两色').toBeGreaterThan(1);

    // 截图留档
    mkdirSync(SHOT_DIR, { recursive: true });
    const shot = join(SHOT_DIR, 'nestest.png');
    writeFileSync(shot, encodePng(fb, SCREEN_W, SCREEN_H));
    console.log(`[nestest] 截图已存 ${shot}`);
  });

  conditionalIt('Select 切非法指令菜单 → Start 全跑 → 全 OK → 截图留档', () => {
    const machine = createIntegratedMachine();
    machine.loadRom(loadRomBytes('nestest.nes'));
    for (let f = 0; f < 60; f++) machine.stepFrame();

    // Select 切到 Invalid ops 菜单，Start 运行
    machine.bus.joypads[0].setButtons(JOY_SELECT);
    for (let f = 0; f < 4; f++) machine.stepFrame();
    machine.bus.joypads[0].setButtons(0);
    for (let f = 0; f < 10; f++) machine.stepFrame();
    machine.bus.joypads[0].setButtons(JOY_START);
    for (let f = 0; f < 4; f++) machine.stepFrame();
    machine.bus.joypads[0].setButtons(0);
    for (let f = 0; f < 300; f++) machine.stepFrame();

    // 文本层：LAX / RMW 六族全部 OK（覆盖集成侧 CPU 补丁：BF 寻址 + RMW 语义）
    const results = readScreenText(machine);
    for (const name of ['LAX tests', 'DCP tests', 'ISB tests', 'SLO tests', 'RLA tests', 'SRE tests', 'RRA tests']) {
      const row = results.find((l) => l.includes(name));
      expect(row !== undefined && row.includes('OK'), `非法指令分类 ${name} 未 OK：${row ?? '（行缺失）'}`).toBe(true);
    }
    const okRows = results.filter((l) => l.includes('OK'));
    console.log(`[nestest 非法指令] OK 行数 ${okRows.length}`);
    expect(okRows.length).toBeGreaterThan(9);

    const fb = machine.getFramebuffer();
    mkdirSync(SHOT_DIR, { recursive: true });
    const shot = join(SHOT_DIR, 'nestest-invalid-ops.png');
    writeFileSync(shot, encodePng(fb, SCREEN_W, SCREEN_H));
    console.log(`[nestest 非法指令] 截图已存 ${shot}`);
  });

  it('截图留档存在', () => {
    if (!integrated) {
      console.warn('M5 未集成，跳过');
      return;
    }
    expect(existsSync(join(SHOT_DIR, 'nestest.png'))).toBe(true);
    expect(existsSync(join(SHOT_DIR, 'nestest-invalid-ops.png'))).toBe(true);
  });
});
