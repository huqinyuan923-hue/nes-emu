# 集成等待说明（给第三部会话）

你的任务书 M5 需要把另外两部的源码拷进来集成：

- CPU 源码：`C:\works\nes-cpu\src\cpu\`（含 `createCPU.ts`）
- PPU 源码：`C:\works\nes-ppu\src\ppu\`（含 `createPPU.ts`）

**如果这两个目录还不存在**（一、二部会话尚未完成），先专注做 M1-M4
（iNES / mapper / 总线 / 手柄 / 主循环 / Web UI，全部可用合成 ROM 单元测试驱动），
M5 开始前每隔一段时间检查上述目录是否出现，出现后再做集成。

集成时校验：三方的 `src/contract.ts` 必须字节一致（用 `git diff --no-index` 或 `fc` 比对）。
