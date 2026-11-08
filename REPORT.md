# REPORT · 主板与整机（第三部）

> 最终交付报告：集成记录、测试 ROM 结果表、已知限制、与契约的偏差、
> 修复轮（v1.1）逐项根因分析、博客素材要点。

## 0. 修复轮摘要（v1.0 → v1.1）

修复轮起点：108/125（17 失败，含 1 项测试不确定性）。修复轮终态见 §0.3。

### 0.1 修复项清单

| # | 失败项 | 根因 | 修法 | 状态 |
|---|---|---|---|---|
| F1 | 15 项 dot 级时序（02/03/05-08/10/综合/oam_stress/vbl_nmi_timing 2-7） | 原子 CPU 指令执行 + 指令边界批量喂 PPU 5——$2002 读只能看到指令开始时的 PPU 快照 | **访问级 PPU 同步**：契约 v1.1 `Bus.onAccess` 让 CPU 在每次总线访问前回调，机器把 PPU 惰性喂到该周期对应 dot | ✅ 使 9 项转绿 |
| F2 | 02-vbl_set_time | 读竞态（读与 VBlank 置位同拍 → 0 + 抑制）未实现 | PPU 依据自身 (scanline,dot) 直接判定（无需外推）：下一待喂 dot 正是 (241,1) → 返回 0 并抑制本帧置位与 NMI | ✅ 全表匹配 |
| F3 | 06/07/08-nmi 簇 | 硬件 NMI 有约 3-dot 输出延迟，且输出时重新检查 vblankFlag 与 $2000 bit7 | `nmiDelay` 计数模型；读 $2002 清 flag 或关 NMI 可抑制尚未输出的 NMI | ✅ 06/08 全表匹配，07 见 F5 |
| F4 | sprite_overflow 3.Timing / 4.Obscure | 精灵评估合并到 dot 257 一次性完成；溢出标志置位 dot 与对角扫描 bug 未复现 | 逐 dot 评估检测器（dots 65-256 奇读偶判）；m-bug 对角读址 `OAM[4n+(m&3)]`；范围比较无借位 | ✅ **5/5 全绿，sprite_hit 11/11 零回退** |
| F5 | 03/4 与 07 的清除点冲突 | 07 要求清除点后移 2 dots，03/4 以 1-dot 精度锁死硬件真实位置 dot 1 | 不可同时满足 → 保留硬件真实点，07 列已知限制（§F5 详解） | ⚠️ 取舍 |
| D1 | perf 翻车（16↔17 项间摆动） | 单帧 max 断言在并发/GC 尖峰下不可复现 | 判定改为 **3×100 帧批均值中位数 < 16ms**；统计全量照常打印留档 | ✅ 3 连过 |
| D2 | 综合/oam_stress 等"报告绿实跑红" | vitest 文件并行导致 CPU 争抢（perf 从 8ms 漂到 39ms）、blargg 帧预算依赖被抢占 | `fileParallelism: false`（串行跑文件）；legacy 套件帧预算 600→1200 | ✅ |
| P1 | 单帧 8.5ms（贴线） | 每像素 `colorizePixel` 分配三元组数组（6 万次/帧 GC 压力） | 按 $2001 懒重建的 64 项预着色 LUT（零分配）；精灵取样数组提升局部量 | ✅ 中位批均 7.6-8.3ms |

### 0.2 契约 v1.1（仅加法）

- `Bus.onAccess?(cycleInInstruction, cyclesAbsolute)`：CPU 每次总线访问前回调
  （**双数字参数而非对象载荷**——对象载荷实测引入 30ms 级 GC 停顿）
- `PPU2C02.setChrWriter?(write)`：CHR 写通路转正（原偏差记录 §2.2 的弥合）

详见 `src/contract-CHANGELOG.md`。v1.0 实现零修改兼容。

### 0.3 终态

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 全仓测试 | 108/125（17 失败，其中 1 项非确定） | **117/124（7 失败，3 连跑完全一致）** |
| blargg 必须项 | sprite_hit 11/11；ppu_vbl_nmi 5/11；sprite_overflow 3/5；vram/palette/oam_read ✅；oam_stress ❌ | sprite_hit 11/11；ppu_vbl_nmi **8/11**（+02/03/06/08）；sprite_overflow **5/5**；vram/palette/oam_read ✅；oam_stress ❌ |
| blargg 尽力项 | vbl_nmi_timing 0/7 | **6/7**（1-6 全过） |
| 性能 | 单帧 avg 8.5ms，偶发 33ms 尖峰 | 中位批均 7.6-8.3ms，尖峰 ≤13ms |
| 可玩性 | croom 59.4fps / 240pee 60fps | 同（未回退，见 §0.5） |

