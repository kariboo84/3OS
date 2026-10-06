const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d');
const backendEl = document.getElementById('backend');
const wolfTargetEl = document.getElementById('wolfTarget');
const bootKeyEl = document.getElementById('bootKey');
const commandEl = document.getElementById('command');
const logsEl = document.getElementById('logs');
const terminalEl = document.getElementById('terminal');
const statusStateEl = document.getElementById('statusState');
const statusBackendEl = document.getElementById('statusBackend');
const statusTargetEl = document.getElementById('statusTarget');
const statusImageEl = document.getElementById('statusImage');
const statusModeEl = document.getElementById('statusMode');
const statusRegsEl = document.getElementById('statusRegs');
const statusCommandEl = document.getElementById('statusCommand');
const statusResultEl = document.getElementById('statusResult');

let audioContext = null;
let seenAudioEvents = 0;
let lastFrame = null;

async function api(path, payload = undefined) {
  const options = payload === undefined
    ? { method: 'GET' }
    : {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      };
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function renderFramebuffer(state) {
  const width = state.videoWidth || 160;
  const height = state.videoHeight || 120;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    lastFrame = ctx.createImageData(width, height);
  }
  if (!lastFrame || lastFrame.width !== width || lastFrame.height !== height) {
    lastFrame = ctx.createImageData(width, height);
  }
  const totalPixels = width * height;
  const data = lastFrame.data;
  const pixels = state.framebuffer || [];
  for (let i = 0; i < totalPixels; i++) {
    const px = (pixels[i] >>> 0) || 0;
    const offset = i * 4;
    data[offset + 0] = (px >>> 16) & 0xff;
    data[offset + 1] = (px >>> 8) & 0xff;
    data[offset + 2] = px & 0xff;
    data[offset + 3] = ((px >>> 24) & 0xff) || 255;
  }
  ctx.putImageData(lastFrame, 0, 0);
}

function updateStatus(state) {
  const status = [
    state.started ? 'VM prête' : 'VM arrêtée',
    state.booted ? '3OS booted' : '3OS non booté',
    state.running ? 'exécution active' : 'pas de boucle active',
    state.halted ? 'CPU halted' : 'CPU vivant',
  ].join(' · ');
  statusStateEl.textContent = status;
  statusBackendEl.textContent = state.backend || '-';
  statusTargetEl.textContent = state.targetLabel || '-';
  statusImageEl.textContent = state.targetPath || '-';
  statusModeEl.textContent = state.mode || '-';
  statusCommandEl.textContent = state.lastCommand || '-';
  statusResultEl.textContent = state.lastResult || '-';
  terminalEl.textContent = state.textOutput || '';
  if (state.registers) {
    const r = state.registers;
    statusRegsEl.textContent = `PC=${r.PC} SP=${r.SP} BP=${r.BP} Z=${r.FLAGS.Z ? 1 : 0} N=${r.FLAGS.N ? 1 : 0}`;
  } else {
    statusRegsEl.textContent = '-';
  }
  logsEl.textContent = state.logs || '';
  logsEl.scrollTop = logsEl.scrollHeight;
}

async function ensureAudioContext() {
  if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
  if (audioContext.state === 'suspended') await audioContext.resume();
  return audioContext;
}

async function playAudioEvents(events) {
  if (!events || events.length <= seenAudioEvents) return;
  const ctxAudio = await ensureAudioContext();
  const fresh = events.slice(seenAudioEvents);
  seenAudioEvents = events.length;
  const now = ctxAudio.currentTime;
  fresh.forEach((event, index) => {
    const osc = ctxAudio.createOscillator();
    const gain = ctxAudio.createGain();
    osc.type = 'square';
    osc.frequency.value = Math.max(40, event.freq || 440);
    gain.gain.setValueAtTime(0.04, now + index * 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + index * 0.02 + Math.max(0.04, (event.dur || 120) / 1000));
    osc.connect(gain);
    gain.connect(ctxAudio.destination);
    osc.start(now + index * 0.02);
    osc.stop(now + index * 0.02 + Math.max(0.04, (event.dur || 120) / 1000));
  });
}

async function refresh() {
  try {
    const state = await api('/api/state');
    renderFramebuffer(state);
    updateStatus(state);
    playAudioEvents(state.audioEvents);
  } catch (error) {
    logsEl.textContent = `Erreur UI: ${error.message}`;
  }
}

