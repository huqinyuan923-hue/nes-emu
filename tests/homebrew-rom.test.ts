/**
 * 可玩性验收资产：公开许可 homebrew ROM 的解析与卡带构造
 * （游戏运行验收在集成后的浏览器实测完成，见 REPORT.md）。
 *
 * 来源（官方 GitHub Release，GPL 开源，允许再分发）：
 *   - Concentration Room v0.02a（pinobatch/croom-nes，GPL-3.0）——完整可玩翻牌记忆游戏，NROM
 *   - 240p Test Suite v0.23（pinobatch/240p-test-mini，GPL-2.0+）——nesdev 社区标准测试套件，UxROM + NES 2.0 头
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseINes } from '../src/board/ines';
import { createCartridge } from '../src/board/cartridge';

const HERE = dirname(fileURLToPath(import.meta.url));
const homebrew = (name: string) => join(HERE, 'roms', 'homebrew', name);

describe('可玩性验收 ROM（公开许可 homebrew）', () => {
  it('croom.nes：NROM-256，16KB PRG + 8KB CHR + 垂直镜像', () => {
    if (!existsSync(homebrew('croom.nes'))) {
      console.warn('croom.nes 未下载，跳过');
      return;
    }
    const rom = parseINes(new Uint8Array(readFileSync(homebrew('croom.nes'))));
    expect(rom.mapper).toBe(0);
    expect(rom.prg.length).toBe(16384);
    expect(rom.chr!.length).toBe(8192);
    expect(rom.mirroring).toBe('vertical');
    // 卡带可构造，PRG 可读（reset 向量区非全 0）
    const cart = createCartridge(rom);
    const vec = (cart.prgRead(0xfffc) | (cart.prgRead(0xfffd) << 8)) & 0xffff;
    expect(vec).toBeGreaterThan(0x8000); // 合理的复位向量
  });

  it('240pee.nes：NES 2.0 头 + UxROM（64KB PRG + CHR-RAM）宽容解析', () => {
    if (!existsSync(homebrew('240pee.nes'))) {
      console.warn('240pee.nes 未下载，跳过');
      return;
    }
    const rom = parseINes(new Uint8Array(readFileSync(homebrew('240pee.nes'))));
    expect(rom.isNES20).toBe(true);
    expect(rom.mapper).toBe(2);
    expect(rom.prg.length).toBe(65536);
    expect(rom.chr).toBeNull(); // CHR-RAM
    const cart = createCartridge(rom);
    // UxROM：$C000 固定末 bank；CHR-RAM 可写
    cart.chrWrite(0x1234, 0x7e);
    expect(cart.chrRead(0x1234)).toBe(0x7e);
    const vec = (cart.prgRead(0xfffc) | (cart.prgRead(0xfffd) << 8)) & 0xffff;
    expect(vec).toBeGreaterThan(0x8000);
  });
});
