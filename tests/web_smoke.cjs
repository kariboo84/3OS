// tests/web_smoke.cjs — test de bout en bout de 3OS dans Chrome headless (CDP).
// Prérequis : serveur http sur :8124 (racine du dépôt) et Chrome --remote-debugging-port=9231.
// Lancé par ./check.sh. Sortie : lignes « boot / tetris / crash » + exceptions JS (doit être 0).
(async()=>{
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t = (await (await fetch('http://127.0.0.1:9231/json')).json()).find(t => t.type === 'page');
const ws = new WebSocket(t.webSocketDebuggerUrl);
const pend = new Map(); let id = 0; const exc = [];
ws.onmessage = e => { const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') exc.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description||''));
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } };
await new Promise(r => ws.onopen = r);
const cdp = (method, params = {}) => new Promise((res, rej) => { const n = ++id; pend.set(n, { res, rej }); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async x => { const r = await cdp('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; };
await cdp('Runtime.enable'); await cdp('Page.enable');
await cdp('Page.navigate', { url: 'http://127.0.0.1:8124/web/?v=' + Date.now() });
await sleep(3000);
await ev(`(async()=>{const s=document.getElementById('examples'); s.value='../os/kernel3.tas'; s.dispatchEvent(new Event('change')); await new Promise(r=>setTimeout(r,1500)); document.getElementById('btnRun').click(); return 1})()`);
await sleep(5000);
const size = () => ev(`document.getElementById('screen').width+'x'+document.getElementById('screen').height`);
const con = () => ev(`document.getElementById('console').textContent`);
console.log('boot : écran', await size(), '| console :', JSON.stringify((await con()).slice(0, 160)));
const shot = async name => { const R = await ev(`(()=>{const r=document.getElementById('screen').getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}})()`);
  const s = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: R.x, y: R.y, width: R.w, height: R.h, scale: 1 } });
  require('fs').writeFileSync(require('path').join(process.env.SHOT_DIR || require('os').tmpdir(), name), Buffer.from(s.data, 'base64')); };
await shot('os_web_boot.png');
await sleep(1500); console.log('bureau inactif :', await ev(`document.getElementById('stats').textContent`));
const click = async (fx, fy) => { const R = await ev(`(()=>{const c=document.getElementById('screen'); const r=c.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height,cw:c.width,ch:c.height}})()`);
  const x = R.x + fx * R.w / R.cw, y = R.y + fy * R.h / R.ch;
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 }); await sleep(300);
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }); await sleep(300);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }); await sleep(300); };
await click(70, 77);            // ligne « 2 tetris »
await sleep(2500);
console.log('après clic tetris : écran', await size());
await ev(`document.getElementById('screen').focus()`);
for (const [k, c] of [['ArrowLeft', 37], [' ', 32]]) { await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, windowsVirtualKeyCode: c }); await sleep(150); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, windowsVirtualKeyCode: c }); await sleep(400); }
await shot('os_web_tetris.png');
console.log('tetris en jeu :', await ev(`document.getElementById('stats').textContent`));
await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(150);
await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', windowsVirtualKeyCode: 27 });
await sleep(2500);
console.log('après Échap : écran', await size());
await click(70, 119);           // ligne « 5 crash »
await sleep(2500);
const c2 = await con();
console.log('après crash : écran', await size(), '| fin console :', JSON.stringify(c2.slice(-160)));
await shot('os_web_back.png');
console.log('statut', await ev(`document.getElementById('stats').textContent`));
console.log('exceptions', exc.length, exc.slice(0, 3));
ws.close(); process.exit(0);
})();