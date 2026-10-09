// Front web TRI-27 : charge tri27.wasm (API C brute, sans wasm-bindgen).
'use strict';

const DEMO = String.raw`; TRI-27 — démo web : dégradé TRGB animé + écho console
; R suit x, G suit y, B défile avec le compteur d'images.
; Clavier : chaque appui de touche fait sauter la teinte bleue.
; Les caractères tapés (CONSOLE_IN) sont renvoyés sur la console.

        .org 0
start:  la    a0, msg
pmsg:   ldt   t0, 0(a0)
        beq   t0, zero, pdone
        stt   t0, -1(zero)        ; CONSOLE_OUT
        addi  a0, a0, 1
        j     pmsg
pdone:  li    s1, 300000          ; framebuffer en RAM
        stw   s1, -5(zero)        ; FB_ADDR
        li    s2, 0               ; compteur d'images
        addi  s6, zero, 12
        addi  s7, zero, 27
        addi  s8, zero, 4
        addi  s9, zero, 8

frame:  mv    t6, s1              ; pointeur pixel
        li    s3, 0               ; y
yloop:  li    s4, 0               ; x
        div   t2, s3, s9          ; g = y/8 - 12  (-12..12)
        addi  t2, t2, -12
        muli  s5, t2, 27          ; g * 27
xloop:  div   t3, s4, s6          ; r = x/12 - 13 (-13..13)
        addi  t3, t3, -13
        muli  t3, t3, 729         ; r * 729
        add   t3, t3, s5
        add   t4, s4, s3
        add   t4, t4, s2
        div   t4, t4, s8
        mod   t4, t4, s7          ; b = ((x+y+f)/4) mod 27 - 13
        addi  t4, t4, -13
        add   t3, t3, t4
        stt   t3, 0(t6)
        addi  t6, t6, 1
        addi  s4, s4, 1
        slti  t1, s4, 320
        bne   t1, zero, xloop
        addi  s3, s3, 1
        slti  t1, s3, 200
        bne   t1, zero, yloop

        stw   zero, -6(zero)      ; FB_PRESENT
        addi  s2, s2, 2

        ldw   t0, -7(zero)        ; KEY
        slt   t1, zero, t0
        beq   t1, zero, nokey
        addi  s2, s2, 36
nokey:  ldw   t0, -2(zero)        ; CONSOLE_IN
        addi  t1, zero, -1
        beq   t0, t1, frame
        stt   t0, -1(zero)        ; écho
        j     nokey

msg:    .str  "TRI-27 : bonjour depuis la VM ternaire !\nTapez du texte, il sera renvoye ici.\n"
`;

const $ = (id) => document.getElementById(id);
const srcEl = $('src'), conEl = $('console'), statsEl = $('stats'), statusEl = $('status');
const canvas = $('screen'), ctx = canvas.getContext('2d');
let imgData = ctx.createImageData(320, 200);
let focusDone = false;
// mode vidéo : TRGB 320x200 affiché x3, TRIT 576x360 affiché x2
function fitCanvas(w, h) {
  if (canvas.width === w && canvas.height === h) return;
  canvas.width = w; canvas.height = h;
  const k = w === 576 ? 2 : 3;
  canvas.style.width = (w * k) + 'px'; canvas.style.height = (h * k) + 'px';
  imgData = ctx.createImageData(w, h);
}
const enc = new TextEncoder(), dec = new TextDecoder();

let W = null;            // exports wasm
let running = false, loaded = false;
let lastFrames = 0;
let vmTime = 0, lastTs = null;      // horloge VM (ms), figée en pause
let rateWin = { t: performance.now(), c: 0 }, mips = 0, fps = 0, framesWin = 0;
let conText = '';

function mem() { return new Uint8Array(W.memory.buffer); }
function str(ptr, len) { return dec.decode(new Uint8Array(W.memory.buffer, ptr, len)); }

function setStatus(msg, cls) { statusEl.textContent = msg; statusEl.className = cls || ''; }