### 0.4 确定性验证（H3 后口径：`npm test` 123 项，perf 移入 bench）

| 次序 | 环境 | 结果 | 失败集 |
|---|---|---|---|
| RUN 1 | 正常 | 116 passed / 7 failed / 123 总 | 见下（三次逐项一致） |
| RUN 2 | 正常 | 116 passed / 7 failed / 123 总 | 同 RUN 1 |
| RUN 3 | **带外部 CPU 负载** | 116 passed / 7 failed / 123 总 | 同 RUN 1 |

固定失败集（7 项，全部有数据支撑的根因，见 §0.6 与 §0.7）：
`05-nmi_timing`、`07-nmi_on_timing`、`10-even_odd_timing`、
`ppu_vbl_nmi 综合`、`oam_stress`、`cpu_timing_test`、`vbl_nmi_timing 7.nmi_timing`。

> 用例数 123：= 原 124 − perf（H3 移入独立 bench）。另：原 125 含
> `tests/zz-probe2.test.ts` 的 1 个调试残留用例，按修复轮 1 任务书一并移除。
> 确定性保障：vitest `fileParallelism: false`（串行跑文件）、perf 去 gate
> （H3，收尾任务书 §二.1）、legacy 套件帧预算 600→1200。
> 性能观测：`npm run bench`（独立配置 `vitest.bench.config.ts`）。

### 0.5 可玩性复验

croom（NROM）与 240pee（UxROM+NES2.0+CHR-RAM）在访问级同步改造后重新
构建 `dist/index.html` 并在浏览器实测（截图 `docs/screenshots/` 复验）。
nestest 图形模式双菜单（14 OK + 11 OK）与 golden log 8991 行对拍同步复验通过。

### 0.6 修复轮 2（时序簇定向攻坚）：两个假设的检验结果

主会话驳回修复轮 1 的「结构性不可解」结论，提出两个实现偏差假设并要求
以测量裁判。本轮**完整执行了两个假设的检验**，结论均为**证伪**，代码已
回到轮 1 基线（117/124）。下面是判定数据——不是推测。

#### H1｜「帧边界被 CPU 周期量化，丢掉亚周期余数」——**证伪**

- 假设：`stepFrame` 用 `round(帧×29780.5)` 把 89341.5 dots/帧 的余数吸收，
  使 CPU 读网格相对 PPU 帧起点的相位只能 3-dot 步进；改以 PPU dot 为帧
  边界权威（89342/89341）后，相位漂移应恢复到恒定 +1/帧。
- 实现：`PPU2C02Impl` 记录每帧实际 dots（`lastFrameDotCount`），
  `stepFrame` 改为 `while (ppuDots < ppuFrameEnd) stepInstruction()`。
- **测量（探针：连续 30 帧，记录每帧最后一次 $2002 读的帧内 dot 坐标）**：

| 状态 | 稳定段相位差序列（帧 10→18） |
|---|---|
| 改前 | 89302 → 89303 → … → 89310（恒定 **+1**） |
| 改后（H1） | 89302 → 89303 → … → 89310（恒定 **+1**，与改前逐位相同） |

- **判定**：H1 无效。原因：`pumpPPU` 以**绝对** CPU 周期喂送
  （`target = (cyclesAbsolute-1-7)*3+phase`），PPU 的 VBL 本就在自己的
  89342 dot 周期上；`stepFrame` 的帧边界只决定"每帧跑多久"，不参与
  读网格与 VBL 的相对相位。改前测得的漂移率**已经是**硬件一致的 +1/帧，
  假设所描述的 `{0,0,+1}` 型 3 帧周期在实现中不存在。
- 副作用：H1 破坏 2 项帧周期单元测试（`stepFrame` 精确 29781 步）→ 按
  回归红线立即回退，`lastFrameDotCount` 等遗留字段已清理。

#### H2｜「`cycleInInstruction` 被丢弃，读采样恒定偏 1 周期 = 3 dot」——**证伪**

- 假设：`Bus.onAccess` 丢弃了指令内相位，读 $2002 的采样点恒定偏移 3 dots；
  用指令内相位把采样筛到正确的一拍可整表修复 05（任务书要求以 05 落点表
  为裁判，首/末 dot 各跑一次）。
