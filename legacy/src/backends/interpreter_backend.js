const TNA_CPU = require('../core/cpu');
const TNA_Bus = require('../core/bus');
const TNA_GPU = require('../devices/gpu');
const TNAHostRuntime = require('../runtime/host_runtime');
const { ABI, GPU_COMMANDS, MMIO, REGISTERS, SCREEN } = require('../config');


function alignUp(value, align = 1) {
  const step = Math.max(1, align | 0);
  return (Math.ceil((value | 0) / step) * step) | 0;
}

function computeExecutableLayout(executable, memorySize, mmioHighMark) {
  const textEnd = ((executable?.textBase || 0) + (executable?.text?.length || 0)) | 0;
  const dataWords = executable?.dataImage?.length || 0;
  const dataEnd = dataWords ? (((executable?.dataBase || 0) + dataWords) | 0) : 0;
  const programEnd = Math.max(textEnd, dataEnd, MMIO.HEAP_BASE) | 0;
  const heapBase = alignUp(programEnd + 0x100, 0x100);
  const topOfRam = ((memorySize | 0) - 1) | 0;
  const safeTop = topOfRam >= (mmioHighMark | 0) ? topOfRam : ((MMIO.KEYBOARD - 1) | 0);
  const stackStart = Math.max(heapBase + 0x400, safeTop) | 0;
  const stackLimit = Math.max(heapBase + 0x200, stackStart - 0x2000) | 0;
  return { heapBase, stackStart, stackLimit, programEnd };
}

class InterpreterBackend {
  constructor(memorySize = 65536, options = {}) {
    this.kind = 'interpreter';
    this.memorySize = memorySize | 0;
    this.videoWidth = options.videoWidth ?? SCREEN.WIDTH;
    this.videoHeight = options.videoHeight ?? SCREEN.HEIGHT;
    this.bus = new TNA_Bus(this.memorySize);
    this.cpu = new TNA_CPU();
    this.gpu = new TNA_GPU(MMIO.GPU_BASE, this.videoWidth, this.videoHeight);
    this.cpu.connectBus(this.bus);
    this.bus.attachDevice(this.gpu);
    this.hostRuntime = options.hostRuntime || new TNAHostRuntime(options);
    this.bus.setHostApi(this.hostRuntime);
    this.output = { audioEvents: [] };
    this.reset();
  }

  get ram() { return this.bus.ram; }
  get frameBuffer() { return this.gpu.frameBuffer; }

  reset(startPC = MMIO.PROGRAM_BASE) {
    this.bus.ram.fill(0);
    this.gpu.clear(0);
    this.cpu.reset(startPC | 0);
    this.bus.ram[MMIO.BOOT_FLAG] = 0;
    this.bus.ram[MMIO.TICKS_LO] = 0;
    this.bus.ram[MMIO.TICKS_HI] = 0;
    this.output.audioEvents = [];
  }

  setPC(value) {
    this.cpu.setPC(value | 0);
  }

  loadProgram(program, base = MMIO.PROGRAM_BASE) {
    this.bus.ram.set(Int32Array.from(program), base | 0);
    this.cpu.setPC(base | 0);
    return { entry: base | 0 };
  }

  loadExecutable(executable) {
    this.bus.ram.set(executable.text, executable.textBase | 0);
    if (executable.dataImage?.length) {
      this.bus.ram.set(executable.dataImage, executable.dataBase | 0);
    }
    const hostImports = executable.link?.unresolvedFunctionImports || executable.meta?.link?.unresolvedFunctionImports || [];
    if (this.hostRuntime && typeof this.hostRuntime.setImportNames === 'function') {
      this.hostRuntime.setImportNames(hostImports);
    }
    if (this.hostRuntime && typeof this.hostRuntime.configureExecutable === 'function') {
      this.hostRuntime.configureExecutable(executable);
    }
    const layout = computeExecutableLayout(executable, this.memorySize, this.gpu.endAddr | 0);
    this.cpu.setPC(executable.entry | 0);
    this.cpu.SP = layout.stackStart | 0;
    this.cpu.REG[REGISTERS.SP] = this.cpu.SP;
    this.cpu.REG[REGISTERS.BP] = this.cpu.SP;
    if (this.hostRuntime && typeof this.hostRuntime.configureMemoryLayout === 'function') {
      this.hostRuntime.configureMemoryLayout(layout);
    }
    this.layout = layout;
    return { entry: executable.entry | 0, layout };
  }

  step() {
    if (this.cpu.halted) return;
    this.cpu.step();
    this.tick();
  }

  run(maxCycles = 100000) {
    for (let cycle = 0; cycle < maxCycles && !this.cpu.halted; cycle++) {
      this.step();
    }
    return this.snapshot();
  }

  tick() {
    this.bus.ram[MMIO.TICKS_LO] = (this.bus.ram[MMIO.TICKS_LO] + 1) | 0;
    if (this.bus.ram[MMIO.TICKS_LO] === 0) {
      this.bus.ram[MMIO.TICKS_HI] = (this.bus.ram[MMIO.TICKS_HI] + 1) | 0;
    }

    const cmd = this.bus.ram[MMIO.GPU_CMD] | 0;
    if (cmd !== GPU_COMMANDS.NONE) {
      if (cmd === GPU_COMMANDS.CLEAR) {
        this.gpu.clear(this.bus.ram[MMIO.GPU_ARG0] | 0);
      }
      this.bus.ram[MMIO.GPU_CMD] = GPU_COMMANDS.NONE;
    }

    if (this.hostRuntime && typeof this.hostRuntime.tick === 'function') {
      this.hostRuntime.tick(this.bus, this.cpu);
    }

    if ((this.bus.ram[MMIO.AUDIO_CMD] | 0) !== 0) {
      this.output.audioEvents.push({
        freq: this.bus.ram[MMIO.AUDIO_FREQ] | 0,
        dur: this.bus.ram[MMIO.AUDIO_DUR] | 0,
      });
      this.bus.ram[MMIO.AUDIO_CMD] = 0;
    }
  }

  read(addr) {
    return this.bus.read(addr | 0);
  }

  write(addr, value) {
    this.bus.write(addr | 0, value | 0);
  }

  saveFrame(filename) {
    this.gpu.saveImage(filename);
  }

  snapshot() {
    return {
      backend: this.kind,
      halted: this.cpu.halted,
      PC: this.cpu.PC,
      SP: this.cpu.SP,
      BP: this.cpu.REG[REGISTERS.BP] | 0,
      FLAGS: { ...this.cpu.FLAGS },
      framebuffer: this.gpu.frameBuffer,
      audioEvents: [...this.output.audioEvents],
    };
  }
}

module.exports = InterpreterBackend;
