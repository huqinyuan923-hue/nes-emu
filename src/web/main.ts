/**
 * Web UI 主逻辑（M4 最小可用 + M7 完整化）。
 *
 * 结构：main.ts 持有 NESMachine + FrameDriver，负责
 *   - ROM 加载（文件选择 / 拖拽）
 *   - 画面：256×240 ImageData → 离屏 canvas → 整数倍缩放上屏（pixelated）
 *   - 输入：键盘 → Joypad 位掩码（方向键 / Z=A / X=B / Enter=Start / Shift=Select）
 *   - 控制：暂停 / 复位 / 单步指令 / 单帧
 *   - 调试面板：CPU 寄存器、P 标志位、栈顶、扫描行/dot/VBlank（推导值，不碰 $2002）、帧率
 *   - 电池存档：localStorage 按内容哈希键持久化（3s 脏检查 + beforeunload 兜底）
 *
 * 帧缓冲格式约定（与第二部的对齐点）：RGBA，每像素 4 字节，长度 256*240*4。
 */
import {
  JOY_A,
  JOY_B,
  JOY_DOWN,
  JOY_LEFT,
  JOY_RIGHT,
  JOY_SELECT,
  JOY_START,
  JOY_UP,
} from '../board/joypad';
import { NESMachine } from '../board/machine';
import { getMachineFactories } from '../board/integration';
import { FrameDriver } from '../board/timing';
import { SCREEN_H, SCREEN_W } from '../contract';

// ---------- DOM 快捷获取 ----------
function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少 DOM 元素 #${id}`);
  return node as T;
}

const canvas = el<HTMLCanvasElement>('screen');
const ctx = canvas.getContext('2d')!;
const offscreen = document.createElement('canvas');
offscreen.width = SCREEN_W;
offscreen.height = SCREEN_H;
const offCtx = offscreen.getContext('2d')!;
const imageData = offCtx.createImageData(SCREEN_W, SCREEN_H);

const statusEl = el<HTMLDivElement>('status');
const fpsEl = el<HTMLSpanElement>('fps');

const buttons = {
  open: el<HTMLButtonElement>('btnOpen'),
  pause: el<HTMLButtonElement>('btnPause'),
  reset: el<HTMLButtonElement>('btnReset'),
  step: el<HTMLButtonElement>('btnStep'),
  frame: el<HTMLButtonElement>('btnFrame'),
  saveSram: el<HTMLButtonElement>('btnSaveSram'),
  wipeSram: el<HTMLButtonElement>('btnWipeSram'),
};
const fileInput = el<HTMLInputElement>('fileInput');
const dropHint = el<HTMLDivElement>('dropHint');
const muteToggle = el<HTMLInputElement>('muteToggle');

// ---------- 全局状态 ----------
let machine: NESMachine | null = null;
let driver: FrameDriver | null = null;
let paused = false;
let romName = '';
let romKey = '';
let sramDirty = false;
let sramSaveTimer = 0;
let panelTimer = 0;

// ---------- 状态栏 ----------
function setStatus(msg: string, kind: '' | 'ok' | 'err' = ''): void {
  statusEl.textContent = msg;
  statusEl.className = kind;
}