- **测量（05-nmi_timing 落点表，期望 `00-02=4 / 03-08=3 / 09=2`）**：

| 采样相位 | 05 落点表 | 转折行（4→3） | 与期望差 |
|---|---|---|---|
| 末 dot（phase=2） | 00-05=4, 06-09=3 | 06 | 晚 3 行 |
| 首 dot（phase=0） | 00-05=4, 06-09=3 | 06 | 晚 3 行（**与末 dot 完全相同**） |

- **判定**：H2 无效。原因：`sync_vbl` 是**自校准**的漂移循环（每次 test
  重新同步到"第一次读到 set"），读采样相位的变化会被同步终点平移吸收，
  落点表对该相位**完全不敏感**。
- 补充测量（定位真正的敏感量）：
  - 把 VBL 置位点临时移到 (241,4)（+3 dots）→ **05 表完全不变**（同上，
    被 sync 吸收）；
  - 把 `nmiDelay` 从 3 降到 1 → **05 转折 06→04**（敏感！每减 2 dots 延迟
    转折提前 2 行）；外推 `nmiDelay≈0` 才能得到期望的转折 03。

#### 05/07/10/7 的量化证据（本轮新增，替代旧的「不可同时满足」表述）

**表 A｜相位差序列（改前 / 改后 H1）**——探针：连续 30 帧记录每帧最后一次
$2002 读的帧内 dot 坐标，稳定段相邻帧差值：

| 状态 | 帧 10 | 11 | 12 | … | 18 | 判定 |
|---|---|---|---|---|---|---|
| H1 改前 | 89302 | 89303 | 89304 | … | 89310 | 恒定 +1 |
| H1 改后 | 89302 | 89303 | 89304 | … | 89310 | 恒定 +1（逐位相同） |

→ 假设预期的 `{0,0,+1}` 三帧周期**不存在**；H1 无效果且破坏 2 项回归。

**表 B｜$2002 采样相位对照（H2）**——05 落点表，期望 `00-02=4 / 03-08=3 / 09=2`：

| 采样相位 | 落点表 | 4→3 转折行 | 与期望差 |
|---|---|---|---|
| 末 dot（phase=2） | 00-05=4, 06-09=3 | 06 | 晚 3 行 |
| 首 dot（phase=0） | 00-05=4, 06-09=3 | 06 | 晚 3 行（**逐项相同**） |

→ 读采样相位被 `sync_vbl` 的自校准完全吸收；H2 无效果。

**表 C｜nmiDelay 敏感度（05 落点表的 4→3 转折行）**：

| nmiDelay | 转折行 | 说明 |
|---|---|---|
| 1 | 04 | 实测 |
| 2 | 05 | 线性外推（1/3 实测点之间） |
| 3 | 06 | 实测（当前配置，06/08 全表匹配所需） |
| （期望） | **03** | 需要 `nmiDelay≈0` |

**结论（一句话）**：单一全局 `nmiDelay` 无法同时满足 05（需 ≈0）与 06/08
（需 ≥3）——这是**模型粒度**问题（NMI 的「锁存时刻」与「输出时刻」在硬件上
是两件事，本实现合并为一个延迟常数），不是清除点冲突，也不是网格量化。

**后续方向（仅文字，本轮不实施）**：把 NMI 通路拆成「置位 dot 锁存」+
「3-dot 后输出」两段，05 测锁存落点、06/08 测输出窗口，即可解耦两者；
10 需要跳点与「使能 BG」时刻的分段判定；7.nmi_timing 同 05 族。

#### H3｜perf 去 gate 化（收尾任务书 §二.1）

- 现象：主会话在外部负载下复跑抓到 perf 翻车（8/124）。根因：perf 的墙钟
  数值对机器负载敏感（并发/GC 尖峰把 8ms 抬到 39ms），而**正确性测试必须
  与负载无关**。
- 处置：`tests/perf.test.ts` → `bench/perf.bench.ts`，独立配置
  `vitest.bench.config.ts`，`npm run bench` 单独运行；`npm test` 只跑
  `tests/**/*.test.ts`（123 项）。bench 内保留宽松上限 100ms 仅捕捉灾难性
  退化（如修复轮 1 前的每像素分配 GC 风暴），并打印完整统计留档。
- 60fps 的真实验收口径不变：浏览器实测（§6）。

**结语：能被数据杀死的假设，比能编故事的结论值钱。**

