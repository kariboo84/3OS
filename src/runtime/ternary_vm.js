const fs = require('fs');
const path = require('path');
const C_Compiler = require('../compiler/c_transpiler');
const Assembler = require('../compiler/assembler');
const InterpreterBackend = require('../backends/interpreter_backend');
const GPUFPGAEmulatorBackend = require('../backends/gpu_fpga_backend');
const { readExecutableFile, writeExecutableFile } = require('./executable');
const { MMIO, REGISTERS, SCREEN, SYSCALLS } = require('../config');

function createBackend(memorySize, options = {}) {
  const type = options.backend || 'interpreter';
  if (type === 'interpreter') return new InterpreterBackend(memorySize, options);
  if (type === 'gpu-fpga-emulator') return new GPUFPGAEmulatorBackend(memorySize, options);
  throw new Error(`Backend inconnu: ${type}`);
}

class TernaryVM {
  constructor(memorySize = 65536, options = {}) {
    this.memorySize = memorySize | 0;
    this.videoWidth = options.videoWidth ?? SCREEN.WIDTH;
    this.videoHeight = options.videoHeight ?? SCREEN.HEIGHT;
    this.backend = createBackend(this.memorySize, options);
    this.output = { text: '' };
    this.currentMode = 'desktop';
    this.MMIO = MMIO;
    this.installMathTables();
  }

  get bus() { return this.backend.bus; }
  get cpu() { return this.backend.cpu; }
  get gpu() { return this.backend.gpu; }
  get frameBuffer() { return this.backend.frameBuffer; }
  get audioEvents() { return this.backend.output?.audioEvents || this.backend.audioEvents || []; }

  reset() {
    this.backend.reset(MMIO.PROGRAM_BASE);
    this.installMathTables();
    this.output.text = '';
    this.currentMode = 'desktop';
  }

  installMathTables() {
    const ram = this.backend.ramMirror || this.backend.ram;
    if (!ram) return;
    const scale = 256;
    for (let angle = 0; angle < 360; angle++) {
      const radians = (angle * Math.PI) / 180;
      ram[MMIO.SIN_TABLE + angle] = Math.round(Math.sin(radians) * scale) | 0;
      ram[MMIO.COS_TABLE + angle] = Math.round(Math.cos(radians) * scale) | 0;
    }
  }

  loadProgram(program, base = MMIO.PROGRAM_BASE) {
    if (program && program.kind === 'tna-executable') {
      return this.backend.loadExecutable(program);
    }
    return this.backend.loadProgram(program, base | 0);
  }

  loadExecutable(executable) {
    return this.backend.loadExecutable(executable);
  }

  run(maxCycles = 100000) {
    return this.backend.run(maxCycles);
  }

  step() {
    return this.backend.step();
  }

  tick() {
    return this.backend.tick();
  }

  read(addr) {
    return this.backend.read(addr | 0);
  }

  write(addr, value) {
    this.backend.write(addr | 0, value | 0);
  }

  saveFrame(filename) {
    if (typeof this.backend.saveFrame === 'function') {
      return this.backend.saveFrame(filename);
    }
    throw new Error('Backend sans export framebuffer');
  }

