import { CPU6502Impl } from './CPU6502Impl';
import type { Bus, CPU6502 } from '../contract';

/**
 * 构造 6502 CPU 实例（NES 2A03 核心，周期精确）。
 * 总线由调用方注入，实现 contract.Bus 接口即可。
 */
export function createCPU6502(bus: Bus): CPU6502 {
  return new CPU6502Impl(bus);
}
