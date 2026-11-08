# 偏差记录（与冻结契约）

> 记录 `src/contract.ts` 的缺陷、歧义与集成侧处理。契约现已升至 v1.1
> （修复轮，仅加法，见 `src/contract-CHANGELOG.md`）。本文件按任务书要求
> 维护；跨会话的源码补丁见 §3（非契约缺陷，但需要同步方知晓）。

## 1. 契约缺陷

无阻断性缺陷。v1.0 的两处**完备性缺口**已在 v1.1 以加法方式转正（§2.2/§2.3）。

## 2. 契约完备性缺口与 v1.1 转正

### 2.1 `PPU2C02.getFramebuffer()` 未注明像素格式

- 契约只声明 `Framebuffer = Uint8ClampedArray`，未说明字节布局。
- 我方假设：**RGBA**，每像素 4 字节，总长 256×240×4。
- 确认：第二部 `render.ts` 实现为 R/G/B/A 顺序，与假设一致；
  `getFramebuffer` 返回内部复用的同一 buffer（无拷贝），消费方按拷贝语义使用。
- 最终校验：浏览器实测出图色彩正确（croom/240pee/nestest 截图）。

### 2.2 CHR 写通路缺失 → v1.1 `setChrWriter?`（已转正）

- v1.0 的 `PPU2C02` 仅有 `setChrReader`（读通路）。CHR-RAM 游戏（chrUnits=0）
  开机必须经 $2007 把字模写入 CHR 区——契约没有从 PPU 到卡带的写通道。
- 后果（v1.0 实测）：blargg 2005 系全部测试壳引导失败、CHR-RAM 游戏无法工作。
- v1.1 已增补 `setChrWriter?(write)`；主板 `NESMachine.reset()` 装配时把
  `cartridge.chrWrite` 注入。`$2007` 写 $0000-$1FFF 即到达 CHR-RAM。

### 2.3 子周期访问信息缺失 → v1.1 `Bus.onAccess?`（已转正，修复轮核心）

- v1.0 的 `Bus` 只有 `read/write`，CPU 是原子指令执行——PPU 拿不到
  "读发生在指令内第几个周期"，dot 级时序（$2002 读竞态、NMI 相对时序）
  无法表达。
- v1.1 增补 `onAccess?(cycleInInstruction, cyclesAbsolute)`（**双数字参数，
  非对象载荷**——对象载荷在最热路径上引入 30ms 级 GC 停顿）。
- 实现语义与全部根因分析见 `REPORT.md §5.1`。

## 3. 跨会话源码补丁（集成时对 nes-cpu 拷贝的修正，原仓库未动）

以下补丁作用于本仓 `src/cpu/`（自 `nes-cpu/src/cpu` 拷入的副本），
**需第一部同步**（其一为一字笔误，其二为第一部注释中已声明的二期占位）：

### 3.1 `opcodes.ts`：0xBF（LAX absolute,Y）寻址模式笔误

- 原版：`def(0xBF, '*LAX', 'abx', ...)` —— 误标为 absolute,X。
- 症状：nestest golden log 第 5482 行（`LAX $0557,Y @ 0587 = 87`）读到
  $0589 的 00 而非 $0587 的 87。
- 修正：`'abx'` → `'aby'`。
- 影响：仅非官方指令 BF；官方指令与官方测试（official_only.nes）不覆盖，
  故第一部的 405 项测试未抓到。集成侧验证：golden log 全量 + nestest
  图形模式「LAX tests」分类 OK。

### 3.2 `opcodes.ts`：RMW 组合族（SLO/RLA/SRE/RRA/DCP/ISB，42 个操作码）

- 原版：按注释声明「一期按 RMW 时序占位（读 + 双写原值），运算语义留待二期」。
- 集成侧补全真实语义（时序不变：读 → 哑写旧值 → 写新值）：SLO=ASL+ORA、
  RLA=ROL+AND、SRE=LSR+EOR、RRA=ROR+ADC、DCP=DEC+CMP、ISB=INC+SBC，
  标志位按 nesdev 非官方指令文档。
- 验证：nestest golden log 8991 行全量对拍（第 5841 行 DCP 分歧由此修复）+
  nestest 图形模式非法指令菜单 DCP/ISB/SLO/RLA/SRE/RRA 六分类全 OK。