  fillRect(x, y, w, h, color) {
    const x0 = Math.max(0, x | 0);
    const y0 = Math.max(0, y | 0);
    const x1 = Math.min(this.videoWidth, x0 + (w | 0));
    const y1 = Math.min(this.videoHeight, y0 + (h | 0));
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        this.frameBuffer[yy * this.videoWidth + xx] = color | 0;
      }
    }
  }

  drawText(x, y, text, color = 0x00FFFFFF) {
    let cursor = x | 0;
    for (const ch of String(text)) {
      this.drawGlyph(cursor, y | 0, ch, color);
      cursor += 6;
    }
  }

  drawGlyph(x, y, ch, color) {
    const glyph = FONT[ch] || FONT['?'];
    for (let row = 0; row < glyph.length; row++) {
      const bits = glyph[row];
      for (let col = 0; col < 5; col++) {
        if ((bits >> (4 - col)) & 1) {
          const px = x + col;
          const py = y + row;
          if (px >= 0 && px < this.videoWidth && py >= 0 && py < this.videoHeight) {
            this.frameBuffer[py * this.videoWidth + px] = color | 0;
          }
        }
      }
    }
  }

  drawDesktop() {
    this.frameBuffer.fill(0x006699CC);
    this.fillRect(0, 0, this.videoWidth, 18, 0x00D0D0D0);
    this.drawText(6, 5, '3OS', 0x00000000);
    this.fillRect(10, 28, this.videoWidth - 20, this.videoHeight - 38, 0x00F3F3F3);
    this.fillRect(10, 28, this.videoWidth - 20, 14, 0x00C4C4C4);
    this.drawText(16, 32, 'Terminal / Wolf3D Loader', 0x00000000);
  }

  keyToAscii(raw) {
    if (raw === '\n' || raw === 'Enter') return 13;
    if (raw === 'Escape') return 27;
    if (raw === 'Tab') return 9;
    if (raw === 'Backspace') return 8;
    if (raw === 'Space') return 32;
    if (raw.length === 1) return raw.charCodeAt(0) | 0;
    return 0;
  }

  onKeyboardText(text) {
    if (!text) return;
    const raw = String(text);
    const ascii = this.keyToAscii(raw);
    if (ascii) {
      this.write(MMIO.INPUT, ascii);
      this.write(MMIO.KEYBOARD, ascii);
    }
    if (this.backend && this.backend.hostRuntime && typeof this.backend.hostRuntime.enqueueKey === 'function') {
      this.backend.hostRuntime.enqueueKey(raw, true, this.bus);
    }
  }

  releaseKey(text) {
    if (!text) return;
    const raw = String(text);
    const ascii = this.keyToAscii(raw);
    if (ascii && (this.read(MMIO.KEYBOARD) | 0) === ascii) {
      this.write(MMIO.KEYBOARD, 0);
    }
    if (this.backend && this.backend.hostRuntime && typeof this.backend.hostRuntime.enqueueKey === 'function') {
      this.backend.hostRuntime.enqueueKey(raw, false, this.bus);
    }
  }

  onMouse(x, y, buttons = 0) {
    this.write(MMIO.MOUSE, x | 0);
    this.write(MMIO.MOUSE + 1, y | 0);
    this.write(MMIO.MOUSE + 2, buttons | 0);
  }

  snapshot() {
    const backendState = this.backend.snapshot();
    return {
      ...backendState,
      textOutput: this.output.text,
      framebuffer: this.frameBuffer,
      audioEvents: [...this.audioEvents],
    };
  }
}

class TernaryTerminal {
  constructor(vm) {
    this.vm = vm;
    this.projectRoot = path.resolve(__dirname, '..', '..');
    this.bootMessage = '3OS ready';
    this.loadedSource = '';
    this.loadedPath = null;
    this.loadedBinaryPath = null;
    this.lastExecutable = null;
    this.compiler = new C_Compiler();
  }

  resolvePath(name) {
    const cwd = process.cwd();
    const roots = [cwd, this.projectRoot, path.join(cwd, '..')].map((value) => path.resolve(value));
    const candidates = new Set([name]);
    for (const root of roots) {
      candidates.add(path.join(root, name));
      candidates.add(path.join(root, 'games', name));
      candidates.add(path.join(root, 'games', `${name}.c`));
      candidates.add(path.join(root, 'build', name));
      candidates.add(path.join(root, 'build', `${name}.tna`));
    }
    return [...candidates].find((candidate) => fs.existsSync(candidate));
  }

  compileLoaded() {
    if (!this.loadedSource) {
      const fallback = this.resolvePath('games/wolf3d.c');
      if (!fallback) throw new Error(`Source introuvable: games/wolf3d.c (cwd=${process.cwd()})`);
      this.loadedPath = fallback;
      this.loadedSource = fs.readFileSync(fallback, 'utf8');
    }
    this.lastExecutable = this.compiler.compile(this.loadedSource, MMIO.PROGRAM_BASE, this.loadedPath || path.join(this.projectRoot, 'games', 'wolf3d.c'));
    return this.lastExecutable;
  }