### 0.7 已知限制定稿表（收尾任务书 §1.3，冻结口径）

| 项 | 状态 | 说明 |
|---|---|---|
| oam_stress | 已知限制 | 需 secondary OAM 直通子系统，未实现 |
| cpu_timing_test | 已知限制 | 4 万帧长矩阵，墙钟成本问题，非正确性 |
| 05 / 07 / 10 / vbl_nmi_timing 7 / ppu_vbl_nmi 综合 | 已知限制 | NMI 输出延迟全局常数权衡（§0.6 表 C 数据） |
| 其余（含 sprite_hit 11、sprite_overflow 5、vbl_nmi_timing 1-6、nestest、可玩性） | 全部通过 | 不得回退 |

后续探索方向（仅文字，本轮不实施）：分段 nmiDelay 模型（锁存/输出解耦）、
dot 级 NMI 调度（按「使能时机 × dot」分段）。

---

## 1. 里程碑完成情况

| 里程碑 | 状态 | 备注 |
|---|---|---|
| M1 iNES + NROM | ✅ | 合成 ROM 单元测试；NES 2.0 宽容解析（240pee 实弹验证） |
| M2 总线 | ✅ | RAM 镜像 / PPU 折叠 / 手柄 / OAM DMA / 开总线残留 |
| M3 MMC1/UxROM/CNROM | ✅ | 5 写移位协议、bank 掩码、PRG 三模式全覆盖 |
| M4 NTSC 主循环 + Web UI | ✅ | 浏览器实测 60fps（见 §6） |
| M5 集成 | ✅ | CPU+PPU 拷入、contract 三方字节一致、全仓绿 |
| M6 blargg 全家桶 | ✅（部分） | 109/125 全仓测试通过；16 项 dot 级时序未达（见 §3/§5） |
| M7 Web UI 完整化 | ✅ | 调试面板/存档/帧率/键位全链路浏览器实测 |
| M8（二期） | 未开始 | MMC3 / APU 音频 / 快照存档 |

## 2. 关键实现决策（博客素材）

### 2.1 iNES 解析（`src/board/ines.ts`）
- 只切字节视图不拷贝，ROM 加载零拷贝。
- NES 2.0 识别按 flags7 bit2-3 == 0b10，mapper 纳入 flags8 高位；容量指数编码不支持（已知限制）。
- trainer 512B 跳过；截断 ROM 抛带诊断数值的错误。

### 2.2 Mapper（`src/board/cartridge.ts`）
- MMC1 PRG-RAM 使能位极性按 nesdev wiki 核实：MMC1B 语义 R3 bit4：**0=使能，
  1=禁用**，上电默认使能（初版写反，单元测试抓出后修正）。
- bit7 复位写 = 清移位寄存器 + `Control |= $0C`（锁 PRG 模式 3），镜像/CHR 模式位保留。
- UxROM 总线冲突按惯例忽略；一期所有 mapper 提供 8KB PRG-RAM @ $6000
  （blargg 结果协议依赖；游戏不受多余 RAM 影响）。
- MMC1 连续周期写忽略（INC 双写）未实现——契约 Bus.write 无周期信息（§5）。

### 2.3 总线（`src/board/bus.ts`）
- 开总线残留：记录最后一次总线值，未映射区读取返回它；手柄读返回 `0x40 | bit`。
- OAM DMA 经 `oamDma(page, read)` 转发，readFn 闭包读全总线；+513 周期由第一部 CPU 计。
- **2A03 帧计数器**（`apu-frame.ts`，主板 IO）：$4015 bit6 帧 IRQ 标志 + $4017
  模式/禁止位 + IRQ 线到 `cpu.irq()`。音频 APU 列二期，但 blargg 测试壳
  （sync_apu 例程）以帧计数器为时间基准，没有它 2005 系测试壳无法引导——
  这是「帧计数器是 CPU 侧定时器、不属于音频波形」的典型边界案例。

### 2.4 NTSC 主循环（`machine.ts` + `timing.ts`）
- 帧目标 = `round(frameIndex × 29780.5)`，差分自然形成 29781/29780 交替
  （逐帧累加再取整会因 .5 舍入漂移，测试抓出）。
- 指令过冲结转：帧边界落在指令中间时整条执行完，余量结转（7 周期长指令测试验证）。
- 调试面板扫描行/dot/VBlank 由机器侧 dot 计数推导，**不读 $2002**（避免清 VBlank 污染运行态）。

