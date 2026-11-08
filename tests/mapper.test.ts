/**
 * M3：MMC1 / UxROM / CNROM 合成 ROM bank 切换测试。
 * MMC1 的串行写入用辅助函数按「5 次写、低位先进」协议打进去。
 */
import { describe, expect, it } from 'vitest';
import { createCartridge, type Cartridge, type Mmc1Cartridge } from '../src/board/cartridge';
import { parseINes } from '../src/board/ines';
import { buildINes, makePrgBankMarker } from './helpers/rom-builder';

/** MMC1 串行写入：把 5 位值按低位先进打进指定寄存器窗口 */
function mmc1Write(cart: Mmc1Cartridge, windowAddr: number, value5: number): void {
  for (let i = 0; i < 5; i++) {
    cart.prgWrite(windowAddr, (value5 >> i) & 1);
  }
}

describe('M3 · CNROM(3)', () => {
  it('PRG 与 NROM 相同（32KB 线性）', () => {
    const cart = createCartridge(parseINes(buildINes({ prgUnits: 2, mapper: 3 })));
    expect(cart.prgRead(0x8000)).toBe(makePrgBankMarker(0));
    expect(cart.prgRead(0xc000)).toBe(makePrgBankMarker(1));
  });

  it('CHR bank 切换：写 $8000-$FFFF 任选 8KB bank', () => {
    // 2 个 8KB CHR bank = 4 个 4KB chunk（0,1,2,3）
    const cart = createCartridge(parseINes(buildINes({ prgUnits: 1, chrUnits: 2, mapper: 3 })));
    expect(cart.chrRead(0x0000)).toBe(0x80); // 默认 bank0 → chunk0
    expect(cart.chrRead(0x1000)).toBe(0x81);
    cart.prgWrite(0x8000, 1); // 切到 bank1
    expect(cart.chrRead(0x0000)).toBe(0x82);
    expect(cart.chrRead(0x1fff)).toBe(0x83);
    cart.prgWrite(0xa001, 0); // 寄存器窗口任意地址
    expect(cart.chrRead(0x0000)).toBe(0x80);
  });

  it('bank 号按 CHR 容量取模（越界值折叠）', () => {
    const cart = createCartridge(parseINes(buildINes({ prgUnits: 1, chrUnits: 2, mapper: 3 })));
    cart.prgWrite(0x8000, 3); // 2 banks → 3 & 1 = 1
    expect(cart.chrRead(0x0000)).toBe(0x82);
  });

  it('CHR-RAM 版 CNROM：切换无效、写入保持', () => {
    const cart = createCartridge(parseINes(buildINes({ prgUnits: 1, chrUnits: 0, mapper: 3 })));
    cart.prgWrite(0x8000, 1);
    cart.chrWrite(0x0100, 0x77);
    expect(cart.chrRead(0x0100)).toBe(0x77);
  });
});

describe('M3 · UxROM(2)', () => {
  it('$8000 可切换，$C000 固定末 bank', () => {
    // 4 个 16KB bank
    const cart = createCartridge(parseINes(buildINes({ prgUnits: 4, mapper: 2 })));
    expect(cart.prgRead(0x8000)).toBe(makePrgBankMarker(0)); // 上电 bank0
    expect(cart.prgRead(0xc000)).toBe(makePrgBankMarker(3)); // 末 bank
    cart.prgWrite(0x8000, 2);
    expect(cart.prgRead(0x8000)).toBe(makePrgBankMarker(2));
    expect(cart.prgRead(0x9fff)).toBe(makePrgBankMarker(2));
    expect(cart.prgRead(0xc000)).toBe(makePrgBankMarker(3)); // 固定区不受影响
    expect(cart.prgRead(0xffff)).toBe(makePrgBankMarker(3));
  });

  it('bank 号按容量取模', () => {
    const cart = createCartridge(parseINes(buildINes({ prgUnits: 4, mapper: 2 })));
    cart.prgWrite(0x8000, 0x0f); // 4 banks → 0x0f & 3 = 3
    expect(cart.prgRead(0x8000)).toBe(makePrgBankMarker(3));
    cart.prgWrite(0x8000, 0x11); // 0x11 & 3 = 1
    expect(cart.prgRead(0x8000)).toBe(makePrgBankMarker(1));
  });

  it('CHR-RAM 8KB 可写', () => {
    const cart = createCartridge(parseINes(buildINes({ prgUnits: 4, chrUnits: 0, mapper: 2 })));
    cart.chrWrite(0x1abc, 0x5a);
    expect(cart.chrRead(0x1abc)).toBe(0x5a);
  });

  it('16KB PRG（异常小的 UxROM）不越界', () => {
    const cart = createCartridge(parseINes(buildINes({ prgUnits: 1, mapper: 2 })));
    cart.prgWrite(0x8000, 5); // mask = 0
    expect(cart.prgRead(0x8000)).toBe(makePrgBankMarker(0));
    expect(cart.prgRead(0xc000)).toBe(makePrgBankMarker(0));
  });
});

