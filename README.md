# NES 模拟器 · 主板与整机（第三部）

从零手写的 NES 模拟器（纯 TypeScript、零运行时依赖、单文件静态部署）。
本仓库负责**主板与整机**：iNES 加载、mapper、内存总线、NTSC 主循环、手柄、
Web UI 调试器，并把并行开发的 CPU（6502）与 PPU（2C02）集成为完整可玩的模拟器。

- 任务书：`C:\works\nes-emu\第三部-主板与集成任务书.md`
- 契约：`src/contract.ts`（三部冻结，禁止修改）
- 集成等待说明：`INTEGRATION-WAIT.md`

## 快速开始

```bash
npm install              # devDependencies（typescript / vitest / esbuild / @types/node）
npm test                 # 全仓测试（单元测试 + blargg 测试 ROM 套件）
npm run typecheck        # tsc --noEmit
npm run build:web        # 打包 dist/index.html（单文件，可直接部署 GitHub Pages）
npm run fetch:test-roms  # 下载 blargg 测试 ROM 到 tests/roms/（已 gitignore）
```

`dist/index.html` 用任意静态服务器打开即可玩（或直接双击）：
拖入 .nes 文件 → 自动运行。键位：方向键移动，Z=A，X=B，Enter=Start，
Shift=Select，P 暂停，F 单帧，R 复位。

## 目录结构

```
src/
  contract.ts      三部共用的冻结契约（禁止修改）
  board/
    ines.ts        iNES / NES 2.0 解析
    cartridge.ts   卡带抽象 + mapper：NROM(0) / MMC1(1) / UxROM(2) / CNROM(3)
    bus.ts         CPU 总线：RAM 镜像、PPU 寄存器折叠、OAM DMA、手柄端口
    joypad.ts      标准手柄移位寄存器协议
    machine.ts     整机装配（cpu+ppu+bus）与 NTSC 帧循环
    timing.ts      浏览器 rAF 帧驱动（追帧限幅 + FPS 统计）
    integration.ts M5 集成点（cpu/ppu 工厂接线）
  web/
    index.html     UI 骨架
    main.ts        UI 逻辑（画面 / 输入 / 调试面板 / 存档）
  cpu/  ppu/       集成进来的第一、二部源码（M5）
tests/
  roms/            测试 ROM（脚本下载，不入库）
scripts/           构建 / 下载 / 基准脚本
REPORT.md          集成记录、测试结果表、已知限制
README-偏差记录.md  契约偏差记录
```

## 测试策略

1. **合成 ROM 单元测试**：iNES 字节流在代码里直接拼装，mapper 切换 / 总线
   映射全部可测，不依赖任何外部文件。
2. **blargg 全家桶**：结果码协议（$6000=0x80 进行中 / 0x01 成功，$6004+
   ASCII 文本），`npm run fetch:test-roms` 后 `npm test` 自动断言。
3. **nestest 图形模式**：出图对拍截图留档 `docs/screenshots/`。
4. **性能**：单帧（含渲染）< 8ms 预算（60fps 余量），基准用例见 `npm test`。

## 已知限制（一期）

- mapper 仅 0/1/2/3（MMC3 列二期）
- 音频 APU 未实现（UI 预留静音开关占位）
- 其余见 REPORT.md