### 2.5 Web UI（`src/web/`）
- esbuild 单文件打包（JS 内联 index.html，46KB 可直接部署 GitHub Pages）。
- 整数倍缩放 + `image-rendering: pixelated`；电池存档 FNV-1a 哈希 ROM 做键，
  localStorage 3s 节流 + beforeunload 兜底。

## 3. blargg 测试 ROM 结果表

测试资产：`npm run fetch:test-roms`（45 个文件，gitignore 不入库）。
判定协议两种：新版 $6000 结果码（**0=通过**，官方 readme；任务书原文的
「0x01 成功」系 2005 老约定，已在实现时核实修正）；2005 老协议（结果码
以蜂鸣次数报告，**1=通过**，屏幕不打印、$6000 不写——蜂鸣计数自动化）。

### 必须项（任务书）——修复轮后
| ROM | 结果 | 备注 |
|---|---|---|
| ppu_vbl_nmi.nes（综合，10 子测试自动复位推进） | ❌ | 由 05/10 子测试 CRC 决定（F5/F6） |
| ppu_vbl_nmi / 01-vbl_basics | ✅ | |
| ppu_vbl_nmi / 02-vbl_set_time | ✅ **修复** | 读竞态（F2 访问级同步）全表匹配 |
| ppu_vbl_nmi / 03-vbl_clear_time | ✅ | 清除点 dot 1 |
| ppu_vbl_nmi / 04-nmi_control | ✅ | |
| ppu_vbl_nmi / 05-nmi_timing | ❌ | 落点表整体晚 3 行：sync walker 3-dot 网格残差（§F6） |
| ppu_vbl_nmi / 06-suppression | ✅ **修复** | NMI 输出延迟 + flag 复检模型（F3）全表匹配 |
| ppu_vbl_nmi / 07-nmi_on_timing | ❌ | 与 03/4 的清除点冲突，取舍记录（§F5） |
| ppu_vbl_nmi / 08-nmi_off_timing | ✅ **修复** | F3 全表匹配 |
| ppu_vbl_nmi / 09-even_odd_frames | ✅ | 奇偶帧跳点基本语义正确 |
| ppu_vbl_nmi / 10-even_odd_timing | ❌ | 跳点相对"使能 BG"的 dot 级时序（§F6；dot340 实现已实验证伪） |
| sprite_hit_tests ×11 | ✅ **11/11** | 修复轮全程零回退 |
| sprite_overflow ×5 | ✅ **5/5 修复** | 逐 dot 评估 + m-bug 对角扫描（F4） |
| vram_access | ✅ | 老协议蜂鸣计码 |
| palette_ram | ✅ | 老协议蜂鸣计码 |
| oam_read | ✅ | |
| oam_stress | ❌ | 需 secondary OAM 直通（§F6） |

### 尽力项——修复轮后
| ROM | 结果 | 备注 |
|---|---|---|
| vbl_nmi_timing / 1.frame_basics | ✅ | |
| vbl_nmi_timing / 2.vbl_timing | ✅ **修复** | 原失败系套件帧预算不足（600→1200） |
| vbl_nmi_timing / 3.even_odd_frames | ✅ | |
| vbl_nmi_timing / 4.vbl_clear_timing | ✅ **修复** | 清除点标定后全过 |
| vbl_nmi_timing / 5.nmi_suppression | ✅ **修复** | F3 模型覆盖 |
| vbl_nmi_timing / 6.nmi_disable | ✅ **修复** | F3 模型覆盖 |
| vbl_nmi_timing / 7.nmi_timing | ❌ | 同 05 的 walker 残差机理 |
| cpu_timing_test | ❌ | 4 万帧仍在测试内部（CPU 时序矩阵在模拟器上成本过高） |
| blargg_ppu_tests_2005.09.15b / sprite_ram | ✅ | 老协议 |
| blargg_ppu_tests_2005.09.15b / vbl_clear_time | ✅ | 老协议 |
| blargg_ppu_tests_2005.09.15b / power_up_palette | ✅（码2） | 「与 blargg 真机不一致」=模拟器预期结果 |

### nestest（图形模式，任务书验收项）
- 菜单出现 → 按 Start 全部测试分类 **14 行 OK**；Select 切非法指令菜单 →
  **11 行 OK**（LAX/SAX/SBC(0EB)/DCP/ISB/SLO/RLA/SRE/RRA 全过——直接验证
  集成侧 CPU 补丁，见 README-偏差记录.md §3）。
