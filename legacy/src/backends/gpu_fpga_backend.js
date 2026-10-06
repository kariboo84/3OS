const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ABI, MMIO, SCREEN } = require('../config');
const { writeExecutableFile } = require('../runtime/executable');

function normalizeCommand(command) {
  if (!command) return null;
  if (Array.isArray(command)) return command.map(String);
  if (typeof command === 'string') {
    const parts = command.match(/(?:"[^"]*"|'[^']*'|\S)+/g) || [];
    return parts.map((part) => part.replace(/^['"]|['"]$/g, ''));
  }
  throw new Error('bridgeCommand doit être une chaîne ou un tableau');
}

class GPUFPGAEmulatorBackend {
  constructor(memorySize = 65536, options = {}) {
    this.kind = 'gpu-fpga-emulator';
    this.memorySize = memorySize | 0;
    this.videoWidth = options.videoWidth ?? SCREEN.WIDTH;
    this.videoHeight = options.videoHeight ?? SCREEN.HEIGHT;
    this.frameBuffer = new Int32Array(this.videoWidth * this.videoHeight);
    this.ramMirror = new Int32Array(this.memorySize);
    this.audioEvents = [];
    this.halted = false;
    this.PC = MMIO.PROGRAM_BASE;
    this.SP = ABI.STACK_START;
    this.BP = ABI.STACK_START;
    this.FLAGS = { Z: false, N: false, G: false, L: false };
    const defaultBridge = options.disableDefaultBridge ? null : [process.execPath, path.resolve(__dirname, '..', '..', 'tools', 'tna_gpu_bridge_ref.js')];
    this.bridgeCommand = normalizeCommand(options.bridgeCommand || process.env.TNA_GPU_BRIDGE || defaultBridge);
    this.bridgeEnv = { ...process.env, ...(options.bridgeEnv || {}) };
    this.bridgeWorkDir = options.bridgeWorkDir || path.resolve(__dirname, '..', '..');
    this.tempRoot = options.tempRoot || path.join(os.tmpdir(), 'tna-gpu-fpga');
    this.pendingExecutable = null;
    this.lastBridgeRun = null;
  }

  reset(startPC = MMIO.PROGRAM_BASE) {
    this.ramMirror.fill(0);
    this.frameBuffer.fill(0);
    this.audioEvents = [];
    this.halted = false;
    this.PC = startPC | 0;
    this.SP = ABI.STACK_START;
    this.BP = ABI.STACK_START;
    this.FLAGS = { Z: false, N: false, G: false, L: false };
    this.ramMirror[MMIO.BOOT_FLAG] = 0;
    this.pendingExecutable = null;
    this.lastBridgeRun = null;
  }

  setPC(value) {
    this.PC = value | 0;
  }

  loadProgram(program, base = MMIO.PROGRAM_BASE) {
    this.ramMirror.set(Int32Array.from(program), base | 0);
    this.PC = base | 0;
    this.pendingExecutable = {
      kind: 'tna-executable',
      abi: 'tna-cdecl-v1',
      entry: base | 0,
      textBase: base | 0,
      text: Int32Array.from(program),
      dataBase: MMIO.DATA_BASE,
      dataImage: new Int32Array(0),
    };
    return { entry: base | 0 };
  }

  loadExecutable(executable) {
    this.ramMirror.set(executable.text, executable.textBase | 0);
    if (executable.dataImage?.length) {
      this.ramMirror.set(executable.dataImage, executable.dataBase | 0);
    }
    const textEnd = ((executable?.textBase || 0) + (executable?.text?.length || 0)) | 0;
    const dataWords = executable?.dataImage?.length || 0;
  const dataEnd = dataWords ? (((executable?.dataBase || 0) + dataWords) | 0) : 0;
    const programEnd = Math.max(textEnd, dataEnd, MMIO.HEAP_BASE) | 0;
    const heapBase = Math.ceil((programEnd + 0x100) / 0x100) * 0x100;
    const mmioHighMark = (MMIO.GPU_BASE + this.frameBuffer.length) | 0;
    const topOfRam = (this.memorySize - 1) | 0;
    const safeTop = topOfRam >= mmioHighMark ? topOfRam : ((MMIO.KEYBOARD - 1) | 0);
    this.PC = executable.entry | 0;
    this.SP = Math.max(heapBase + 0x400, safeTop) | 0;
    this.BP = this.SP;
    this.pendingExecutable = executable;
    this.layout = { programEnd, heapBase, stackStart: this.SP, stackLimit: Math.max(heapBase + 0x200, this.SP - 0x2000) | 0 };
    return { entry: executable.entry | 0, layout: this.layout };
  }

  prepareBridgePayload(maxCycles = 0) {
    if (!this.pendingExecutable) throw new Error('Aucun exécutable chargé pour le backend GPU/FPGA');
    const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const runDir = path.join(this.tempRoot, runId);
    fs.mkdirSync(runDir, { recursive: true });

    const executablePath = path.join(runDir, 'program.tna');
    const inputPath = path.join(runDir, 'input.json');
    const outputPath = path.join(runDir, 'output.json');

    writeExecutableFile(executablePath, this.pendingExecutable);
    const payload = {
      contract: 'tna-gpu-fpga-bridge-v1',
      maxCycles: maxCycles | 0,
      executablePath,
      outputPath,
      memorySize: this.memorySize,
      videoWidth: this.videoWidth,
      videoHeight: this.videoHeight,
      registers: {
        PC: this.PC,
        SP: this.SP,
        BP: this.BP,
        FLAGS: { ...this.FLAGS },
      },
      mmio: {
        bootFlag: this.ramMirror[MMIO.BOOT_FLAG] | 0,
        keyboard: this.ramMirror[MMIO.KEYBOARD] | 0,
        input: this.ramMirror[MMIO.INPUT] | 0,
        mouse: [
          this.ramMirror[MMIO.MOUSE] | 0,
          this.ramMirror[MMIO.MOUSE + 1] | 0,
          this.ramMirror[MMIO.MOUSE + 2] | 0,
        ],
      },
    };
    fs.writeFileSync(inputPath, JSON.stringify(payload, null, 2));
    return { runDir, executablePath, inputPath, outputPath, payload };
  }

  applyBridgeResult(result) {
    if (result.registers) {
      this.PC = result.registers.PC | 0;
      this.SP = result.registers.SP | 0;
      this.BP = result.registers.BP | 0;
      this.FLAGS = {
        Z: !!result.registers.FLAGS?.Z,
        N: !!result.registers.FLAGS?.N,
        G: !!result.registers.FLAGS?.G,
        L: !!result.registers.FLAGS?.L,
      };
    }
    this.halted = !!result.halted;
    if (Array.isArray(result.audioEvents)) {
      this.audioEvents = result.audioEvents.map((evt) => ({ freq: evt.freq | 0, dur: evt.dur | 0 }));
    }
    if (Array.isArray(result.framebuffer)) {
      this.frameBuffer.fill(0);
      this.frameBuffer.set(Int32Array.from(result.framebuffer.slice(0, this.frameBuffer.length)));
      for (let i = 0; i < this.frameBuffer.length; i++) {
        this.ramMirror[MMIO.GPU_BASE + i] = this.frameBuffer[i] | 0;
      }
    }
    if (Array.isArray(result.ram)) {
      this.ramMirror.fill(0);
      this.ramMirror.set(Int32Array.from(result.ram.slice(0, this.ramMirror.length)));
    }
  }

  run(maxCycles = 100000) {
    if (!this.bridgeCommand || this.bridgeCommand.length === 0) {
      throw new Error('GPUFPGAEmulatorBackend: bridgeCommand absent. Définissez TNA_GPU_BRIDGE ou passez options.bridgeCommand.');
    }

    const bridge = this.prepareBridgePayload(maxCycles);
    const [command, ...args] = this.bridgeCommand;
    const proc = spawnSync(command, [...args, bridge.inputPath], {
      cwd: this.bridgeWorkDir,
      env: this.bridgeEnv,
      encoding: 'utf8',
    });

    this.lastBridgeRun = {
      command: [command, ...args],
      runDir: bridge.runDir,
      status: proc.status,
      stdout: proc.stdout || '',
      stderr: proc.stderr || '',
    };

    if (proc.error) throw proc.error;
    if (proc.status !== 0) {
      throw new Error(`Bridge GPU/FPGA échec (${proc.status}): ${proc.stderr || proc.stdout || 'sans sortie'}`);
    }
    if (!fs.existsSync(bridge.outputPath)) {
      throw new Error(`Bridge GPU/FPGA: sortie absente ${bridge.outputPath}`);
    }

    const result = JSON.parse(fs.readFileSync(bridge.outputPath, 'utf8'));
    this.applyBridgeResult(result);
    return this.snapshot();
  }

  step() {
    return this.run(1);
  }

  tick() {}

  read(addr) {
    return this.ramMirror[addr | 0] | 0;
  }

  write(addr, value) {
    const index = addr | 0;
    this.ramMirror[index] = value | 0;
    if (index >= MMIO.GPU_BASE && index < MMIO.GPU_BASE + this.frameBuffer.length) {
      this.frameBuffer[index - MMIO.GPU_BASE] = value | 0;
    }
  }

  saveFrame(filename) {
    const ppm = [];
    ppm.push(`P3\n${this.videoWidth} ${this.videoHeight}\n255\n`);
    for (let i = 0; i < this.frameBuffer.length; i++) {
      const pixel = this.frameBuffer[i] | 0;
      const r = (pixel >>> 16) & 0xFF;
      const g = (pixel >>> 8) & 0xFF;
      const b = pixel & 0xFF;
      ppm.push(`${r} ${g} ${b}\n`);
    }
    fs.writeFileSync(filename, ppm.join(''));
  }

  snapshot() {
    return {
      backend: this.kind,
      halted: this.halted,
      PC: this.PC,
      SP: this.SP,
      BP: this.BP,
      FLAGS: { ...this.FLAGS },
      framebuffer: this.frameBuffer,
      audioEvents: [...this.audioEvents],
      bridge: this.lastBridgeRun ? { ...this.lastBridgeRun } : null,
    };
  }
}

module.exports = GPUFPGAEmulatorBackend;
