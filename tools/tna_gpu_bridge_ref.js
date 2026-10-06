#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const InterpreterBackend = require('../src/backends/interpreter_backend');
const { readExecutableFile } = require('../src/runtime/executable');
const { MMIO } = require('../src/config');

function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('usage: node tools/tna_gpu_bridge_ref.js <input.json>');
    process.exit(2);
  }

  const payload = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  if (payload.contract !== 'tna-gpu-fpga-bridge-v1') {
    throw new Error(`unsupported contract: ${payload.contract}`);
  }

  const executable = readExecutableFile(payload.executablePath);
  const backend = new InterpreterBackend(payload.memorySize || 65536, {
    videoWidth: payload.videoWidth,
    videoHeight: payload.videoHeight,
  });

  backend.reset(executable.entry | 0);
  backend.loadExecutable(executable);

  if (payload.mmio) {
    backend.write(MMIO.BOOT_FLAG, payload.mmio.bootFlag | 0);
    backend.write(MMIO.KEYBOARD, payload.mmio.keyboard | 0);
    backend.write(MMIO.INPUT, payload.mmio.input | 0);
    if (Array.isArray(payload.mmio.mouse)) {
      backend.write(MMIO.MOUSE, payload.mmio.mouse[0] | 0);
      backend.write(MMIO.MOUSE + 1, payload.mmio.mouse[1] | 0);
      backend.write(MMIO.MOUSE + 2, payload.mmio.mouse[2] | 0);
    }
  }

  if (payload.registers) {
    if (typeof payload.registers.PC === 'number') backend.cpu.PC = payload.registers.PC | 0;
    if (typeof payload.registers.SP === 'number') backend.cpu.SP = payload.registers.SP | 0;
    if (typeof payload.registers.BP === 'number') backend.cpu.REG[13] = payload.registers.BP | 0;
    if (payload.registers.FLAGS) {
      backend.cpu.FLAGS = {
        Z: !!payload.registers.FLAGS.Z,
        N: !!payload.registers.FLAGS.N,
        G: !!payload.registers.FLAGS.G,
        L: !!payload.registers.FLAGS.L,
      };
    }
  }

  backend.run(payload.maxCycles || 100000);

  const result = {
    halted: backend.cpu.halted,
    registers: {
      PC: backend.cpu.PC | 0,
      SP: backend.cpu.SP | 0,
      BP: backend.cpu.REG[13] | 0,
      FLAGS: { ...backend.cpu.FLAGS },
    },
    audioEvents: [...backend.output.audioEvents],
    framebuffer: Array.from(backend.frameBuffer),
    ram: Array.from(backend.ram),
  };

  const outputPath = payload.outputPath || path.join(path.dirname(inputPath), 'output.json');
  fs.writeFileSync(outputPath, JSON.stringify(result));
}

main();
