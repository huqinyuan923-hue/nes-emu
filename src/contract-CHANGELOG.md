# 契约变更记录（v1.0 → v1.1）

> 冻结契约仅做**加法**变更：所有既有接口签名、字段、常量保持不变，
> 新增均为可选成员。v1.0 实现无需任何修改即兼容 v1.1。
> 授权来源：修复轮任务书 §契约 v1.1 预授权范围（协调方裁决）。

## 变更总览

| # | 变更 | 类型 | 动机 |
|---|---|---|---|
| 1 | `Bus.onAccess?(cycleInInstruction, cyclesAbsolute): void` | 新增可选方法 | dot 级时序：CPU 在每次总线访问前回调，暴露指令内周期序号与绝对周期数，供 PPU 实现 `$2002` 读竞态、NMI 相对时序等硬件行为（blargg ppu_vbl_nmi 时序族测试的前提） |
| 2 | `PPU2C02.setChrWriter?(write): void` | 新增可选方法 | CHR-RAM 支持：`chrUnits=0` 的 ROM 开机经 $2007 上传字模，契约 v1.0 仅有 `setChrReader` 读通路，导致 CHR-RAM 游戏与 blargg 2005 系测试壳无法引导（实测缺陷，见 README-偏差记录.md §2.2） |

> 设计注记：onAccess 采用**双数字参数**而非对象载荷。该回调处于最热路径
> （每次总线访问一次，每帧数十万次），对象载荷会造成灾难性 GC 压力
> （实测引入 30ms 级停顿）；数字参数零分配。

## 明细

### 1. `Bus.onAccess?`（可选回调）

```ts
export interface Bus {
  read(addr: u16): u8;
  write(addr: u16, value: u8): void;
  /** v1.1 可选：CPU 在每次总线访问（读/写，含哑读）发生前回调 */
  onAccess?(cycleInInstruction: number, cyclesAbsolute: number): void;
}
```

语义约定：
- CPU 实现在**每个总线周期**的访问发生前调用一次（每周期恰好一次，
  dummy read / RMW 双写各算一次）。
- `cyclesAbsolute` 为本访问所占周期的绝对序号（1 基，含 reset 的 7 周期）；
  `cycleInInstruction` 为指令内 1 基序号。
- 回调存在与否不影响功能正确性，只影响 dot 级时序精度
  （无此回调的宿主走无竞态路径）。

### 2. `PPU2C02.setChrWriter?`（可选方法）

```ts
export interface PPU2C02 {
  // ...v1.0 既有成员不变...
  /** v1.1 可选：注入 CHR 写通路。$2007 对 $0000-$1FFF 的写转发到此回调
   *  （CHR-ROM 由卡带侧忽略，CHR-RAM 落地）。未注入时此类写无效。 */
  setChrWriter?(write: (addr: u16, value: u8) => void): void;
}
```

## 兼容性

- v1.0 的 CPU 实现：不实现 `onAccess` 调用也能工作（宿主缺 dot 级时序）。
- v1.0 的 PPU 实现：`setChrWriter` 为可选，宿主按存在性探测调用。
- v1.0 的总线宿主：无任何感知。