  resolveWolf3DVariant(variant = 'auto') {
    const normalized = String(variant || 'auto').toLowerCase();
    const aliases = {
      historical: 'linked',
      official: 'official',
      ingame: 'ingame',
      screens: 'screens',
      patched: 'patched',
      preview: 'bridge',
      raycaster: 'source',
      toy: 'source',
      c: 'source',
    };
    const kind = aliases[normalized] || normalized;
    const variants = {
      bridge:   { kind: 'binary', label: 'historical-bridge',        path: 'build/wolf3d_historical_bridge.tna' },
      linked:   { kind: 'binary', label: 'historical-linked',        path: 'build/wolf3d_historical_linked.tna' },
      official: { kind: 'binary', label: 'historical-official-main', path: 'build/wolf3d_historical_official.tna' },
      patched:  { kind: 'binary', label: 'patched-994-stubs',        path: 'build/wolf3d_patched.tna' },
      ingame:   { kind: 'binary', label: 'historical-ingame-loop',   path: 'build/wolf3d_historical_ingame.tna' },
      screens:  { kind: 'binary', label: 'historical-screens',       path: 'build/wolf3d_historical_screens.tna' },
      source:   { kind: 'source', label: 'source',                   path: 'games/wolf3d.c' },
    };
    if (kind !== 'auto' && variants[kind]) {
      const targetPath = this.resolvePath(variants[kind].path);
      if (!targetPath) return null;
      return { ...variants[kind], resolved: targetPath };
    }
    for (const name of ['patched', 'bridge', 'official', 'ingame', 'linked', 'screens', 'source']) {
      const candidate = variants[name];
      const targetPath = this.resolvePath(candidate.path);
      if (targetPath) return { ...candidate, resolved: targetPath };
    }
    return null;
  }

  launchWolf3D(variant = 'auto', key = '') {
    const target = this.resolveWolf3DVariant(variant);
    if (!target) throw new Error('Aucune cible Wolf3D disponible');
    if (target.kind === 'source') {
      this.loadedPath = target.resolved;
      this.loadedSource = fs.readFileSync(target.resolved, 'utf8');
      this.compileLoaded();
      const outPath = path.join(process.cwd(), 'build', 'wolf3d.tna');
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      writeExecutableFile(outPath, this.lastExecutable);
      this.loadedBinaryPath = outPath;
      const cycles = this.resolveWolf3DCycleBudget(target.label);
      const result = this.runExecutable(this.lastExecutable, key, cycles);
      return `wolf3d launched target=${target.label} words=${this.lastExecutable.text.length} key=${key || '-'} ${result}`;
    }
    this.lastExecutable = readExecutableFile(target.resolved);
    this.loadedBinaryPath = target.resolved;
    const cycles = this.resolveWolf3DCycleBudget(target.label);
    let result = this.runExecutable(this.lastExecutable, key, cycles);
    let extra = '';
    if (!key && /official/i.test(target.label)) extra = this.nudgeOfficialBoot();
    return `wolf3d launched target=${target.label} image=${path.relative(process.cwd(), target.resolved)} key=${key || '-'} ${result}${extra}`;
  }

  countVisiblePixels() {
    let visible = 0;
    const fb = this.vm.frameBuffer || [];
    for (let i = 0; i < fb.length; i++) {
      if (fb[i]) visible++;
    }
    return visible;
  }

  nudgeOfficialBoot() {
    if (!this.lastExecutable) return '';
    if (this.countVisiblePixels() > 256) return '';
    this.vm.onKeyboardText('Enter');
    let remaining = 3000000;
    const slice = 120000;
    while (remaining > 0 && !this.vm.snapshot().halted) {
      const budget = Math.min(slice, remaining);
      this.vm.run(budget);
      remaining -= budget;
      if (this.vm.backend && this.vm.backend.hostRuntime && typeof this.vm.backend.hostRuntime.stepHostAssists === 'function') {
        this.vm.backend.hostRuntime.stepHostAssists(this.vm.bus);
      }
    }
    return this.countVisiblePixels() > 256 ? ' nudged=Enter' : '';
  }

  resolveWolf3DCycleBudget(label = '') {
    const name = String(label || '').toLowerCase();
    if (name.includes('ingame'))  return 20000000;
    if (name.includes('official')) return 15000000;
    if (name.includes('patched')) return 500000;
    if (name.includes('screens')) return 8000000;
    return 5000000;
  }

  runExecutable(executable, key = '', maxCycles = 5000000) {
    this.vm.reset();
    this.vm.currentMode = 'graphics';
    const seedKey = key ? String(key)[0] : '';
    if (seedKey) this.vm.onKeyboardText(seedKey);
    this.vm.loadExecutable(executable);
    let remaining = Math.max(0, maxCycles | 0);
    const slice = 120000;
    while (remaining > 0 && !this.vm.snapshot().halted) {
      const budget = Math.min(slice, remaining);
      this.vm.run(budget);
      remaining -= budget;
      if (this.vm.backend && this.vm.backend.hostRuntime && typeof this.vm.backend.hostRuntime.stepHostAssists === 'function') {
        this.vm.backend.hostRuntime.stepHostAssists(this.vm.bus);
      }
    }
    return `pc=${this.vm.cpu ? this.vm.cpu.PC : this.vm.backend.PC} halted=${this.vm.snapshot().halted}`;
  }

