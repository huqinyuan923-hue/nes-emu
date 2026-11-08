/**
 * M2：总线单元测试——RAM 镜像、PPU 寄存器折叠、手柄端口、OAM DMA 转发、开总线。
 * PPU 用假实现（tests/helpers/stubs.ts），不依赖第二部产出。
 */
import { describe, expect, it } from 'vitest';
import { CPUBus } from '../src/board/bus';
import { createCartridge } from '../src/board/cartridge';
import { parseINes } from '../src/board/ines';
import { JOY_A, JOY_START, JOY_UP, Joypad } from '../src/board/joypad';
import { buildINes } from './helpers/rom-builder';

function makeBus() {
  const bus = new CPUBus();
  const ppu = {
    writes: [] as Array<{ index: number; value: number }>,
    reads: [] as number[],
    readValue: 0x5a,
    dma: null as null | { page: number; data: number[] },
    readReg(index: number) {
      this.reads.push(index & 7);
      return this.readValue;
    },
    writeReg(index: number, value: number) {
      this.writes.push({ index: index & 7, value: value & 0xff });
    },
    oamDma(page: number, readFn: (addr: number) => number) {
      const data: number[] = [];
      for (let i = 0; i < 256; i++) data.push(readFn((page << 8) | i));
      this.dma = { page, data };
    },
  };
  bus.attachPPU(ppu as never);
  return { bus, ppu };
}

describe('M2 · 内部 RAM 镜像', () => {
  it('2KB RAM 对 $0000-$1FFF 8 次镜像', () => {
    const { bus } = makeBus();
    bus.write(0x0000, 0xab);
    bus.write(0x07ff, 0xcd);
    expect(bus.read(0x0800)).toBe(0xab); // +0x800
    expect(bus.read(0x1000)).toBe(0xab); // +0x1000
    expect(bus.read(0x1fff)).toBe(0xcd); // +0x1800
    expect(bus.read(0x1999)).toBe(bus.read(0x0199));
  });

  it('写镜像区任一别名，各别名同步可见', () => {
    const { bus } = makeBus();
    bus.write(0x1234, 0x42);
    expect(bus.read(0x0234)).toBe(0x42);
    expect(bus.read(0x1a34)).toBe(0x42);
  });
});

describe('M2 · PPU 寄存器折叠', () => {
  it('$2000-$3FFF 每 8 字节折叠成 index 0-7', () => {
    const { bus, ppu } = makeBus();
    bus.write(0x2000, 0x10);
    bus.write(0x2007, 0x17);
    bus.write(0x3ff8, 0x10); // (0x3ff8 & 7) === 0
    bus.write(0x3fff, 0x17); // (0x3fff & 7) === 7
    expect(ppu.writes).toEqual([
      { index: 0, value: 0x10 },
      { index: 7, value: 0x17 },
      { index: 0, value: 0x10 },
      { index: 7, value: 0x17 },
    ]);
  });

  it('读 PPU 寄存器返回 readReg 结果', () => {
    const { bus, ppu } = makeBus();
    ppu.readValue = 0xb7;
    expect(bus.read(0x2002)).toBe(0xb7);
    expect(bus.read(0x3ffd)).toBe(0xb7); // index 5
    expect(ppu.reads).toEqual([2, 5]);
  });
});

describe('M2 · OAM DMA 转发', () => {
  it('写 $4014 → ppu.oamDma(page, read)，数据经总线逐字节读出', () => {
    const { bus, ppu } = makeBus();
    for (let i = 0; i < 256; i++) bus.write(0x0200 + i, (i * 3) & 0xff);
    bus.write(0x4014, 0x02);
    expect(ppu.dma).not.toBeNull();
    expect(ppu.dma!.page).toBe(0x02);
    expect(ppu.dma!.data).toEqual(Array.from({ length: 256 }, (_, i) => (i * 3) & 0xff));
  });

  it('DMA 源页可以指向卡带 PRG（读路径一致）', () => {
    const { bus, ppu } = makeBus();
    const cart = createCartridge(parseINes(buildINes({ prgUnits: 2 })));
    bus.attachCartridge(cart);
    bus.write(0x4014, 0xc0); // 源页 $C000 → PRG 末 bank 开头
    expect(ppu.dma!.data[0]).toBe(cart.prgRead(0xc000));
  });
});

