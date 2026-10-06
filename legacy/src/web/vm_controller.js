const { ThreeOS } = require('../../3OS');

class VMWebController {
  constructor(options = {}) {
    this.defaultBackend = options.backend || process.env.TNA_BACKEND || 'interpreter';
    this.defaultVideoWidth = options.videoWidth || 160;
    this.defaultVideoHeight = options.videoHeight || 120;
    this.defaultMemorySize = options.memorySize || (1 << 22);
    this.chunkCycles = options.chunkCycles || 120000;
    this.logs = [];
    this.session = null;
    this.loopHandle = null;
  }

  appendLog(message) {
    const line = `[${new Date().toISOString()}] ${message}`;
    this.logs.push(line);
    if (this.logs.length > 300) this.logs.splice(0, this.logs.length - 300);
  }

  ensureSession(options = {}) {
    if (!this.session) this.startVM(options);
    return this.session;
  }

  startVM(options = {}) {
    this.stopVM({ silent: true });
    const backend = options.backend || this.defaultBackend;
    const os = new ThreeOS({
      memorySize: this.defaultMemorySize,
      videoWidth: this.defaultVideoWidth,
      videoHeight: this.defaultVideoHeight,
      backend,
      bridgeCommand: options.bridgeCommand,
    });
    os.vm.reset();
    os.vm.frameBuffer.fill(0);
    os.mode = 'stopped';
    this.session = {
      os,
      backend,
      running: false,
      booted: false,
      targetLabel: '',
      targetPath: '',
      lastCommand: '',
      lastResult: '',
      ticks: 0,
    };
    this.appendLog(`VM started (backend=${backend})`);
    return this.getState();
  }

  stopVM(options = {}) {
    if (this.loopHandle) {
      clearInterval(this.loopHandle);
      this.loopHandle = null;
    }
    if (this.session && !options.silent) this.appendLog('VM stopped');
    this.session = null;
    return this.getState();
  }

  boot3OS() {
    const session = this.ensureSession();
    session.os.boot();
    session.booted = true;
    session.running = false;
    session.targetLabel = '3OS desktop';
    session.targetPath = '';
    session.lastCommand = 'boot:3OS';
    session.lastResult = '3OS booted';
    this.appendLog('3OS booted');
    return this.getState();
  }

  reset3OS() {
    const session = this.ensureSession();
    session.os.boot();
    session.booted = true;
    session.running = false;
    session.targetLabel = '3OS desktop';
    session.targetPath = '';
    session.lastCommand = 'reset:3OS';
    session.lastResult = '3OS reset';
    this.appendLog('3OS reset');
    return this.getState();
  }

  beginLoop() {
    if (this.loopHandle) return;
    this.loopHandle = setInterval(() => {
      try {
        this.tick();
      } catch (error) {
        this.appendLog(`loop error: ${error.message}`);
        if (this.session) this.session.running = false;
      }
    }, 33);
  }

  tick() {
    if (!this.session || !this.session.running) return this.getState();
    const { os } = this.session;
    if (os.snapshot().halted) {
      this.session.running = false;
      return this.getState();
    }
    os.vm.run(this.chunkCycles);
    if (os.vm.backend && os.vm.backend.hostRuntime && typeof os.vm.backend.hostRuntime.stepHostAssists === 'function') {
      os.vm.backend.hostRuntime.stepHostAssists(os.vm.bus);
    }
    this.session.ticks += 1;
    const snap = os.snapshot();
    if (snap.halted) {
      this.session.running = false;
      this.appendLog(`Execution halted (pc=${snap.registers.PC})`);
    }
    return this.getState();
  }

  makeWolfCommand(target = 'auto', key = '') {
    const normalizedTarget = String(target || 'auto').trim().toLowerCase();
    const normalizedKey = String(key || '').trim();
    const named = new Set(['auto', 'bridge', 'linked', 'historical', 'official', 'ingame', 'screens', 'source', 'preview', 'raycaster', 'toy', 'c']);
    let command = 'wolf3d';
    if (normalizedTarget && normalizedTarget !== 'auto' && named.has(normalizedTarget)) {
      command += ` ${normalizedTarget}`;
    }
    if (normalizedKey) command += ` ${normalizedKey[0]}`;
    return command;
  }