  execute(command) {
    const [cmd, ...rest] = String(command).trim().split(/\s+/).filter(Boolean);
    if (!cmd) return '';
    switch (cmd) {
      case 'help':
        return 'help | load <file.c> | compile | build [out.tna] | boot <file.tna> | run [key] | wolf3d [key] | wolf3d patched [key] | wolf3d bridge [key] | wolf3d official [key] | wolf3d ingame [key] | wolf3d linked [key] | wolf3d screens [key] | wolf3d source [key] | backend | cls | beep';
      case 'backend':
        return `backend=${this.vm.backend.kind}`;
      case 'cls':
        this.vm.currentMode = 'desktop';
        this.vm.drawDesktop();
        this.vm.output.text = '';
        return 'screen cleared';
      case 'beep':
        this.vm.write(MMIO.AUDIO_FREQ, 440);
        this.vm.write(MMIO.AUDIO_DUR, 120);
        this.vm.write(MMIO.AUDIO_CMD, 1);
        this.vm.tick();
        return 'beep queued';
      case 'load': {
        const target = rest.join(' ') || 'games/wolf3d.c';
        const resolved = this.resolvePath(target);
        if (!resolved) return `not found: ${target}`;
        this.loadedPath = resolved;
        this.loadedBinaryPath = null;
        this.loadedSource = fs.readFileSync(resolved, 'utf8');
        return `loaded ${path.relative(process.cwd(), resolved)}`;
      }
      case 'compile': {
        const executable = this.compileLoaded();
        return `compiled ${this.loadedPath ? path.basename(this.loadedPath) : 'buffer'} -> ${executable.text.length} words`;
      }
      case 'build': {
        const executable = this.compileLoaded();
        const outName = rest[0] || 'build/wolf3d.tna';
        const outPath = path.isAbsolute(outName) ? outName : path.join(process.cwd(), outName);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        writeExecutableFile(outPath, executable);
        this.loadedBinaryPath = outPath;
        return `built ${path.relative(process.cwd(), outPath)} text=${executable.text.length} data=${executable.dataImage.length}`;
      }
      case 'boot': {
        const target = rest.join(' ');
        if (!target) return 'usage: boot <file.tna>';
        const resolved = this.resolvePath(target);
        if (!resolved) return `not found: ${target}`;
        this.lastExecutable = readExecutableFile(resolved);
        this.loadedBinaryPath = resolved;
        return `boot image loaded ${path.relative(process.cwd(), resolved)}`;
      }
      case 'run': {
        if (!this.lastExecutable) this.compileLoaded();
        return this.runExecutable(this.lastExecutable, rest[0] || '');
      }
      case 'wolf3d': {
        const variants = new Set(['auto', 'bridge', 'linked', 'historical', 'official', 'ingame', 'screens', 'source', 'preview', 'raycaster', 'toy', 'c']);
        let variant = 'auto';
        let key = '';
        if (rest[0] && variants.has(String(rest[0]).toLowerCase())) {
          variant = rest[0];
          key = rest[1] || '';
        } else {
          key = rest[0] || '';
        }
        return this.launchWolf3D(variant, key);
      }
      default:
        return `unknown command: ${cmd}`;
    }
  }
}

const ASM = Object.freeze({
  SET: 'SET',
  LOAD: 'LOAD',
  STORE: 'STORE',
  OUT: 'OUT',
  HALT: 'HALT',
  JMP: 'JMP',
});

function compile(program) {
  const asm = new Assembler(MMIO.PROGRAM_BASE);
  const R0 = REGISTERS.R0;
  const R1 = REGISTERS.R1;
  for (const instr of program) {
    const [op, arg] = instr;
    switch (op) {
      case ASM.SET: asm.movI(R0, arg | 0); break;
      case ASM.LOAD: asm.movI(R1, arg | 0); asm.load(R0, R1); break;
      case ASM.STORE: asm.movI(R1, arg | 0); asm.store(R1, R0); break;
      case ASM.OUT: asm.syscall(SYSCALLS.NOP); break;
      case ASM.JMP: asm.jmp(arg | 0); break;
      case ASM.HALT: asm.halt(); break;
      default: throw new Error(`Pseudo ASM inconnu: ${op}`);
    }
  }
  return asm.getProgram();
}

