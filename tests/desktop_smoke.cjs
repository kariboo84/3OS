// tests/desktop_smoke.cjs — bureau 3OS (web/index.html?boot=3os) dans Chrome : boot auto, souris, clavier,
// fenêtres, éditeur, persistance du disque. Captures dans SHOT_DIR. Prérequis : cdp.cjs, :8124, CDP :9231.
// PAGE_URL permet de viser une autre page (défaut : bureau direct). UI_DISK : image de test optionnelle
// (défaut : l'image servie, os/3os.t3d, via app.js).
const fs = require('fs'), assert = require('assert');
const { connect, sleep } = require('./cdp.cjs');
(async () => {
  const pageUrl = process.env.PAGE_URL || 'http://127.0.0.1:' + (process.env.TRI27_HTTP || 8124) + '/web/index.html?boot=3os';
  const b = await connect(), { ev, cdp, until, shot, exceptions } = b;
  const pixels = async (x = 0, y = 0, w = 576, h = 360) => ev(`(()=>{const d=ctx.getImageData(${x},${y},${w},${h}).data;let hash=0,col=new Set();for(let i=0;i<d.length;i+=4){hash=(Math.imul(hash,31)+d[i]+d[i+1]*3+d[i+2]*9)>>>0;col.add(d[i]+d[i+1]*256+d[i+2]*65536);}return {hash,colors:col.size}})()`);
  const rgb = (x, y) => ev(`Array.from(ctx.getImageData(${x},${y},1,1).data).slice(0,3)`);
  const size = () => ev("canvas.width+'x'+canvas.height");
  const rect = () => ev(`(()=>{const r=canvas.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height,cw:canvas.width,ch:canvas.height}})()`);
  const pointer = async (type, fx, fy, buttons = 0) => { const r = await rect(); const x = r.x + fx * r.w / r.cw, y = r.y + fy * r.h / r.ch; await cdp('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons, clickCount: 1 }); };
  const click = async (x, y) => { await pointer('mouseMoved', x, y); await sleep(70); await pointer('mousePressed', x, y, 1); await sleep(110); await pointer('mouseReleased', x, y); await sleep(200); };
  const key = async (k, code) => { await ev('canvas.focus()'); await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, windowsVirtualKeyCode: code }); await sleep(100); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, windowsVirtualKeyCode: code }); await sleep(180); };
  const drag = async (x, y, tx, ty) => { await pointer('mouseMoved', x, y); await pointer('mousePressed', x, y, 1); await sleep(120); await pointer('mouseMoved', tx, ty, 1); await sleep(180); await pointer('mouseReleased', tx, ty); await sleep(180); };

  await cdp('Page.navigate', { url: pageUrl });
  await until(() => ev(`typeof W!=='undefined' && W && document.querySelector('option[value="../os/kernel3.tas"]')!==null`), 'WASM ready');
  if (pageUrl.includes('boot=3os')) { await until(() => ev('W.frames()>=2&&canvas.width===576'), 'automatic OS boot'); console.log('PASS automatic 3OS boot'); }
  await ev('localStorage.clear()');
  await ev(`(async()=>{ await diskReady; ${process.env.UI_DISK ? `diskImage=new Int16Array(await (await fetch(${JSON.stringify(process.env.UI_DISK)},{cache:'no-store'})).arrayBuffer());` : ''}
    srcEl.value=await(await fetch('../os/kernel3.tas',{cache:'no-store'})).text(); await assembleAndRun(); return true; })()`);
  await until(() => ev('W.frames()>=2 && canvas.width===576'), 'desktop boot'); await sleep(350);

  const boot = await pixels(); assert(boot.colors >= 8, 'color palette'); await shot('desktop-color'); console.log('PASS color boot', boot);
  const idle0 = await ev('W.frames()'); await sleep(500); assert.equal(await ev('W.frames()'), idle0, 'idle must not redraw continuously'); console.log('PASS idle WFI');
  await key('c', 67); assert.equal((await pixels()).colors, 3, 'true three-level grayscale'); await shot('desktop-gray');
  await click(140, 10); await click(150, 33); assert((await pixels()).colors >= 8, 'menu switches back to color'); console.log('PASS C + menu modes');
  await click(18, 10); await click(40, 33); assert.deepEqual(await rgb(158, 128), [58, 107, 196]); await shot('desktop-about'); await click(390, 250); console.log('PASS about + OK');
  // Selection is a single click, not an accidental immediate launch.
  await click(100, 135); assert.equal(await size(), '576x360'); await key('Enter', 13);
  await until(async () => await size() === '320x200', 'Tetris launch'); await shot('desktop-tetris');
  await key('ArrowLeft', 37); await key(' ', 32); await key('Escape', 27);
  await until(async () => await size() === '576x360', 'return from Tetris'); assert((await pixels()).colors >= 8); console.log('PASS select + Enter -> Tetris -> desktop');
  // Double click another real application and test kernel isolation.
  await click(110, 220); await click(110, 220); await until(() => ev(`conEl.textContent.includes('crash tue : faute memoire')`), 'crash killed'); assert.equal(await size(), '576x360'); console.log('PASS double click + process isolation');
  const beforeMove=await pixels(24,38,20,258); // Bande de bord, hors du curseur : vraie géométrie, pas deux couleurs identiques.
  await drag(170,47,200,70); assert.notEqual((await pixels(24,38,20,258)).hash,beforeMove.hash,'window moved');
  const beforeResize=await pixels(338,260,6,30);
  await drag(355,316,325,251); assert.notEqual((await pixels(338,260,6,30)).hash,beforeResize.hash,'window resized'); await shot('desktop-resize'); console.log('PASS drag + resize');
  // Smaller Finder scrolls to the document with a functional thumb.
  const beforeScroll = await pixels(55, 100, 180, 90); await click(316, 228); const afterScroll = await pixels(55, 100, 180, 90);
  assert.notEqual(beforeScroll.hash, afterScroll.hash, 'scroll content changed');
  await drag(319, 140, 319, 170); assert.notEqual((await pixels(55, 100, 180, 90)).hash, afterScroll.hash, 'scroll thumb changes content');
  await click(130, 10); await click(150, 74); // restore canonical window layout
  await click(363, 80); await click(533, 310); assert.equal(await size(), '576x360'); console.log('PASS scroll + arrange + close/reopen help');
  const readDiskText = () => ev(`(()=>{const d=new Int16Array(W.memory.buffer,W.disk_ptr(),W.disk_len());const word=p=>d[p]+19683*d[p+1]+387420489*d[p+2];for(let i=0;i<word(3);i++){const p=6+i*30;let name='';for(let j=0;j<16&&d[p+j];j++)name+=String.fromCharCode(d[p+j]);if(name==='lisez-moi'){const s=word(p+16)*729,n=word(p+19);let text='';for(let j=0;j<n;j++)text+=String.fromCharCode(d[s+j]);return text;}}throw Error('missing lisez-moi');})()`);
  const textBefore = await readDiskText();
  await key('F2', 113); await until(() => ev('W.text_input()===1'), 'editor'); await shot('desktop-editor');
  // Append via actual browser input, save through F2; test-only disk lives in WASM/localStorage.
  await key('Home', 36); await key('End', 35);
  await key('z', 90); await key('F2', 113); await sleep(400);
  assert(await ev(`Object.keys(localStorage).some(k=>k.startsWith('3os.disk:'))`), 'disk saved in browser');
  await key('Escape', 27); await until(() => ev('W.text_input()===0'), 'editor return'); assert.equal(await size(), '576x360');
  const textAfter = await readDiskText(); assert.equal(textAfter, textBefore + 'z', 'actual 3FS file readback');
  // Reload from persistent browser storage, not an injected disk or JS mock.
  await cdp('Page.navigate', { url: pageUrl });
  await until(() => ev(`typeof W!=='undefined'&&W&&typeof diskImage!=='undefined'&&diskImage&&diskKey`), 'reload disk');
  await ev(`(async()=>{await diskReady;srcEl.value=await(await fetch('../os/kernel3.tas',{cache:'no-store'})).text();await assembleAndRun();return true;})()`);
  await until(() => ev('W.frames()>=2&&canvas.width===576'), 'reboot persisted');
  assert.equal(await readDiskText(), textAfter, 'file survives reload');
  await ev('localStorage.clear()');
  console.log('PASS editor input + exact file readback + save + browser reload');
  await shot('desktop-final');
  assert.equal(exceptions.length, 0, exceptions.join('\n'));
  console.log('PASS exceptions 0; captures', b.shotDir);
  b.close(); process.exit(0);
})().catch(e => { console.error(e.stack); process.exit(1); });
