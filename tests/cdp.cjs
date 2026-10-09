// tests/cdp.cjs — client CDP partagé par les tests navigateur (Chrome headless, port 9231).
// Usage : const { connect, sleep } = require('./cdp.cjs'); const b = await connect(); ... b.close();
// Les captures vont dans SHOT_DIR (défaut : cc/build/shots).
const fs = require('fs'), path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function connect() {
  const t = (await (await fetch('http://127.0.0.1:' + (process.env.TRI27_CDP || 9231) + '/json')).json()).find(t => t.type === 'page');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  const pending = new Map(), exceptions = []; let id = 0;
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); }
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async expression => {
    const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const until = async (fn, msg, tries = 100) => { for (let n = 0; n < tries; n++) { if (await fn()) return; await sleep(100); } throw Error('Timeout: ' + msg); };
  const shotDir = process.env.SHOT_DIR || path.resolve(__dirname, '../cc/build/shots');
  fs.mkdirSync(shotDir, { recursive: true });
  // capture de l'élément #screen (ou du canvas donné) dans SHOT_DIR/<name>.png
  const shot = async (name, sel = 'screen') => {
    await sleep(150);
    const r = await ev(`(()=>{const r=document.getElementById('${sel}').getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height,sx:scrollX,sy:scrollY}})()`);
    const scrollX = r.sx, scrollY = r.sy;
    const s = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: r.x + scrollX, y: r.y + scrollY, width: r.w, height: r.h, scale: 1 } });
    fs.writeFileSync(path.join(shotDir, name + '.png'), Buffer.from(s.data, 'base64'));
    return path.join(shotDir, name + '.png');
  };
  await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Network.enable'); await cdp('Network.clearBrowserCache');
  return { cdp, ev, until, shot, exceptions, shotDir, close: () => ws.close() };
}

module.exports = { connect, sleep };