function appendConsole(s) {
  if (!s) return;
  conText += s;
  if (conText.length > 200000) conText = conText.slice(-150000);
  conEl.textContent = conText;
  conEl.scrollTop = conEl.scrollHeight;
}

function drainConsole() {
  const n = W.out_len();
  if (n > 0) { appendConsole(str(W.out_ptr(), n)); W.out_clear(); }
}

function drawFrame() {
  const p = W.fb_render();
  const w = W.fb_width(), h = W.fb_height();
  fitCanvas(w, h);
  imgData.data.set(new Uint8Array(W.memory.buffer, p, w * h * 4));
  ctx.putImageData(imgData, 0, 0);
  // premier affichage d'une image : le clavier va à l'écran (KEY_EVENT seulement)
  if (!focusDone && W.frames() > 0) { focusDone = true; canvas.focus(); }
}

// ---- son TSG-3 : la VM rend des blocs f32 44,1 kHz, planifiés ~120 ms en avance ----
let actx = null, audioT = 0, audioOn = true;
function audioInit() {
  if (actx) { if (actx.state === 'suspended') actx.resume(); return; }
  try { actx = new AudioContext({ sampleRate: 44100 }); audioT = 0; } catch (_) { actx = null; }
}
function audioPump() {
  if (!actx || !W || !loaded || !running || !audioOn) { if (actx) audioT = Math.max(audioT, actx.currentTime); return; }
  const now = actx.currentTime;
  if (audioT < now + 0.02) audioT = now + 0.05;          // rattrapage après pause/ralentissement
  while (audioT < now + 0.12) {
    const n = 2048;
    const p = W.audio_render(n);
    const data = new Float32Array(W.memory.buffer, p, n);
    const buf = actx.createBuffer(1, n, 44100);
    buf.copyToChannel(data, 0);
    const src = actx.createBufferSource();
    src.buffer = buf; src.connect(actx.destination); src.start(audioT);
    audioT += n / 44100;
  }
}