  inferTargetPath(resultText) {
    const match = String(resultText || '').match(/image=([^\s]+)/);
    return match ? match[1] : '';
  }

  inferTargetLabel(resultText, fallback = '') {
    const match = String(resultText || '').match(/target=([^\s]+)/);
    return match ? match[1] : fallback;
  }

  runCommand(command) {
    const session = this.ensureSession();
    if (!session.booted) this.boot3OS();
    const trimmed = String(command || '').trim();
    if (!trimmed) return this.getState();
    const result = session.os.runCommand(trimmed) || '';
    const snap = session.os.snapshot();
    session.booted = true;
    session.running = !snap.halted && session.os.mode === 'graphics';
    session.lastCommand = trimmed;
    session.lastResult = result;
    if (/^wolf3d\b/i.test(trimmed)) {
      session.targetLabel = this.inferTargetLabel(result, trimmed);
      session.targetPath = this.inferTargetPath(result);
    } else if (/^boot\b/i.test(trimmed)) {
      session.targetLabel = trimmed;
      session.targetPath = this.inferTargetPath(result) || trimmed.replace(/^boot\s+/i, '');
    } else if (/^run\b/i.test(trimmed)) {
      session.targetLabel = session.targetLabel || 'custom executable';
    }
    this.appendLog(`3OS> ${trimmed}`);
    if (result) this.appendLog(result);
    if (session.running) this.beginLoop();
    return this.getState();
  }

  loadWolfTarget(target = 'auto', key = '') {
    return this.runCommand(this.makeWolfCommand(target, key));
  }

  injectKey(key, down = true) {
    const session = this.ensureSession();
    const value = String(key || '');
    if (!value) return this.getState();
    session.os.handleKey(value, down !== false);
    if (session.os.vm.backend && session.os.vm.backend.hostRuntime && typeof session.os.vm.backend.hostRuntime.stepHostAssists === 'function') {
      session.os.vm.backend.hostRuntime.stepHostAssists(session.os.vm.bus);
    }
    if (session.running) this.tick();
    this.appendLog(`key ${JSON.stringify(value)} ${down === false ? 'up' : 'down'}`);
    return this.getState();
  }

  injectMouse(x, y, buttons = 0) {
    const session = this.ensureSession();
    session.os.handleMouse(x | 0, y | 0, buttons | 0);
    if (session.running) this.tick();
    return this.getState();
  }

  beep(freq = 523, dur = 180) {
    const session = this.ensureSession();
    session.os.playBeep(freq | 0, dur | 0);
    this.appendLog(`beep queued (${freq | 0}Hz/${dur | 0}ms)`);
    return this.getState();
  }

  getState() {
    if (!this.session) {
      return {
        started: false,
        booted: false,
        running: false,
        backend: null,
        mode: 'stopped',
        halted: true,
        videoWidth: this.defaultVideoWidth,
        videoHeight: this.defaultVideoHeight,
        framebuffer: [],
        registers: null,
        audioEvents: [],
        targetLabel: '',
        targetPath: '',
        lastCommand: '',
        lastResult: '',
        textOutput: '',
        logs: this.logs.join('\n'),
      };
    }

    const { os, backend, running, booted, targetLabel, targetPath, lastCommand, lastResult } = this.session;
    const snapshot = os.snapshot();
    return {
      started: true,
      booted,
      running,
      backend,
      mode: os.mode,
      halted: snapshot.halted,
      videoWidth: os.vm.videoWidth,
      videoHeight: os.vm.videoHeight,
      framebuffer: Array.from(os.vm.frameBuffer),
      registers: snapshot.registers,
      audioEvents: snapshot.audioEvents,
      targetLabel,
      targetPath,
      lastCommand,
      lastResult,
      textOutput: snapshot.textOutput,
      logs: this.logs.join('\n'),
    };
  }
}

module.exports = { VMWebController };
