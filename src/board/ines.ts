/**
 * iNES / NES 2.0 ROM 文件解析。
 *
 * 格式参考 nesdev wiki「INES」与「NES 2.0」条目：
 *   0-3   固定魔数 "NES\x1a"
 *   4     PRG ROM 大小（单位 16KB）
 *   5     CHR ROM 大小（单位 8KB；0 = 无 CHR ROM，即 CHR-RAM，按 8KB 可写处理）
 *   6     flags6: bit0 垂直镜像(1)/水平镜像(0)、bit1 电池存档、bit2 512B trainer、
 *          bit3 四屏镜像、bit4-7 mapper 低 4 位
 *   7     flags7: bit2-3 主机类型（== 0b10 表示 NES 2.0）、bit4-7 mapper 高 4 位
 *   8-15  NES 2.0 扩展字段（本部宽容处理：mapper 高位取 flags8 低半字节，
 *         PRG/CHR 容量超出 1.0 表达范围或指数编码的情形不特殊支持，见 REPORT）
 *
 * 解析只切出字节视图，不拷贝 PRG/CHR 数据。
 */
import type { Mirroring } from '../contract';

/** 解析结果。chr === null 表示 CHR-RAM（可写，容量固定 8KB）。 */
export interface INesRom {
  /** PRG ROM 数据（prgUnits * 16KB） */
  prg: Uint8Array;
  /** CHR ROM 数据；null 表示 CHR-RAM */
  chr: Uint8Array | null;
  /** mapper 编号（一期支持 0/1/2/3） */
  mapper: number;
  /** 头部上报的初始镜像（mapper 可在运行时改写，如 MMC1） */
  mirroring: Mirroring;
  /** 是否带电池存档 PRG-RAM */
  battery: boolean;
  /** 是否声明四屏镜像（优先于 bit0 镜像位） */
  fourScreen: boolean;
  /** 是否为 NES 2.0 头 */
  isNES20: boolean;
  /** 原始 16 字节头，供诊断 */
  header: Uint8Array;
}

export class INesFormatError extends Error {}

const PRG_UNIT = 16384;
const CHR_UNIT = 8192;
const TRAINER_SIZE = 512;

export function parseINes(data: Uint8Array): INesRom {
  if (data.length < 16) {
    throw new INesFormatError(`文件太短（${data.length} 字节），不是 iNES 格式`);
  }
  // 魔数校验：'N' 'E' 'S' 0x1a
  if (data[0] !== 0x4e || data[1] !== 0x45 || data[2] !== 0x53 || data[3] !== 0x1a) {
    throw new INesFormatError('iNES 魔数不符（前 4 字节应为 4E 45 53 1A）');
  }

  const header = data.slice(0, 16);
  const prgUnits = header[4]!;
  const chrUnits = header[5]!;
  const flags6 = header[6]!;
  const flags7 = header[7]!;
  const flags8 = header[8]!;

  // NES 2.0 识别：flags7 bit2-3 == 0b10。宽容处理：按 2.0 取 mapper 高位，
  // 其余扩展字段（定时器、加密等）不支持但也不报错。
  const isNES20 = (flags7 & 0x0c) === 0x08;
  let mapper = (flags7 & 0xf0) | (flags6 >> 4);
  if (isNES20) {
    mapper |= (flags8 & 0x0f) << 8;
  }

  // 镜像：四屏优先；否则 bit0 1=垂直 0=水平
  const fourScreen = (flags6 & 0x08) !== 0;
  const mirroring: Mirroring = fourScreen
    ? 'four'
    : (flags6 & 0x01) !== 0
      ? 'vertical'
      : 'horizontal';

  const prgBytes = prgUnits * PRG_UNIT;
  const chrBytes = chrUnits * CHR_UNIT;
  const hasTrainer = (flags6 & 0x04) !== 0;
  const prgStart = 16 + (hasTrainer ? TRAINER_SIZE : 0);

  // 容量校验：文件必须装得下 PRG + CHR
  if (data.length < prgStart + prgBytes + chrBytes) {
    throw new INesFormatError(
      `文件截断：头声明 PRG ${prgBytes}B + CHR ${chrBytes}B，实际数据不足` +
        `（文件 ${data.length}B，需要 ${prgStart + prgBytes + chrBytes}B）`,
    );
  }

  // 特例：prgUnits === 0 的坏 ROM（极罕见）按 0 容量放行，mapper 侧自然读 0
  const prg = data.slice(prgStart, prgStart + prgBytes);
  const chr = chrUnits > 0 ? data.slice(prgStart + prgBytes, prgStart + prgBytes + chrBytes) : null;

  return {
    prg,
    chr,
    mapper,
    mirroring,
    battery: (flags6 & 0x02) !== 0,
    fourScreen,
    isNES20,
    header,
  };
}