// ---------- ROM 哈希（FNV-1a 32bit，用于存档键） ----------
function romHash(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ---------- ROM 加载 ----------
function loadRom(bytes: Uint8Array, name: string): void {
  try {
    // 换卡前把旧卡电池存档落盘
    if (machine && romKey && sramDirty) saveSramNow();

    machine = new NESMachine(getMachineFactories());
    machine.loadRom(bytes);

    romName = name;
    romKey = romHash(bytes);
    sramDirty = false;

    // 电池存档回灌
    if (machine.cartridge?.battery) {
      const saved = localStorage.getItem(sramStorageKey());
      if (saved) {
        machine.writeSram(base64ToBytes(saved));
        setStatus(`已回灌本机电池存档`, 'ok');
      }
    }

    const cart = machine.cartridge!;
    el<HTMLSpanElement>('cMapper').textContent = String(cart.mapperNumber);
    el<HTMLSpanElement>('cPrg').textContent = `${(cart.prg.length / 1024) | 0}KB`;
    el<HTMLSpanElement>('cChr').textContent = cart.chrIsRam ? '8KB RAM' : `${(cart.chr.length / 1024) | 0}KB`;
    el<HTMLSpanElement>('cBattery').textContent = cart.battery ? '有' : '无';
    updateSramButtons();

    for (const b of Object.values(buttons)) b.disabled = false;
    dropHint.style.display = 'none';
    setStatus(`${name} 装载成功，运行中`, 'ok');
    startRunning();
    refreshPanel();
  } catch (e) {
    machine = null;
    for (const b of Object.values(buttons)) b.disabled = true;
    setStatus(String(e instanceof Error ? e.message : e), 'err');
  }
}

// ---------- SRAM 持久化 ----------
function sramStorageKey(): string {
  return `nes-main:sram:${romKey}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function saveSramNow(): void {
  if (!machine || !romKey || !machine.cartridge?.battery) return;
  const sram = machine.readSram();
  if (sram) {
    localStorage.setItem(sramStorageKey(), bytesToBase64(sram));
    sramDirty = false;
  }
}

function updateSramButtons(): void {
  const hasBattery = machine?.cartridge?.battery ?? false;
  buttons.saveSram.disabled = !hasBattery;
  buttons.wipeSram.disabled = !hasBattery;
}

// ---------- 渲染 ----------
let scale = 1;

function fitScale(): void {
  const availW = Math.max(window.innerWidth - 60, 256);
  const availH = Math.max(window.innerHeight - 60, 240);
  scale = Math.max(1, Math.floor(Math.min(availW / SCREEN_W, availH / SCREEN_H)));
  canvas.width = SCREEN_W * scale;
  canvas.height = SCREEN_H * scale;
  ctx.imageSmoothingEnabled = false;
}

function render(): void {
  if (!machine) return;
  const fb = machine.getFramebuffer();
  imageData.data.set(fb);
  offCtx.putImageData(imageData, 0, 0);
  ctx.drawImage(offscreen, 0, 0, canvas.width, canvas.height);
}

// ---------- 运行控制 ----------
function startRunning(): void {
  if (!machine) return;
  paused = false;
  buttons.pause.textContent = '暂停';
  if (!driver) {
    driver = new FrameDriver({
      stepFrame: () => {
        if (!machine) return;
        machine.stepFrame();
        render();
        markSramDirtyIfNeed();
      },
      onFps: (fps) => {
        fpsEl.textContent = `${fps} fps`;
      },
    });
  }
  driver.start();
}

function pause(): void {
  paused = true;
  driver?.stop();
  buttons.pause.textContent = '继续';
  saveSramNow();
}

function togglePause(): void {
  if (!machine) return;
  if (paused) startRunning();
  else pause();
}

function manualStep(kind: 'instruction' | 'frame'): void {
  if (!machine) return;
  if (!paused) pause();
  if (kind === 'instruction') machine.stepInstruction();
  else machine.stepFrame();
  render();
  refreshPanel();
}

function resetMachine(): void {
  if (!machine) return;
  machine.reset();
  render();
  refreshPanel();
  setStatus('已复位（卡带寄存器保留，等同真机 RESET 键）', 'ok');
}

// ---------- 调试面板 ----------
const hex = (v: number, w: number) => v.toString(16).toUpperCase().padStart(w, '0');

const P_BITS = ['C', 'Z', 'I', 'D', 'B', 'U', 'V', 'N'] as const;

function refreshPanel(): void {
  if (!machine) return;
  const s = machine.getCpuState();
  el<HTMLSpanElement>('dPc').textContent = `$${hex(s.pc, 4)}`;
  el<HTMLSpanElement>('dA').textContent = `$${hex(s.a, 2)}`;
  el<HTMLSpanElement>('dX').textContent = `$${hex(s.x, 2)}`;
  el<HTMLSpanElement>('dY').textContent = `$${hex(s.y, 2)}`;
  el<HTMLSpanElement>('dSp').textContent = `$${hex(s.sp, 2)}`;
  el<HTMLSpanElement>('dP').textContent = `$${hex(s.p, 2)}`;
  el<HTMLSpanElement>('dCyc').textContent = s.totalCycles.toLocaleString();
  el<HTMLSpanElement>('dFrame').textContent = String(machine.framesRun);
  el<HTMLSpanElement>('dLine').textContent = String(machine.scanline);
  el<HTMLSpanElement>('dDot').textContent = String(machine.dot);
  const vblEl = el<HTMLSpanElement>('dVbl');
  vblEl.textContent = machine.inVblank ? '是' : '否';
  vblEl.className = machine.inVblank ? 'v hot' : 'v';
  el<HTMLSpanElement>('dNmi').textContent = String(machine.nmiCount);

  // 标志位
  el<HTMLDivElement>('flags').innerHTML =
    'P 位：' +
    P_BITS.map((name, i) => {
      const bit = [0, 1, 2, 3, 4, 5, 6, 7][i]!;
      const on = (s.p & (1 << bit)) !== 0;
      return `<b>${name}${on ? 1 : 0}</b>`;
    }).join(' ');

  // 栈顶 8 字节（SP 指向下一个空闲位）
  let stackText = '';
  for (let i = 0; i < 8; i++) {
    const addr = 0x0100 + ((s.sp + 1 + i) & 0xff);
    stackText += `$${hex(addr, 4)}: ${hex(machine.bus.read(addr), 2)}\n`;
  }
  el<HTMLDivElement>('stack').textContent = stackText.trimEnd();

  // 镜像模式实时显示（MMC1 可切换）
  if (machine.cartridge) {
    const m = machine.cartridge.getMirroring();
    const names: Record<string, string> = {
      horizontal: '水平',
      vertical: '垂直',
      four: '四屏',
      'single-lower': '单屏下',
      'single-upper': '单屏上',
    };
    el<HTMLSpanElement>('cMirror').textContent = names[m] ?? m;
    el<HTMLSpanElement>('cSram').textContent = machine.cartridge.prgRamEnabled() ? '启用' : '禁用';
  }
}

function markSramDirtyIfNeed(): void {
  // 脏判定从简：电池卡运行中即视为脏，3 秒节流落盘（8KB base64 写 localStorage
  // 成本可忽略，比给 bus 加写钩子更简单可靠）
  if (machine?.cartridge?.battery) {
    sramDirty = true;
    const now = Date.now();
    if (now - sramSaveTimer > 3000) {
      sramSaveTimer = now;
      saveSramNow();
    }
  }
  // 调试面板 250ms 节流刷新，避免每帧动 DOM
  if (Date.now() - panelTimer > 250) {
    panelTimer = Date.now();
    refreshPanel();
  }
}

// ---------- 输入 ----------
const KEY_MAP: Record<string, number> = {
  ArrowLeft: JOY_LEFT,
  ArrowRight: JOY_RIGHT,
  ArrowUp: JOY_UP,
  ArrowDown: JOY_DOWN,
  KeyZ: JOY_A,
  KeyX: JOY_B,
  Enter: JOY_START,
  ShiftLeft: JOY_SELECT,
  ShiftRight: JOY_SELECT,
};

function joyMask(e: KeyboardEvent): number | undefined {
  return KEY_MAP[e.code];
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.repeat) {
    if (joyMask(e)) e.preventDefault();
    return;
  }
  switch (e.code) {
    case 'KeyP':
      togglePause();
      return;
    case 'KeyF':
      manualStep('frame');
      return;
    case 'KeyR':
      resetMachine();
      return;
  }
  const mask = joyMask(e);
  if (mask !== undefined && machine) {
    e.preventDefault();
    const pad = machine.bus.joypads[0]!;
    pad.setButtons(pad.getButtons() | mask);
  }
}

function onKeyUp(e: KeyboardEvent): void {
  const mask = joyMask(e);
  if (mask !== undefined && machine) {
    e.preventDefault();
    const pad = machine.bus.joypads[0]!;
    pad.setButtons(pad.getButtons() & ~mask);
  }
}

// ---------- 事件接线 ----------
buttons.open.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (file) await loadFromFile(file);
  fileInput.value = '';
});

async function loadFromFile(file: File): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  loadRom(bytes, file.name);
}

// 拖拽加载
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropHint.classList.add('drag');
});
document.addEventListener('dragleave', () => dropHint.classList.remove('drag'));
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dropHint.classList.remove('drag');
  const file = e.dataTransfer?.files?.[0];
  if (file) void loadFromFile(file);
});

buttons.pause.addEventListener('click', togglePause);
buttons.reset.addEventListener('click', resetMachine);
buttons.step.addEventListener('click', () => manualStep('instruction'));
buttons.frame.addEventListener('click', () => manualStep('frame'));
buttons.saveSram.addEventListener('click', () => {
  saveSramNow();
  setStatus('存档已保存到本机', 'ok');
});
buttons.wipeSram.addEventListener('click', () => {
  if (romKey) localStorage.removeItem(sramStorageKey());
  sramDirty = false;
  setStatus('本机存档已清除', 'ok');
});
muteToggle.addEventListener('change', () => {
  // 音频 APU 二期实现，占位开关
  setStatus('音频尚未实现（APU 列二期），开关暂不生效');
});
window.addEventListener('resize', fitScale);
window.addEventListener('beforeunload', () => {
  if (sramDirty) saveSramNow();
});
document.addEventListener('keydown', onKeyDown);
document.addEventListener('keyup', onKeyUp);
window.addEventListener('pagehide', () => driver?.stop());

// ---------- 启动 ----------
fitScale();
setStatus('就绪 —— 拖入 .nes 文件，或点击「打开 ROM」');
export {};
