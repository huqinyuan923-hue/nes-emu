/**
 * M1：iNES 解析单元测试（全部使用合成 ROM 字节流）。
 */
import { describe, expect, it } from 'vitest';
import { INesFormatError, parseINes } from '../src/board/ines';
import { buildINes, makePrgBankMarker } from './helpers/rom-builder';
import { createCartridge } from '../src/board/cartridge';

describe('M1 · iNES 头解析', () => {
  it('标准 NROM 头（32KB PRG + 8KB CHR，水平镜像）', () => {
    const rom = parseINes(buildINes({ prgUnits: 2, chrUnits: 1, mapper: 0 }));
    expect(rom.prg.length).toBe(32768);
    expect(rom.chr).not.toBeNull();
    expect(rom.chr!.length).toBe(8192);
    expect(rom.mapper).toBe(0);
    expect(rom.mirroring).toBe('horizontal');
    expect(rom.battery).toBe(false);
    expect(rom.isNES20).toBe(false);
    expect(rom.header.length).toBe(16);
  });

  it('flags6 bit0=1 → 垂直镜像；bit1=1 → 电池', () => {
    const rom = parseINes(buildINes({ verticalMirroring: true, battery: true }));
    expect(rom.mirroring).toBe('vertical');
    expect(rom.battery).toBe(true);
  });

  it('trainer 512 字节被跳过，PRG 从正确偏移开始', () => {
    const bytes = buildINes({ prgUnits: 1, chrUnits: 1, trainer: true });
    const rom = parseINes(bytes);
    expect(rom.prg.length).toBe(16384);
    // 第 16+512 字节应是 PRG bank0 的标记
    expect(rom.prg[0]).toBe(makePrgBankMarker(0));
    // trainer 区域不应混入 PRG
    expect(bytes[16]).not.toBe(makePrgBankMarker(0));
  });

  it('mapper 高位来自 flags7（mapper 3 = CNROM）', () => {
    const rom = parseINes(buildINes({ mapper: 3 }));
    expect(rom.mapper).toBe(3);
  });

  it('mapper 1 = MMC1', () => {
    expect(parseINes(buildINes({ mapper: 1 })).mapper).toBe(1);
  });

  it('NES 2.0 识别：mapper 高位取 flags8', () => {
    // mapper = 0x105 → flags6 高 4 位 = 5，flags7 高 4 位 = 1，flags8 低 4 位 = 1
    const bytes = buildINes({ mapper: 0x105, nes20: true });
    const rom = parseINes(bytes);
    expect(rom.isNES20).toBe(true);
    expect(rom.mapper).toBe(0x105);
  });

  it('四屏镜像标志优先于 bit0', () => {
    const rom = parseINes(buildINes({ fourScreen: true, verticalMirroring: true }));
    expect(rom.fourScreen).toBe(true);
    expect(rom.mirroring).toBe('four');
  });

  it('chrUnits=0 → CHR-RAM（chr 为 null）', () => {
    const rom = parseINes(buildINes({ chrUnits: 0 }));
    expect(rom.chr).toBeNull();
  });

  it('魔数错误抛 INesFormatError', () => {
    const bytes = buildINes();
    bytes[1] = 0x58; // 'X'
    expect(() => parseINes(bytes)).toThrow(INesFormatError);
  });

  it('文件 <16 字节抛 INesFormatError', () => {
    expect(() => parseINes(new Uint8Array(4))).toThrow(INesFormatError);
  });

  it('文件截断（PRG+CHR 声明容量超出实际）抛 INesFormatError', () => {
    const bytes = buildINes({ prgUnits: 2, chrUnits: 1 });
    const truncated = bytes.slice(0, 16 + 32768); // 剁掉 CHR
    expect(() => parseINes(truncated)).toThrow(INesFormatError);
  });
});

describe('M1 · NROM mapper（合成 ROM）', () => {
  it('16KB PRG：$8000 与 $C000 镜像同一 bank', () => {
    const cart = createCartridge(parseINes(buildINes({ prgUnits: 1, mapper: 0 })));
    const marker = makePrgBankMarker(0);
    expect(cart.prgRead(0x8000)).toBe(marker);
    expect(cart.prgRead(0xbfff)).toBe(marker);
    expect(cart.prgRead(0xc000)).toBe(marker);
    expect(cart.prgRead(0xffff)).toBe(marker);
  });

  it('32KB PRG：$8000-$BFFF bank0，$C000-$FFFF bank1', () => {
    const cart = createCartridge(parseINes(buildINes({ prgUnits: 2, mapper: 0 })));
    expect(cart.prgRead(0x8000)).toBe(makePrgBankMarker(0));
    expect(cart.prgRead(0xbfff)).toBe(makePrgBankMarker(0));
    expect(cart.prgRead(0xc000)).toBe(makePrgBankMarker(1));
    expect(cart.prgRead(0xffff)).toBe(makePrgBankMarker(1));
  });

  it('CHR ROM 读取按填充约定（4KB chunk 标记）', () => {
    const cart = createCartridge(parseINes(buildINes({ chrUnits: 1 })));
    expect(cart.chrRead(0x0000)).toBe(0x80);
    expect(cart.chrRead(0x0fff)).toBe(0x80);
    expect(cart.chrRead(0x1000)).toBe(0x81);
    expect(cart.chrRead(0x1fff)).toBe(0x81);
  });

  it('CHR ROM 写入被忽略', () => {
    const cart = createCartridge(parseINes(buildINes({ chrUnits: 1 })));
    cart.chrWrite(0x0000, 0x42);
    expect(cart.chrRead(0x0000)).toBe(0x80);
  });

  it('CHR-RAM（chrUnits=0）：写入后可读回', () => {
    const cart = createCartridge(parseINes(buildINes({ chrUnits: 0 })));
    cart.chrWrite(0x0123, 0x42);
    expect(cart.chrRead(0x0123)).toBe(0x42);
  });

  it('PRG-RAM $6000-$7FFF 可读写（测试 ROM 结果协议依赖）', () => {
    const cart = createCartridge(parseINes(buildINes()));
    cart.prgRamWrite(0x6000, 0x80);
    cart.prgRamWrite(0x6004, 0x41); // 'A'
    expect(cart.prgRamRead(0x6000)).toBe(0x80);
    expect(cart.prgRamRead(0x6004)).toBe(0x41);
    // 镜像语义：$7FFF 内 8KB 线性（无折叠），边界外不越界
    expect(cart.prgRamRead(0x7fff)).toBe(0);
  });

  it('写 $8000-$FFFF（无寄存器 mapper）不产生效果也不抛错', () => {
    const cart = createCartridge(parseINes(buildINes()));
    expect(() => cart.prgWrite(0x8000, 0xff)).not.toThrow();
    expect(cart.prgRead(0x8000)).toBe(makePrgBankMarker(0));
  });

  it('镜像模式上报与头一致', () => {
    const cart = createCartridge(parseINes(buildINes({ verticalMirroring: true })));
    expect(cart.getMirroring()).toBe('vertical');
  });
});
