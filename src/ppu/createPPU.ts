/**
 * 契约入口：createPPU2C02(nmiCallback?) → PPU2C02。
 * 本部唯一公开工厂函数（契约要求）。
 */
import type { PPU2C02 } from '../contract';
import { PPU2C02Impl } from './PPU2C02Impl';

export function createPPU2C02(nmiCallback?: () => void): PPU2C02 {
  return new PPU2C02Impl(nmiCallback);
}
