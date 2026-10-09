// tests/mouse_refresh.cjs — régression de la souris rapide (bureau) : pas de traînée ni de scanout partiel.
// Prérequis : cdp.cjs, serveur :8124, Chrome CDP :9231.
const assert = require('assert');
const { connect, sleep } = require('./cdp.cjs');
(async () => {
  const b = await connect(), { ev, cdp } = b;
  await cdp('Page.navigate', { url: 'http://127.0.0.1:8124/web/desktop.html' });
  for (let i = 0; i < 100; i++) { if (await ev(`typeof W!=='undefined'&&W&&W.frames()>=2&&canvas.width===576`)) break; await sleep(100); }
  for (const mode of ['color', 'gray']) {
    if (mode === 'gray') { await ev(`canvas.focus()`); await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'c', windowsVirtualKeyCode: 67 }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', windowsVirtualKeyCode: 67 }); await sleep(500); }
    const r = await ev(`(()=>{const r=canvas.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}})()`);
    const move = async (x, y) => cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x + x * r.w / 576, y: r.y + y * r.h / 360, buttons: 0 });
    await move(560, 335); await sleep(400);
    await ev(`window.__mouseBase=ctx.getImageData(0,0,576,360).data.slice();document.getElementById('budget').value=1000;`);
    let checked = 0, changed = 0;
    for (let i = 0; i < 120; i++) {
      await move(24 + (i * 53) % 520, 25 + (i * 37) % 310); await sleep(12);
      const q = await ev(`(()=>{const d=ctx.getImageData(0,0,576,360).data,b=window.__mouseBase;let minx=576,miny=360,maxx=-1,maxy=-1,n=0;for(let y=0;y<360;y++)for(let x=0;x<576;x++){if(x>=558&&x<570&&y>=333&&y<349)continue;const k=(y*576+x)*4;if(d[k]!==b[k]||d[k+1]!==b[k+1]||d[k+2]!==b[k+2]){minx=Math.min(minx,x);maxx=Math.max(maxx,x);miny=Math.min(miny,y);maxy=Math.max(maxy,y);n++;}}return{n,w:n?maxx-minx+1:0,h:n?maxy-miny+1:0,frames:W.frames()};})()`);
      assert(q.w <= 8 && q.h <= 12, `${mode}: non-cursor pixels corrupted: ${JSON.stringify(q)}`); checked++; if (q.n) changed++;
    }
    assert(changed > 0, 'test must observe cursor movement');
    await ev(`document.getElementById('budget').value=2000000;delete window.__mouseBase;`); await sleep(350);
    console.log(`PASS ${mode}: ${checked} rapid-motion samples, ${changed} changed, no trails or partial scanout (budget 1000)`);
  }
  b.close(); process.exit(0);
})().catch(e => { console.error(e.stack); process.exit(1); });