describe('M3 · MMC1(1)', () => {
  function makeMmc1(spec: { prgUnits?: number; chrUnits?: number } = {}): Mmc1Cartridge {
    return createCartridge(
      parseINes(buildINes({ prgUnits: spec.prgUnits ?? 4, chrUnits: spec.chrUnits ?? 2, mapper: 1 })),
    ) as Mmc1Cartridge;
  }

  it('上电默认：PRG 模式 3（$8000 切换 + $C000 固定末 bank）', () => {
    const cart = makeMmc1();
    expect(cart.prgRead(0x8000)).toBe(makePrgBankMarker(0));
    expect(cart.prgRead(0xc000)).toBe(makePrgBankMarker(3));
  });

  it('R3 切换 $8000 bank（模式 3）', () => {
    const cart = makeMmc1();
    mmc1Write(cart, 0xe000, 2); // R3 = 2
    expect(cart.prgRead(0x8000)).toBe(makePrgBankMarker(2));
    expect(cart.prgRead(0xc000)).toBe(makePrgBankMarker(3)); // 固定不变
    mmc1Write(cart, 0xe000, 15);
    expect(cart.prgRead(0x8000)).toBe(makePrgBankMarker(3));
  });

  it('R0 切 PRG 模式 2：$8000 固定 bank0，$C000 切换', () => {
    const cart = makeMmc1();
    mmc1Write(cart, 0x8000, 0b01000); // bits2-3 = 10 → 模式 2
    expect(cart.prgRead(0x8000)).toBe(makePrgBankMarker(0));
    mmc1Write(cart, 0xe000, 1);
    expect(cart.prgRead(0xc000)).toBe(makePrgBankMarker(1));
    expect(cart.prgRead(0x8000)).toBe(makePrgBankMarker(0));
  });

  it('R0 切 PRG 模式 0/1：32KB 整体切换（bank 低位忽略）', () => {
    const cart = makeMmc1({ prgUnits: 8 }); // 128KB = 4 组 32KB
    mmc1Write(cart, 0x8000, 0b00000); // 模式 0
    mmc1Write(cart, 0xe000, 0b00110); // bank 6 → 低位忽略 → 32KB 组 3 = banks 6,7
    expect(cart.prgRead(0x8000)).toBe(makePrgBankMarker(6));
    expect(cart.prgRead(0xbfff)).toBe(makePrgBankMarker(6));
    expect(cart.prgRead(0xc000)).toBe(makePrgBankMarker(7));
    expect(cart.prgRead(0xffff)).toBe(makePrgBankMarker(7));
    mmc1Write(cart, 0xe000, 0b00111); // 7 & ~1 = 6 → 同一组
    expect(cart.prgRead(0x8000)).toBe(makePrgBankMarker(6));
  });

  it('R1/R2 4KB CHR 模式：两窗独立切换', () => {
    const cart = makeMmc1(); // 2 个 8KB = 4 个 4KB chunk
    mmc1Write(cart, 0x8000, 0b10000); // bit4=1 → 4KB 模式
    mmc1Write(cart, 0xa000, 1); // R1 = chunk1
    mmc1Write(cart, 0xc000, 3); // R2 = chunk3
    expect(cart.chrRead(0x0000)).toBe(0x81);
    expect(cart.chrRead(0x0fff)).toBe(0x81);
    expect(cart.chrRead(0x1000)).toBe(0x83);
    expect(cart.chrRead(0x1fff)).toBe(0x83);
  });

  it('R0 8KB CHR 模式：R1 低位忽略选 8KB 组', () => {
    const cart = makeMmc1(); // 16KB CHR = 2 组 8KB
    mmc1Write(cart, 0xa000, 0b00010); // R1 = 2 → 低位忽略 → 组 1
    expect(cart.chrRead(0x0000)).toBe(0x82);
    expect(cart.chrRead(0x1000)).toBe(0x83);
  });

  it('镜像切换：R0 bits0-1 → single-lower/upper/vertical/horizontal', () => {
    const cart = makeMmc1();
    const modes: Array<[number, string]> = [
      [0, 'single-lower'],
      [1, 'single-upper'],
      [2, 'vertical'],
      [3, 'horizontal'],
    ];
    for (const [bits, expectMode] of modes) {
      mmc1Write(cart, 0x8000, bits);
      expect(cart.getMirroring()).toBe(expectMode);
    }
  });

  it('bit7 复位：清移位状态并锁回 PRG 模式 3，镜像/CHR 模式保持', () => {
    const cart = makeMmc1();
    mmc1Write(cart, 0x8000, 0b10010); // 4KB CHR 模式 + 垂直镜像
    expect(cart.getMirroring()).toBe('vertical');
    mmc1Write(cart, 0xe000, 2);
    // 打入半截序列后复位
    cart.prgWrite(0x8000, 1);
    cart.prgWrite(0x8000, 1);
    cart.prgWrite(0x8000, 0x80); // bit7 复位
    // 复位后 PRG 应回模式 3：$8000 切换 + $C000 固定
    expect(cart.prgRead(0x8000)).toBe(makePrgBankMarker(2)); // R3 保留
    expect(cart.prgRead(0xc000)).toBe(makePrgBankMarker(3));
    // 复位后新序列从 0 开始计：完整 5 写才生效
    mmc1Write(cart, 0x8000, 0); // 镜像 → single-lower
    expect(cart.getMirroring()).toBe('single-lower');
    // CHR 模式位在复位时保持（仍是 4KB 模式）
    mmc1Write(cart, 0xc000, 1);
    expect(cart.chrRead(0x1000)).toBe(0x81);
  });

  it('PRG-RAM 使能位（R3 bit4，MMC1B：0=使能 1=禁用）', () => {
    const cart = makeMmc1();
    expect(cart.prgRamEnabled()).toBe(true); // 上电 R3=0 → 默认使能
    mmc1Write(cart, 0xe000, 0b10000); // bit4=1 → 禁用
    expect(cart.prgRamEnabled()).toBe(false);
    mmc1Write(cart, 0xe000, 0b00000); // bit4=0 → 使能
    expect(cart.prgRamEnabled()).toBe(true);
  });

  it('128KB CHR：4KB bank 号按容量取模', () => {
    const cart = createCartridge(
      parseINes(buildINes({ prgUnits: 4, chrUnits: 16, mapper: 1 })),
    ) as Mmc1Cartridge;
    mmc1Write(cart, 0x8000, 0b10000); // 4KB 模式
    mmc1Write(cart, 0xa000, 31); // chunk 31 = 最后一格
    expect(cart.chrRead(0x0000)).toBe(0x80 | 31);
    mmc1Write(cart, 0xa000, 32); // 32 & 31 = 0
    expect(cart.chrRead(0x0000)).toBe(0x80);
  });

  it('CHR-RAM MMC1：CHR 寄存器写入无害、RAM 固定映射', () => {
    const cart = createCartridge(
      parseINes(buildINes({ prgUnits: 4, chrUnits: 0, mapper: 1 })),
    ) as Mmc1Cartridge;
    mmc1Write(cart, 0x8000, 0b10000);
    mmc1Write(cart, 0xa000, 7);
    cart.chrWrite(0x0200, 0x99);
    expect(cart.chrRead(0x0200)).toBe(0x99);
  });
});

describe('M3 · mapper 工厂', () => {
  it('不支持的 mapper 抛错（如 MMC3 列二期）', () => {
    expect(() => createCartridge(parseINes(buildINes({ mapper: 4 })))).toThrow(/mapper/);
  });

  it('Cartridge 接口完整性抽查', () => {
    const cart: Cartridge = createCartridge(parseINes(buildINes()));
    expect(typeof cart.prgRead).toBe('function');
    expect(typeof cart.chrRead).toBe('function');
    expect(cart.prgRam.length).toBe(0x2000);
  });
});