async function runCommand(command) {
  const value = String(command || '').trim();
  if (!value) return;
  try {
    await api('/api/command', { command: value });
    await refresh();
  } catch (error) {
    logsEl.textContent += `\nErreur commande: ${error.message}`;
  }
}

async function handleAction(action) {
  try {
    if (action === 'start') {
      await api('/api/start', { backend: backendEl.value });
    } else if (action === 'stop') {
      await api('/api/stop', {});
      seenAudioEvents = 0;
    } else if (action === 'boot3os') {
      await api('/api/boot-3os', {});
    } else if (action === 'reset3os') {
      await api('/api/reset-3os', {});
    } else if (action === 'wolf') {
      const target = wolfTargetEl.value || 'auto';
      const key = bootKeyEl.value || '';
      const suffix = target && target !== 'auto' ? ` ${target}` : '';
      const keySuffix = key ? ` ${key}` : '';
      await runCommand(`wolf3d${suffix}${keySuffix}`);
      return;
    } else if (action === 'beep') {
      await api('/api/beep', {});
    }
    await refresh();
  } catch (error) {
    logsEl.textContent += `\nErreur action ${action}: ${error.message}`;
  }
}

document.getElementById('startVm').addEventListener('click', () => handleAction('start'));
document.getElementById('stopVm').addEventListener('click', () => handleAction('stop'));
document.getElementById('boot3os').addEventListener('click', () => handleAction('boot3os'));
document.getElementById('reset3os').addEventListener('click', () => handleAction('reset3os'));
document.getElementById('launchWolf').addEventListener('click', () => handleAction('wolf'));
document.getElementById('beep').addEventListener('click', () => handleAction('beep'));
document.getElementById('sendCommand').addEventListener('click', () => runCommand(commandEl.value));
commandEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    runCommand(commandEl.value);
  }
});

function normalizeBrowserKey(event) {
  if (event.key === 'Enter') return 'Enter';
  if (event.key === 'Escape') return 'Escape';
  if (event.key === 'Tab') return 'Tab';
  if (event.key === 'Backspace') return 'Backspace';
  if (event.key === ' ') return 'Space';
  if (event.key === 'ArrowUp') return 'ArrowUp';
  if (event.key === 'ArrowDown') return 'ArrowDown';
  if (event.key === 'ArrowLeft') return 'ArrowLeft';
  if (event.key === 'ArrowRight') return 'ArrowRight';
  if (event.key === 'Control') return 'Control';
  if (event.key === 'Alt') return 'Alt';
  if (event.key === 'Shift') return 'Shift';
  if (event.key.length === 1) return event.key;
  return '';
}

async function sendKey(key, down = true) {
  if (!key) return;
  try {
    await api('/api/key', { key, down });
    await refresh();
  } catch (error) {
    logsEl.textContent += `
Erreur key: ${error.message}`;
  }
}

window.addEventListener('keydown', async (event) => {
  if (event.repeat) return;
  const active = document.activeElement;
  if (active && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName)) return;
  const key = normalizeBrowserKey(event);
  if (!key) return;
  event.preventDefault();
  await sendKey(key, true);
});

window.addEventListener('keyup', async (event) => {
  const active = document.activeElement;
  if (active && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName)) return;
  const key = normalizeBrowserKey(event);
  if (!key) return;
  event.preventDefault();
  await sendKey(key, false);
});

function pointerToVmCoords(event) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.max(0, Math.min(canvas.width - 1, Math.floor((event.clientX - rect.left) * (canvas.width / rect.width))));
  const y = Math.max(0, Math.min(canvas.height - 1, Math.floor((event.clientY - rect.top) * (canvas.height / rect.height))));
  return { x, y };
}

canvas.addEventListener('mousedown', async (event) => {
  canvas.focus();
  const { x, y } = pointerToVmCoords(event);
  try {
    await api('/api/mouse', { x, y, buttons: 1 });
    await refresh();
  } catch (error) {
    logsEl.textContent += `\nErreur souris: ${error.message}`;
  }
});

canvas.addEventListener('mouseup', async (event) => {
  const { x, y } = pointerToVmCoords(event);
  try {
    await api('/api/mouse', { x, y, buttons: 0 });
  } catch (_error) {
  }
});

setInterval(refresh, 150);
refresh();