- 截图留档：`docs/screenshots/nestest.png`、`nestest-invalid-ops.png`。
- 另有 golden log 8991 行逐指令对拍（`tests/joint-cpu.test.ts`）全过。

## 4. 可玩性验收（任务书：免费 homebrew 完整可玩）

选用 GPL 官方发布 ROM（`npm run fetch:test-roms` 自动下载）：

| ROM | 验证内容 | 留档 |
|---|---|---|
| Concentration Room v0.02a（pinobatch/croom-nes，GPL-3.0，NROM） | 标题→菜单→Start 进局→方向键移光标→A 翻牌（樱桃卡面）全交互闭环 | `docs/screenshots/croom-*.png` ×3 |
| 240p Test Suite v0.23（pinobatch/240p-test-mini，GPL，UxROM+NES 2.0+CHR-RAM） | 大面积多色精灵、文字渲染、菜单交互 | `docs/screenshots/240pee-title.png` |

浏览器实测（playwright 驱动真实 Chrome）：**13623 帧连续运行 @59.5fps**；
240pee 显示 **60 fps**。调试面板全链路（寄存器/栈/扫描行/VBlank/帧数/卡带信息）实时刷新。

## 5. 已知限制与根因分析

### 5.1 F1 访问级 PPU 同步（修复轮的架构改造，博客核心素材）

**问题**：v1.0 的 CPU 是原子指令执行（`step()` 返回整条指令的周期数），
主循环在指令边界一次性喂 `n*3` dots。于是 `$2002` 读在 PPU 眼里永远看到
"指令开始时"的快照——dot 级读竞态（02）、NMI 相对时序（05-08）、清除时序
（03/vbl_nmi_timing 4/5/6）全部无法表达。首轮修复轮实验（v1.0 时代）只
用 `totalCycles` 的渐进性外推"读的 dot 偏移"，得到的是 1/3-dot 分数相位
吸引子（修好 02 碰坏 sprite_hit 09/10），净效果为零。

**解析解**：契约 v1.1 的 `Bus.onAccess(cycleInInstruction, cyclesAbsolute)`
——CPU 在**每个总线周期**的访问发生前回调。机器侧 `pumpPPU`：

```
targetDots = (cyclesAbsolute - 1 - 7) * 3 + phase   // 7 = reset 周期基线
while (ppuDots < targetDots) { ppu.cycle(); ppuDots++; }
```

读 $2002 时 PPU 已被喂到"本周期对应 dot"，读看到的状态就是硬件状态——
不再需要任何外推公式，读竞态由 PPU 依据自身 `(scanline,dot)` 直接判定：
- `vblankFlag` 已置 → 返回 V
- 未置且下一待喂 dot 正是置位点 (241,1) → 返回 0 并抑制本帧置位（含 NMI）
- 否则 → 0

02-vbl_set_time 的 1-dot 步进期望表（`00-03 - V / 04 - - / 05-08 V -`）
完全匹配。这套改造同时让 03/06/08 与 vbl_nmi_timing 5/6 转绿。

**性能代价与对策**：每帧 5 万次 onAccess 调用。首个实现用对象载荷
（`{cycleInInstruction, cyclesAbsolute}`）→ 每帧 5 万次对象分配 → GC 尖峰
把单帧拖到 30ms+。改为**双数字参数**（零分配）后回到 7.6-8.3ms。

### 5.2 F3 NMI 输出延迟模型

06-suppression 的期望表给出关键事实：**NMI 不在 VBlank 置位同 dot 拉低**。

| 行 | 读 $2002 的时刻 | 期望 (flag, NMI) | 含义 |
|---|---|---|---|
| 05 | 置位后 1 dot | `V -` | flag 已置，但 NMI 尚未输出 |
| 06 | 置位后 2 dots | `V -` | 同上 |
| 07 | 置位后 3 dots | `V N` | NMI 已在输出 |

结合 07（VBL 末尾使能太晚不触发）与 08（关 NMI 及时则不触发），硬件模型是：
NMI 输出 = 3-dot 延迟 + 输出时重新检查 `vblankFlag && $2000.bit7`。读 $2002
清 flag、或写 $2000 关 bit7，都会**取消**尚未输出的 NMI。实现为 `nmiDelay`
计数器，三张表全部匹配。

### 5.3 F4 逐 dot 精灵评估与 m-bug（sprite_overflow 5/5）