let diskImage = null, diskKey = null;
// Le disque modifié par 3OS est gardé dans le navigateur (localStorage), lié à la version
// du disque servi (taille + date) : un nouveau disque du serveur remplace l'ancienne copie.
function b64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
function unb64(s) { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
const diskReady = fetch('3os.t3d', { cache: 'no-store' })
  .then(r => r.ok ? r.arrayBuffer().then(b => ({ b, v: (r.headers.get('Last-Modified') || '') + ':' + b.byteLength })) : null)
  .then(res => {
    if (!res || !res.b.byteLength) return;
    diskKey = '3os.disk:' + res.v;
    diskImage = new Int16Array(res.b);
    try {
      const saved = localStorage.getItem(diskKey);
      if (saved) { diskImage = new Int16Array(unb64(saved).buffer); appendConsole('[web] disque restauré depuis le navigateur (vos modifications)\n'); }
      for (const k of Object.keys(localStorage)) if (k.startsWith('3os.disk:') && k !== diskKey) localStorage.removeItem(k);
    } catch (_) {}
  })
  .catch(() => {})
  .then(() => {
    if (!diskImage) appendConsole('[web] disque 3os.t3d introuvable : 3OS ne pourra pas démarrer\n');
  });
function saveDisk() {
  if (!W || !diskKey || !W.disk_take_dirty()) return;
  const n = W.disk_len();
  diskImage = new Int16Array(W.memory.buffer, W.disk_ptr(), n).slice();
  try { localStorage.setItem(diskKey, b64(new Uint8Array(diskImage.buffer))); }
  catch (e) { appendConsole('[web] sauvegarde du disque impossible : ' + e.message + '\n'); }
}
function resetDisk() {
  if (diskKey) localStorage.removeItem(diskKey);
  location.reload();
}

async function assembleAndRun() {
  await diskReady;
  audioInit();
  const bytes = enc.encode(srcEl.value);
  const p = W.src_alloc(bytes.length);
  mem().set(bytes, p);
  // disque 3FS (web/3os.t3d) : attaché à chaque lancement, lu par le noyau 3OS
  if (diskImage) {
    const dp = W.disk_alloc(diskImage.length);
    new Int16Array(W.memory.buffer, dp, diskImage.length).set(diskImage);
  }
  const r = W.assemble(p, bytes.length);
  if (r !== 0) {
    running = false; loaded = false;
    const e = str(W.err_ptr(), W.err_len());
    setStatus('Erreur d\'assemblage', 'err');
    appendConsole('\n[assembleur] ' + e + '\n');
    return false;
  }
  conText = ''; conEl.textContent = '';
  loaded = true; focusDone = false; running = true; lastFrames = 0; vmTime = 0; lastTs = null;
  rateWin = { t: performance.now(), c: W.cycles() }; framesWin = 0;
  drawFrame();
  setStatus('En cours', 'ok');
  $('btnPause').textContent = 'Pause';
  conEl.focus();
  return true;
}

function finishIfHalted() {
  if (!W.halted()) return;
  running = false;
  drainConsole();
  drawFrame();
  if (W.has_error()) {
    const e = str(W.err_ptr(), W.err_len());
    appendConsole('\n[VM] erreur : ' + e + '\n');
    setStatus('Arrêt sur erreur', 'err');
  } else {
    setStatus('Terminé (code ' + W.exit_code() + ')', 'ok');
  }
}

function tick(ts) {
  if (W && loaded && running) {
    if (lastTs !== null) vmTime += Math.min(250, ts - lastTs);
    lastTs = ts;
    W.set_time_ms(vmTime);
    let budget = +$('budget').value;
    if (!Number.isFinite(budget) || budget < 1) budget = 2000000;
    W.run(budget);
    drainConsole();
    const f = W.frames();
    if (f !== lastFrames) { framesWin += f - lastFrames; lastFrames = f; drawFrame(); }
    audioPump();
    saveDisk();
    finishIfHalted();
  } else {
    lastTs = null;
  }
  if (W) {
    const now = performance.now();
    if (now - rateWin.t >= 500) {
      const c = W.cycles();
      mips = (c - rateWin.c) / (now - rateWin.t) / 1000;
      fps = framesWin * 1000 / (now - rateWin.t);
      rateWin = { t: now, c }; framesWin = 0;
    }
    statsEl.textContent =
      `${mips.toFixed(1)} M instr/s · ${fps.toFixed(1)} img/s · frames ${W.frames()} · ` +
      `cycles ${W.cycles()} · pc ${W.pc()} · ${W.halted() ? 'arrêtée' : (running ? 'en marche' : 'en pause')}`;
  }
  requestAnimationFrame(tick);
}

// ---- clavier : codes = KeyboardEvent.keyCode (flèches 37..40, lettres 65..90, Entrée 13, Échap 27) ----
function onKeyDown(e) {
  if (!W) return;
  // écran focus → KEY_EVENT seulement ; console focus → caractères seulement
  if (e.currentTarget === canvas) {
    if (!e.repeat && e.keyCode) W.push_key(e.keyCode);
    // saisie de texte demandée par le programme (MMIO TEXT_IN) : caractères aussi, répétition comprise
    if (W.text_input()) {
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) W.push_char(e.key.codePointAt(0));
      else if (e.key === 'Enter') W.push_char(10);
      else if (e.key === 'Backspace') W.push_char(8);
    }
    e.preventDefault();
    return;
  }
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) W.push_char(e.key.codePointAt(0));
  else if (e.key === 'Enter') W.push_char(10);
  else if (e.key === 'Backspace') W.push_char(8);
  else if (e.key === 'Tab') W.push_char(9);
  else if (e.key === 'Escape') W.push_char(27);
  e.preventDefault();
}
function onKeyUp(e) {
  if (!W) return;
  if (e.currentTarget === canvas && e.keyCode) W.push_key(-e.keyCode);
  e.preventDefault();
}
// l'écran ET la console acceptent le clavier (la console sert de terminal)
for (const el of [canvas, conEl]) {
  el.addEventListener('keydown', onKeyDown);
  el.addEventListener('keyup', onKeyUp);
  el.addEventListener('mousedown', () => setTimeout(() => el.focus(), 0));
}

