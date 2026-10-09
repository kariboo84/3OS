// tests/web_os04.cjs — 3OS v0.4 dans Chrome : chiffres (souris), éditeur (saisie texte),
// persistance du disque après rechargement de la page. Captures dans SHOT_DIR.
const fs = require('fs'), path = require('path');
const OUT = process.env.SHOT_DIR || require('os').tmpdir();
(async () => {
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t = (await (await fetch('http://127.0.0.1:' + (process.env.TRI27_CDP || 9231) + '/json')).json()).find(t => t.type === 'page');
const ws = new WebSocket(t.webSocketDebuggerUrl);
const pend = new Map(); let id = 0; const exc = [];
ws.onmessage = e => { const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') exc.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description || ''));
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } };
await new Promise(r => ws.onopen = r);
const cdp = (method, params = {}) => new Promise((res, rej) => { const n = ++id; pend.set(n, { res, rej }); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async x => { const r = await cdp('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; };
await cdp('Runtime.enable'); await cdp('Page.enable');
const boot = async () => {
  await cdp('Page.navigate', { url: 'http://127.0.0.1:' + (process.env.TRI27_HTTP || 8124) + '/web/' }); await sleep(3000);
  await ev(`(async()=>{const s=document.getElementById('examples'); s.value='../os/kernel3.tas'; await s.onchange({target:s}); document.getElementById('btnRun').click(); return 1})()`);
  await sleep(4000);
};
const geom = () => ev(`(()=>{const c=document.getElementById('screen'); const r=c.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height,cw:c.width,ch:c.height}})()`);
const at = async (fx, fy) => { const R = await geom(); return { x: R.x + (fx + 0.5) * R.w / R.cw, y: R.y + (fy + 0.5) * R.h / R.ch }; };
const mouse = async (type, fx, fy, btn) => { const p = await at(fx, fy); await cdp('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: btn ? 'left' : 'none', buttons: btn ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 }); };
const click = async (fx, fy) => { await mouse('mouseMoved', fx, fy, 0); await sleep(200); await mouse('mousePressed', fx, fy, 1); await sleep(200); await mouse('mouseReleased', fx, fy, 1); await sleep(300); };
const key = async (k, code, text) => { await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, windowsVirtualKeyCode: code, text }); await sleep(30); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, windowsVirtualKeyCode: code }); await sleep(30); };
const shot = async name => { const R = await geom(); const s = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: R.x, y: R.y, width: R.w, height: R.h, scale: 1 } }); fs.writeFileSync(path.join(OUT, name), Buffer.from(s.data, 'base64')); };
const row = i => 34 + 22 + i * 14 + 4;      // ligne i de la fenêtre 3OS (system3.c)
await boot();
await ev(`localStorage.clear()`); await boot();       // départ du disque d'origine
console.log('boot :', JSON.stringify((await ev(`document.getElementById('console').textContent`)).split('\n')[2]));
// 1. chiffres : tracer un « 1 » vertical colonne 4
await click(70, row(1)); await sleep(2000);
await ev(`document.getElementById('screen').focus()`);
// un « 1 » : trait vertical au centre, du haut vers le bas (pinceau 3 px du dessin 32x32)
const gx = 24 + 16 * 9 + 4;
await mouse('mouseMoved', gx, 50, 0); await mouse('mousePressed', gx, 50, 1);
for (let y = 50; y <= 310; y += 9) { await mouse('mouseMoved', gx, y, 1); await sleep(40); }
await mouse('mouseReleased', gx, 310, 1); await sleep(800);
await shot('web_chiffres_1.png');
await key('n', 78); await sleep(800); await shot('web_chiffres_test.png');
await key('Escape', 27); await sleep(1500);
// 2. éditeur : taper une ligne, Échap enregistre
await click(70, row(2)); await sleep(2000);
await ev(`document.getElementById('screen').focus()`);
console.log('saisie texte active :', await ev(`W.text_input()`));
for (const ch of 'Tape dans Chrome.') await key(ch, ch.toUpperCase().charCodeAt(0), ch);
await key('Enter', 13, '\r'); await sleep(500);
await shot('web_editeur.png');
await key('Escape', 27); await sleep(2500);
console.log('sauvegarde navigateur :', await ev(`Object.keys(localStorage).filter(k=>k.startsWith('3os.disk:')).length`));
// 3. rechargement complet : le texte doit survivre
await boot();
console.log('console après rechargement :', JSON.stringify((await ev(`document.getElementById('console').textContent`)).split('\n')[0]));
await shot('web_persist.png');
console.log('exceptions', exc.length, exc.slice(0, 3));
await ev(`localStorage.clear()`);
ws.close(); process.exit(0);
})();