describe('M2 · 手柄端口', () => {
  it('总线写 $4016 strobe 后按键流可读（bit0 + 0x40）', () => {
    const { bus } = makeBus();
    bus.write(0x4016, 1); // strobe=1
    bus.write(0x4016, 0); // 锁存（当前无按键）
    const stream = Array.from({ length: 10 }, () => bus.read(0x4016));
    expect(stream.slice(0, 8)).toEqual(Array(8).fill(0x40));
    expect(stream.slice(8)).toEqual([0x41, 0x41]); // 溢出返回 1
  });

  it('$4017 独立（P2）', () => {
    const { bus } = makeBus();
    bus.write(0x4017, 1);
    bus.write(0x4017, 0);
    expect(bus.read(0x4017) & 1).toBe(0);
  });

  it('bus.read(0x4016) 等价于 Joypad.read()', () => {
    const { bus } = makeBus();
    bus.joypads[0].setButtons(JOY_A | JOY_UP | JOY_START);
    bus.write(0x4016, 1);
    bus.write(0x4016, 0);
    expect(bus.read(0x4016)).toBe(0x41); // A
    expect(bus.read(0x4016)).toBe(0x40); // B
    expect(bus.read(0x4016)).toBe(0x40); // Select
    expect(bus.read(0x4016)).toBe(0x41); // Start
    expect(bus.read(0x4016)).toBe(0x41); // Up
  });
});

describe('M2 · 卡带映射', () => {
  it('$8000-$FFFF 转发 prgRead / prgWrite', () => {
    const { bus } = makeBus();
    bus.attachCartridge(createCartridge(parseINes(buildINes({ mapper: 3, chrUnits: 2 }))));
    expect(bus.read(0x8000)).toBe(0xa5); // bank0 标记 0 ^ 0xA5
    bus.write(0x8000, 1); // CNROM 切 CHR bank（PRG 内容不变）
    expect(bus.read(0x8000)).toBe(0xa5);
  });

  it('$6000-$7FFF 转发 PRG-RAM', () => {
    const { bus } = makeBus();
    bus.attachCartridge(createCartridge(parseINes(buildINes())));
    bus.write(0x6000, 0x80);
    bus.write(0x6010, 0x7f);
    expect(bus.read(0x6000)).toBe(0x80);
    expect(bus.read(0x6010)).toBe(0x7f);
  });

  it('未装卡带时 $6000+ 读返回开总线残留', () => {
    const { bus } = makeBus();
    bus.write(0x0010, 0x77);
    expect(bus.read(0x8000)).toBe(0x77);
  });
});

describe('M2 · 开总线', () => {
  it('未映射区（$4018-$5FFF）读到最近一次总线值', () => {
    const { bus } = makeBus();
    bus.write(0x0005, 0x3c);
    expect(bus.read(0x4018)).toBe(0x3c);
    expect(bus.read(0x5fff)).toBe(0x3c);
  });

  it('$4000-$4013 / $4015 写入被接受（不抛错），读取返回开总线', () => {
    const { bus } = makeBus();
    expect(() => {
      bus.write(0x4000, 0x0f);
      bus.write(0x4015, 0x1f);
    }).not.toThrow();
    expect(bus.read(0x4015)).toBe(0x1f);
  });
});

describe('M2 · Joypad 独立单元', () => {
  it('strobe 保持 1 时恒返回 A 键状态', () => {
    const joy = new Joypad();
    joy.setButtons(JOY_A);
    joy.write(1);
    expect(joy.read()).toBe(0x41);
    expect(joy.read()).toBe(0x41);
  });

  it('完整按键流顺序 A,B,Select,Start,Up,Down,Left,Right', () => {
    const joy = new Joypad();
    joy.setButtons(JOY_A | JOY_UP | JOY_START);
    joy.write(1);
    joy.write(0);
    const bits = Array.from({ length: 8 }, () => joy.read() & 1);
    expect(bits).toEqual([1, 0, 0, 1, 1, 0, 0, 0]);
    expect(joy.read() & 1).toBe(1); // 溢出
  });

  it('重复 strobe 刷新锁存快照', () => {
    const joy = new Joypad();
    joy.write(1);
    joy.write(0);
    expect(joy.read() & 1).toBe(0);
    joy.setButtons(JOY_A);
    joy.write(1);
    joy.write(0);
    expect(joy.read() & 1).toBe(1);
  });

  it('连续读超过 8 次后返回 1，再次 strobe 恢复', () => {
    const joy = new Joypad();
    joy.write(1);
    joy.write(0);
    for (let i = 0; i < 12; i++) joy.read();
    expect(joy.read() & 1).toBe(1);
    joy.write(1);
    joy.write(0);
    expect(joy.read() & 1).toBe(0); // 重新从 A 开始
  });
});