const FONT = {
  ' ': [0,0,0,0,0,0,0],
  '!': [0b00100,0b00100,0b00100,0b00100,0b00100,0,0b00100],
  '-': [0,0,0,0b11111,0,0,0],
  '.': [0,0,0,0,0,0b01100,0b01100],
  '/': [0b00001,0b00010,0b00100,0b01000,0b10000,0,0],
  ':': [0,0b01100,0b01100,0,0b01100,0b01100,0],
  '<': [0b00010,0b00100,0b01000,0b10000,0b01000,0b00100,0b00010],
  '>': [0b01000,0b00100,0b00010,0b00001,0b00010,0b00100,0b01000],
  '?': [0b11110,0b00001,0b00010,0b00100,0,0,0b00100],
  '|': [0b00100,0b00100,0b00100,0b00100,0b00100,0b00100,0b00100],
  '0': [0b01110,0b10001,0b10011,0b10101,0b11001,0b10001,0b01110],
  '1': [0b00100,0b01100,0b00100,0b00100,0b00100,0b00100,0b01110],
  '2': [0b01110,0b10001,0b00001,0b00010,0b00100,0b01000,0b11111],
  '3': [0b11110,0b00001,0b00001,0b01110,0b00001,0b00001,0b11110],
  '4': [0b00010,0b00110,0b01010,0b10010,0b11111,0b00010,0b00010],
  '5': [0b11111,0b10000,0b10000,0b11110,0b00001,0b00001,0b11110],
  '6': [0b01110,0b10000,0b10000,0b11110,0b10001,0b10001,0b01110],
  '7': [0b11111,0b00001,0b00010,0b00100,0b01000,0b01000,0b01000],
  '8': [0b01110,0b10001,0b10001,0b01110,0b10001,0b10001,0b01110],
  '9': [0b01110,0b10001,0b10001,0b01111,0b00001,0b00001,0b01110],
  'A': [0b01110,0b10001,0b10001,0b11111,0b10001,0b10001,0b10001],
  'B': [0b11110,0b10001,0b10001,0b11110,0b10001,0b10001,0b11110],
  'C': [0b01110,0b10001,0b10000,0b10000,0b10000,0b10001,0b01110],
  'D': [0b11110,0b10001,0b10001,0b10001,0b10001,0b10001,0b11110],
  'E': [0b11111,0b10000,0b10000,0b11110,0b10000,0b10000,0b11111],
  'F': [0b11111,0b10000,0b10000,0b11110,0b10000,0b10000,0b10000],
  'G': [0b01110,0b10001,0b10000,0b10111,0b10001,0b10001,0b01110],
  'H': [0b10001,0b10001,0b10001,0b11111,0b10001,0b10001,0b10001],
  'I': [0b01110,0b00100,0b00100,0b00100,0b00100,0b00100,0b01110],
  'J': [0b00001,0b00001,0b00001,0b00001,0b10001,0b10001,0b01110],
  'K': [0b10001,0b10010,0b10100,0b11000,0b10100,0b10010,0b10001],
  'L': [0b10000,0b10000,0b10000,0b10000,0b10000,0b10000,0b11111],
  'M': [0b10001,0b11011,0b10101,0b10101,0b10001,0b10001,0b10001],
  'N': [0b10001,0b11001,0b10101,0b10011,0b10001,0b10001,0b10001],
  'O': [0b01110,0b10001,0b10001,0b10001,0b10001,0b10001,0b01110],
  'P': [0b11110,0b10001,0b10001,0b11110,0b10000,0b10000,0b10000],
  'Q': [0b01110,0b10001,0b10001,0b10001,0b10101,0b10010,0b01101],
  'R': [0b11110,0b10001,0b10001,0b11110,0b10100,0b10010,0b10001],
  'S': [0b01111,0b10000,0b10000,0b01110,0b00001,0b00001,0b11110],
  'T': [0b11111,0b00100,0b00100,0b00100,0b00100,0b00100,0b00100],
  'U': [0b10001,0b10001,0b10001,0b10001,0b10001,0b10001,0b01110],
  'V': [0b10001,0b10001,0b10001,0b10001,0b10001,0b01010,0b00100],
  'W': [0b10001,0b10001,0b10001,0b10101,0b10101,0b10101,0b01010],
  'X': [0b10001,0b10001,0b01010,0b00100,0b01010,0b10001,0b10001],
  'Y': [0b10001,0b10001,0b01010,0b00100,0b00100,0b00100,0b00100],
  'Z': [0b11111,0b00001,0b00010,0b00100,0b01000,0b10000,0b11111],
};
for (const ch of 'abcdefghijklmnopqrstuvwxyz') FONT[ch] = FONT[ch.toUpperCase()];

module.exports = { TernaryVM, TernaryTerminal, ASM, compile };