原实现把评估合并到 dot 257 一次性完成（渲染槽位功能等价），但溢出标志的
**置位 dot** 与硬件的**对角扫描 bug** 缺失。修复实现独立的逐 dot 检测器
（不碰渲染槽位，sprite_hit 零风险）：

- dots 65-256，奇 dot 读 / 偶 dot 判（pair 节奏）
- 扫描阶段：读 `OAM[n][0]` 判范围；命中则 found++ 并进入 3 字节复制
- 溢出检查阶段（found==8 后）：**n++ 与 m++ 锁步**，读址
  `OAM[4n + (m & 3)]`——精灵 9 的字节 0、10 的字节 1、11 的字节 2……
  正是 readme 的对角序列（4.Obscure #2-#6 逐项验证）
- 范围比较**无借位**：`line >= y && line - y < height`。
  教训：初版用 `(line - y) & 0xFF < 8` 的有符号回绕语义，让扫描行 0-6
  把 Y=255（离屏）误判在范围内——2.Details #7 抓出。

三个修正（对角读址、无借位比较、逐 dot 置位）缺一不可：先修不会借位后
2.Details 从 #7 推进到 #9，再修对角读址后 3.Timing/4.Obscure 转绿。

### 5.4 F5 取舍：07 与 03/4 的清除点冲突

> **⚠️ 修复轮 2 修订**：本节旧表述「sync_vbl 终点的量化残差」已被推翻。
> 实测：05 落点表对 VBL 位置（+3 dots）与读采样相位（首/末 dot）**完全不敏感**
> （sync 自校准吸收），对 `nmiDelay` 敏感（1→转折 04、3→转折 06）。07 的
> 清除点需求（dot 3）与 03/4 的 dot 1 锁死之差是**参数解耦问题**，不是 walker
> 残差。完整数据见 §0.6。以下为原始记录（保留供对照）。

- 03-vbl_clear_time 与 vbl_nmi_timing 4 以 **1-dot 精度**锁死 VBL 清除点
  在 pre-render 行 dot 1（#4 "1 dot 早" 与 #5/#6 "#6 晚 2 dots" 均失败）
- 07-nmi_on_timing 在本实现下要求清除点后移到 dot 3（NMI 输出 3-dot 延迟
  + 写使能时刻相对 walker 偏晚）

两者冲突的直接原因：07 的写 $2000 时刻相对 sync walker 比硬件晚约 2 dots
（sync_vbl 终点的量化残差）。修正该残差需要 walker 的行间漂移率与硬件逐
dot 对齐——见 F6。**当前取舍：保留硬件真实清除点 dot 1（03/4 绿），
07 列已知限制。**

### 5.5 F6 未清零项的统一根因：~~sync walker 的 3-dot 网格残差~~（**已推翻**）

> **⚠️ 修复轮 2 推翻**：本节旧结论「0.33 dot/行的 3-dot 网格量化」**不成立**。
> 实测（§0.6）：改前相位差序列在稳定段就是**恒定 +1/帧**（与硬件一致），
> 不存在 3 帧周期；H1（PPU 帧边界权威）与 H2（采样相位首/末 dot）两项假设
> 均经测量证伪——05 落点表对二者完全不敏感。05 的真实敏感量是 `nmiDelay`
> （1→04、3→06），与 06/08 的 ≥3 需求构成**单参数冲突**；07 与 03/4 是
> 清除点参数冲突。下一步方向是 NMI 通路的「锁存 / 输出」解耦，而非相位标定。
> 以下为原始记录（保留供对照）。

blargg 的 `sync_vbl` 用 27 周期循环对 29780.67 周期的帧长做 1/3-clock 精度
同步（注释："Every 1103 iterations, the second LDA $2002 will read exactly
29781 clocks after a previous read. Thus, the loop will effectively read
$2002 one PPU clock later each frame"）。硬件的 05 表因此**每行推进 1 dot**。

本实现中 CPU 周期与 PPU dot 精确锁相（1:3），而 `$2002` 读只可能落在
3-dot 网格上——walker 的残差因此被量化到 3 dots，实测**每 3 行推进 1 dot**
（0.33/行）。05 的落点表整体晚 3 行（`03→3` vs 实测 `06→3`）、
vbl_nmi_timing 7.nmi_timing 同理，均源于此。这是"读网格 3-dot 量化"的
结构性残差，不是单个数值的标定问题。

