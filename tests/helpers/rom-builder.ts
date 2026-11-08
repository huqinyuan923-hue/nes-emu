/**
 * 测试辅助：在代码里直接拼 iNES 字节流（任务书规定的合成 ROM 手法，
 * 不依赖任何外部文件）。
 *
 * 填充约定（便于 bank 切换断言）：
 *   - PRG：每个 16KB bank 整体填 (bankIndex ^ 0xA5) & 0xFF
 *     —— 读 $8000-$FFFF 任意字节即可识别当前映射到哪个 bank
 *   - CHR：按 4KB chunk 填 0x80 | chunkIndex（MMC1 4KB 粒度可精确断言，
 *     8KB bank = 相邻两个 chunk）
 */
import type { u8 } from '../../src/contract';

export interface RomSpec {
  /** PRG 16KB 单元数（默认 2 = 32KB） */
  prgUnits?: number;
  /** CHR 8KB 单元数（默认 1；0 = CHR-RAM） */
  chrUnits?: number;
  /** mapper 编号（默认 0 = NROM） */
  mapper?: number;
  /** true = 垂直镜像（默认水平） */
  verticalMirroring?: boolean;
  battery?: boolean;
  trainer?: boolean;
  fourScreen?: boolean;
  /** 以 NES 2.0 头编码（mapper 高位走 flags8） */
  nes20?: boolean;
}

export function makePrgBankMarker(bank: number): u8 {
  return (bank ^ 0xa5) & 0xff;
}

/** 生成合成 iNES 文件字节流 */
export function buildINes(spec: RomSpec = {}): Uint8Array {
  const {
    prgUnits = 2,
    chrUnits = 1,
    mapper = 0,
    verticalMirroring = false,
    battery = false,
    trainer = false,
    fourScreen = false,
    nes20 = false,
  } = spec;

  const header = new Uint8Array(16);
  header[0] = 0x4e;
  header[1] = 0x45;
  header[2] = 0x53;
  header[3] = 0x1a;
  header[4] = prgUnits;
  header[5] = chrUnits;
  header[6] =
    (verticalMirroring ? 0x01 : 0x00) |
    (battery ? 0x02 : 0x00) |
    (trainer ? 0x04 : 0x00) |
    (fourScreen ? 0x08 : 0x00) |
    ((mapper & 0x0f) << 4);
  header[7] = (mapper & 0xf0) | (nes20 ? 0x08 : 0x00);
  if (nes20) header[8] = (mapper >> 8) & 0x0f;

  const trainerBytes = trainer ? 512 : 0;
  const total = 16 + trainerBytes + prgUnits * 16384 + chrUnits * 8192;
  const data = new Uint8Array(total);
  data.set(header, 0);

  let off = 16 + trainerBytes;
  for (let bank = 0; bank < prgUnits; bank++) {
    data.fill(makePrgBankMarker(bank), off, off + 16384);
    off += 16384;
  }
  for (let chunk = 0; chunk < chrUnits * 2; chunk++) {
    data.fill(0x80 | chunk, off, off + 4096);
    off += 4096;
  }
  return data;
}

/** 生成 trainer 垃圾数据版（用于跳过测试） */
export function buildINesWithTrainer(spec: RomSpec = {}): Uint8Array {
  return buildINes({ ...spec, trainer: true });
}
