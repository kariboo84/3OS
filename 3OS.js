const { TernaryVM, TernaryTerminal } = require('./TernaryVM.enhanced');
const { MMIO } = require('./src/config');


function parseCliArgs(argv) {
  const options = {
    backend: process.env.TNA_BACKEND || 'interpreter',
    autoBoot: true,
    bootTarget: 'auto',
    key: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--backend' && argv[i + 1]) {
      options.backend = argv[++i];
    } else if (arg === '--bridge' && argv[i + 1]) {
      options.bridgeCommand = argv[++i];
    } else if (arg === '--no-autoboot') {
      options.autoBoot = false;
    } else if (arg === '--boot' && argv[i + 1]) {
      options.bootTarget = argv[++i];
    } else if (arg === '--key' && argv[i + 1]) {
      options.key = argv[++i];
    } else if (!options.key) {
      options.key = arg;
    }
  }
  return options;
}

function launchFromCli(os, options) {
  if (!options.autoBoot) return '';
  const named = new Set(['auto', 'bridge', 'linked', 'historical', 'official', 'ingame', 'screens', 'source', 'preview', 'raycaster', 'toy', 'c']);
  if (named.has(String(options.bootTarget || 'auto').toLowerCase())) {
    const suffix = `${options.bootTarget || 'auto'}${options.key ? ` ${options.key}` : ''}`.trim();
    return os.runCommand(`wolf3d ${suffix}`.trim());
  }
  const booted = os.runCommand(`boot ${options.bootTarget}`);
  const ran = os.runCommand(options.key ? `run ${options.key}` : 'run');
  return [booted, ran].filter(Boolean).join('\n');
}

class ThreeOS {
  constructor(options = {}) {
    this.vm = new TernaryVM(options.memorySize ?? (1 << 22), {
      videoWidth: options.videoWidth ?? 160,
      videoHeight: options.videoHeight ?? 120,
      backend: options.backend ?? 'interpreter',
      bridgeCommand: options.bridgeCommand,
      bridgeEnv: options.bridgeEnv,
      bridgeWorkDir: options.bridgeWorkDir,
    });
    this.terminal = new TernaryTerminal(this.vm);
    this.booted = false;
    this.mode = 'desktop';
  }

  boot() {
    this.vm.reset();
    this.vm.write(MMIO.BOOT_FLAG, 1);
    this.vm.drawDesktop();
    this.drawTerminalWindow();
    this.mode = 'desktop';
    this.booted = true;
    return this.snapshot();
  }

  drawTerminalWindow() {
    const x = 12, y = 24, w = this.vm.videoWidth - 24, h = this.vm.videoHeight - 34;
    this.vm.fillRect(x, y, w, h, 0x00FAFAFA);
    this.vm.fillRect(x, y, w, 14, 0x00C8C8C8);
    this.vm.drawText(x + 4, y + 4, 'Terminal', 0x00000000);
    const lines = [this.terminal.bootMessage, ...this.vm.output.text.split('\n').filter(Boolean)].slice(-8);
    let yy = y + 20;
    for (const line of lines) {
      this.vm.drawText(x + 4, yy, line.slice(0, 24), 0x00000000);
      yy += 8;
    }
  }

  runCommand(command) {
    const result = this.terminal.execute(command);
    this.vm.output.text += `${this.vm.output.text ? '\n' : ''}> ${command}${result ? `\n${result}` : ''}`;
    this.mode = this.vm.currentMode || 'desktop';
    if (this.mode !== 'graphics') {
      this.drawTerminalWindow();
    }
    return result;
  }

  handleKey(ch, isDown = true) {
    if (isDown === false) this.vm.releaseKey(ch);
    else this.vm.onKeyboardText(ch);
    return ch;
  }

  handleMouse(x, y, buttons = 0) {
    this.vm.onMouse(x, y, buttons);
    return { x, y, buttons };
  }

  playBeep(freq = 440, dur = 120) {
    this.vm.write(MMIO.AUDIO_FREQ, freq);
    this.vm.write(MMIO.AUDIO_DUR, dur);
    this.vm.write(MMIO.AUDIO_CMD, 1);
    this.vm.tick();
  }

  snapshot() {
    const state = this.vm.snapshot();
    return {
      booted: this.booted,
      textOutput: this.vm.output.text,
      framebuffer: this.vm.frameBuffer,
      audioEvents: [...this.vm.audioEvents],
      registers: {
        PC: state.PC,
        SP: state.SP,
        BP: state.BP,
        FLAGS: state.FLAGS,
      },
      backend: state.backend,
      halted: state.halted,
      bridge: state.bridge || null,
    };
  }
}

if (require.main === module) {
  const cli = parseCliArgs(process.argv.slice(2));
  const os = new ThreeOS({
    backend: cli.backend,
    bridgeCommand: cli.bridgeCommand,
  });
  os.boot();
  console.log('3OS booted');
  console.log(os.runCommand('help'));
  const autoResult = launchFromCli(os, cli);
  if (autoResult) console.log(autoResult);
  console.log('Audio queue before beep:', os.snapshot().audioEvents.length);
  os.playBeep(523, 180);
  console.log('Audio queue after beep:', os.snapshot().audioEvents.length);
  console.log('Registers:', os.snapshot().registers);
}

module.exports = { ThreeOS, parseCliArgs, launchFromCli };