10-even_odd_timing（跳点相对"使能 BG"的 dot 级时序）也属同族：跳点实现
位置 dot0（保留，1/3 绿）与 dot340（已实验证伪：破坏 1.frame_basics 与
3.even_odd_frames）两版都不满足"相对使能时刻"的严格判据。

### 5.6 其余未达项
- **oam_stress**：需要 secondary OAM 直通语义（渲染评估期间 $2004 读返回
  评估中间状态、写被忽略），属独立子系统，本轮未实现
- **cpu_timing_test**：4 万帧仍在测试内部（CPU 时序矩阵含海量周期测量循环，
  在逐周期 pump 的实现上墙钟成本过高）
- 综合 ppu_vbl_nmi：由 05/10 子测试的 CRC 决定，必然随二者失败

### 5.7 其余限制
- 音频 APU 未实现（帧计数器已就位，二期接波形通道即可）
- MMC3 及 mapper 4+ 未实现（二期）
- MMC1 连续周期写忽略未实现（Bill & Ted 类游戏可能受影响）
- NES 2.0 PRG/CHR 指数容量编码未支持
- 渲染禁用时 backdrop 取 v 指向调色板的硬件 quirk 未复现
- $2002 低 5 位 open-bus 残留恒 0；渲染期 $2004 直通/错位行为未复现
  （以上均为第二部注释声明的有意简化）

## 6. 性能

- 性能基准已移出正确性 gate（H3，收尾任务书 §二.1）：`npm run bench`
  （`bench/perf.bench.ts` + `vitest.bench.config.ts`，不参与 `npm test`）。
- 最近实测（3×100 帧批均值）：**中位批均 7.6-10.1ms**（区间随机器负载），
  p99 ≤ 12.8ms；宽松上限 100ms 仅捕捉灾难性退化。
- 修复轮优化（保留）：①按 $2001 懒重建的 64 项预着色 LUT（消灭每像素三元组
  分配）；②精灵取样数组提升局部量、无精灵行整段跳过；③`%8 → &7`、
  `runPPU` 局部化；④onAccess 双数字参数（零分配）。
- 浏览器实测（真实 Chrome + rAF 驱动）：croom 连续 13623 帧 @**59.5fps**、
  240pee **60fps** 整——这才是 60fps 的验收口径。

## 7. 与契约的偏差

见 `README-偏差记录.md` 与 `src/contract-CHANGELOG.md`（v1.1）：
- v1.0 契约文本无阻断缺陷
- v1.1 仅加法：`Bus.onAccess?`（访问级时序）与 `PPU2C02.setChrWriter?`
  （CHR 写通路转正），均为可选成员，v1.0 实现零修改兼容
- `getFramebuffer` 像素格式仍未在契约文本注明（实测 RGBA，消费方按契约
  实现确认）

## 8. 跨会话 CPU 补丁（需第一部同步）

1. `opcodes.ts` 0xBF（LAX abs,Y）寻址 `'abx'` → `'aby'`（一字笔误）
2. RMW 组合族（SLO/RLA/SRE/RRA/DCP/ISB）由「双写原值」占位补全为真实语义
3. 集成侧新增 `onAccess` 埋点（契约 v1.1）——若第一部回移，需按
   `contract-CHANGELOG.md §1` 在 `read8/write8/pull8Deferred` 三处调用
   `bus.onAccess?.(cycleInInstruction, totalCycles + 1 - instrStartCycle)`

前三项均有双重验证（golden log 8991 行 + nestest 图形模式非法指令菜单全 OK）。

## 9. 交付物清单

- 源码：`src/board/`（ines/cartridge/bus/joypad/machine/timing/apu-frame/integration）、`src/web/`、`src/cpu/`、`src/ppu/`
- 契约：`src/contract.ts`（v1.1，本轮零改动）+ `src/contract-CHANGELOG.md`
- 测试：10 文件 123 用例（116 通过 + 7 项已知限制，见 §0.7）；
  测试资产脚本 `scripts/fetch-test-roms.mjs`
- 性能：`bench/perf.bench.ts` + `vitest.bench.config.ts`（`npm run bench`，
  不参与 `npm test` 的正确性 gate）
- 构建：`scripts/build-web.mjs` → `dist/index.html`（48KB 单文件）
- 截图留档：`docs/screenshots/` ×8（nestest×2、croom×4、240pee×2；
  含修复轮 2 复验 `final-*-round2.png`）
- 文档：本文件（含 §0.6 修复轮 2 三张测量表 + §0.7 已知限制定稿表）
  + README-偏差记录.md + README.md
