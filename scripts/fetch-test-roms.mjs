/**
 * 测试 ROM 下载脚本：从 christopherpow/nes-test-roms（GitHub 公开仓库）拉取
 * blargg 系列测试 ROM 到 tests/roms/（已 gitignore，不入库）。
 *
 * 用法：npm run fetch:test-roms
 * 已存在的文件跳过（删掉对应文件可强制重下）。
 */
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAW_BASE = 'https://raw.githubusercontent.com/christopherpow/nes-test-roms/master/';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'tests', 'roms');

/** [仓库路径, 本地相对路径] */
const ROMS = [
  // ---- 必须全绿 ----
  ['ppu_vbl_nmi/ppu_vbl_nmi.nes', 'ppu_vbl_nmi.nes'],
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => {
    const names = {
      1: '01-vbl_basics',
      2: '02-vbl_set_time',
      3: '03-vbl_clear_time',
      4: '04-nmi_control',
      5: '05-nmi_timing',
      6: '06-suppression',
      7: '07-nmi_on_timing',
      8: '08-nmi_off_timing',
      9: '09-even_odd_frames',
      10: '10-even_odd_timing',
    };
    return [
      `ppu_vbl_nmi/rom_singles/${names[n]}.nes`,
      `ppu_vbl_nmi/singles/${names[n]}.nes`,
    ];
  }),
  ...[
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
  ].map((n) => [`sprite_hit_tests_2005.10.05/${n}.nes`, `sprite_hit/${n}.nes`]),
  ...[
    '1.Basics',
    '2.Details',
    '3.Timing',
    '4.Obscure',
    '5.Emulator',
  ].map((n) => [`sprite_overflow_tests/${n}.nes`, `sprite_overflow/${n}.nes`]),
  ['blargg_ppu_tests_2005.09.15b/vram_access.nes', 'vram_access.nes'],
  ['blargg_ppu_tests_2005.09.15b/palette_ram.nes', 'palette_ram.nes'],
  ['oam_read/oam_read.nes', 'oam_read.nes'],
  ['oam_stress/oam_stress.nes', 'oam_stress.nes'],
  // ---- 尽力项 ----
  ['blargg_ppu_tests_2005.09.15b/power_up_palette.nes', 'power_up_palette.nes'],
  ['blargg_ppu_tests_2005.09.15b/sprite_ram.nes', 'sprite_ram.nes'],
  ['blargg_ppu_tests_2005.09.15b/vbl_clear_time.nes', 'vbl_clear_time_2005.nes'],
  ['cpu_timing_test6/cpu_timing_test.nes', 'cpu_timing_test.nes'],
  ...[
    '1.frame_basics',
    '2.vbl_timing',
    '3.even_odd_frames',
    '4.vbl_clear_timing',
    '5.nmi_suppression',
    '6.nmi_disable',
    '7.nmi_timing',
  ].map((n) => [`vbl_nmi_timing/${n}.nes`, `vbl_nmi_timing/${n}.nes`]),
  // ---- nestest（图形模式对拍）----
  ['other/nestest.nes', 'nestest.nes'],
  // nestest 官方逐指令 golden trace（qmtpro.com，联调总线与周期基准）
  [
    'https://www.qmtpro.com/~nes/misc/nestest.log',
    'nestest.log',
  ],
  // ---- 可玩性验收（GPL 官方发布件，公开可分发） ----
  [
    'https://github.com/pinobatch/croom-nes/releases/download/v0.02a/croom.nes',
    'homebrew/croom.nes',
  ],
  [
    'https://github.com/pinobatch/240p-test-mini/releases/download/v0.23/240pee.nes',
    'homebrew/240pee.nes',
  ],
];

async function fetchOne(relOrUrl, dest) {
  const url = relOrUrl.startsWith('http') ? relOrUrl : RAW_BASE + relOrUrl;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 16 || buf[0] !== 0x4e) throw new Error('非 iNES 内容');
      const destPath = join(outDir, dest);
      mkdirSync(dirname(destPath), { recursive: true });
      writeFileSync(destPath, buf);
      return buf.length;
    } catch (e) {
      if (attempt === 3) throw new Error(`${dest}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
}

let ok = 0;
let skip = 0;
const failures = [];
for (const [rel, dest] of ROMS) {
  const destPath = join(outDir, dest);
  if (existsSync(destPath)) {
    skip++;
    continue;
  }
  try {
    const size = await fetchOne(rel, dest);
    ok++;
    console.log(`✓ ${dest} (${(size / 1024).toFixed(0)} KB)`);
  } catch (e) {
    failures.push(e.message);
    console.error(`✗ ${e.message}`);
  }
}
console.log(`\n完成：新下载 ${ok}，已存在跳过 ${skip}，失败 ${failures.length}`);
if (failures.length > 0) process.exit(1);
