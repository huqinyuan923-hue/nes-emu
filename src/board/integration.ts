/**
 * M5 集成点：把第一、二部产出的 CPU/PPU 装配进整机。
 *
 * CPU 源码：nes-cpu/src/cpu（拷入 src/cpu/，含集成侧修正，见 README-偏差记录.md §3）
 * PPU 源码：nes-ppu/src/ppu（拷入 src/ppu/）
 */
import { createCPU6502 } from '../cpu/createCPU';
import { createPPU2C02 } from '../ppu/createPPU';
import type { MachineFactories } from './machine';

export function getMachineFactories(): MachineFactories {
  return {
    createCpu: createCPU6502,
    createPpu: createPPU2C02,
  };
}