// ---- souris : pixels du mode courant ----
function sendMouse(e) {
  if (!W) return;
  const r = canvas.getBoundingClientRect();
  const x = Math.floor((e.clientX - r.left) * canvas.width / r.width);
  const y = Math.floor((e.clientY - r.top) * canvas.height / r.height);
  const b = e.buttons | 0;
  W.set_mouse(x, y, (b & 1) + 3 * ((b >> 1) & 1));
}
canvas.addEventListener('mousemove', sendMouse);
canvas.addEventListener('mousedown', sendMouse);
canvas.addEventListener('mouseup', sendMouse);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

$('btnRun').onclick = () => { if (W) assembleAndRun(); };  // async : attend le disque
if ($('btnDisk')) $('btnDisk').onclick = () => { if (confirm('Revenir au disque d\'origine (vos fichiers modifiés seront perdus) ?')) resetDisk(); };
$('btnPause').onclick = () => {
  if (!loaded || W.halted()) return;
  running = !running;
  $('btnPause').textContent = running ? 'Pause' : 'Reprendre';
  setStatus(running ? 'En cours' : 'En pause', running ? 'ok' : '');
  if (running) conEl.focus();
};
$('btnReset').onclick = () => {
  if (!loaded) return;
  W.reset();
  conText = ''; conEl.textContent = '';
  lastFrames = 0; vmTime = 0; lastTs = null; running = true; focusDone = false;
  rateWin = { t: performance.now(), c: 0 }; framesWin = 0;
  drawFrame();
  $('btnPause').textContent = 'Pause';
  setStatus('En cours', 'ok');
  conEl.focus();
};

// ---- exemples : ../examples/index.json (optionnel) ----
async function loadExampleList() {
  const sel = $('examples');
  try {
    const r = await fetch('../examples/index.json', { cache: 'no-store' });
    if (!r.ok) return;
    const list = await r.json();
    for (const it of list) {
      const name = typeof it === 'string' ? it : it && it.file;
      if (typeof name !== 'string' || !name.endsWith('.tas')) continue;
      const o = document.createElement('option');
      o.value = name;
      o.textContent = (typeof it === 'object' && it.title) ? name + ' — ' + it.title : name;
      sel.appendChild(o);
    }
  } catch (_) { /* pas de liste : démo intégrée seulement */ }
}
$('examples').onchange = async (e) => {
  const v = e.target.value;
  if (v === '__demo') { srcEl.value = DEMO; return; }
  try {
    const r = await fetch(v.startsWith('../') ? v : '../examples/' + encodeURIComponent(v), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    srcEl.value = await r.text();
    setStatus('Chargé : ' + v);
  } catch (err) {
    setStatus('Impossible de charger ' + v + ' : ' + err.message, 'err');
  }
};

async function init() {
  srcEl.value = DEMO;
  loadExampleList();
  const desktopBoot = document.body.dataset.boot === '3os';
  try {
    if (desktopBoot) {
      const kernel = await fetch('../os/kernel3.tas', { cache: 'no-store' });
      if (!kernel.ok) throw new Error('Noyau 3OS : HTTP ' + kernel.status);
      srcEl.value = await kernel.text();
    }
    const resp = await fetch('tri27.wasm', { cache: 'no-store' });
    const bytes = await resp.arrayBuffer();
    const { instance } = await WebAssembly.instantiate(bytes, {});
    W = instance.exports;
  } catch (err) {
    setStatus('Échec du chargement de tri27.wasm : ' + err.message, 'err');
    return;
  }
  setStatus('WASM prêt (RAM ' + W.ram_size() + ' trytes)');
  assembleAndRun();
  requestAnimationFrame(tick);
}
init();
