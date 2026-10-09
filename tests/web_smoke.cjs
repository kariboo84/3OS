// tests/web_smoke.cjs — banc d'essai (web/index.html) : boot du noyau via le sélecteur, clics, crash.
// Prérequis : serveur http :8124 (racine du dépôt), Chrome CDP :9231. Lancé par ./check.sh --web.
// Vérifie : écran 576x360 au boot, Tetris lancé au double-clic, Échap, crash tué, 0 exception JS.
const assert = require('assert');
const { connect, sleep } = require('./cdp.cjs');
(async () => {
  const b = await connect(), { ev, shot, exceptions, cdp } = b;
  await cdp('Page.navigate', { url: 'http://127.0.0.1:' + (process.env.TRI27_HTTP || 8124) + '/web/?v=' + Date.now() });
  await sleep(3000);
  await ev(`(async()=>{const s=document.getElementById('examples'); s.value='../os/kernel3.tas'; s.dispatchEvent(new Event('change')); await new Promise(r=>setTimeout(r,1500)); document.getElementById('btnRun').click(); return 1})()`);
  await sleep(5000);
  const size = () => ev(`document.getElementById('screen').width+'x'+document.getElementById('screen').height`);
  const con = () => ev(`document.getElementById('console').textContent`);
  console.log('boot : écran', await size(), '| console :', JSON.stringify((await con()).slice(0, 160)));
  assert.equal(await size(), '576x360', 'boot 3OS en mode 576x360');
  await shot('os_web_boot');
  await sleep(1500); console.log('bureau inactif :', await ev(`document.getElementById('stats').textContent`));
  const click = async (fx, fy) => {
    const R = await ev(`(()=>{const c=document.getElementById('screen'); const r=c.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height,cw:c.width,ch:c.height}})()`);
    const x = R.x + fx * R.w / R.cw, y = R.y + fy * R.h / R.ch;
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 }); await sleep(70);
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }); await sleep(70);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }); await sleep(70);
  };
  await click(100, 135);           // ligne « 4 tetris » : selection
  await click(100, 135);           // double clic : ouvrir
  await sleep(2500);
  console.log('après clic tetris : écran', await size());
  assert.equal(await size(), '320x200', 'double-clic lance Tetris (320x200)');
  await ev(`document.getElementById('screen').focus()`);
  for (const [k, c] of [['ArrowLeft', 37], [' ', 32]]) { await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, windowsVirtualKeyCode: c }); await sleep(150); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, windowsVirtualKeyCode: c }); await sleep(400); }
  await shot('os_web_tetris');
  console.log('tetris en jeu :', await ev(`document.getElementById('stats').textContent`));
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(150);
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(2500);
  console.log('après Échap : écran', await size());
  assert.equal(await size(), '576x360', 'Échap revient au bureau');
  await click(100, 220);           // ligne « 9 crash » : selection
  await click(100, 220);           // double clic : ouvrir
  await sleep(2500);
  const c2 = await con();
  console.log('après crash : écran', await size(), '| fin console :', JSON.stringify(c2.slice(-160)));
  assert(c2.includes('crash tue : faute memoire'), 'crash tué sans faire tomber le système');
  await shot('os_web_back');
  console.log('statut', await ev(`document.getElementById('stats').textContent`));
  console.log('exceptions', exceptions.length, exceptions.slice(0, 3));
  assert.equal(exceptions.length, 0, exceptions.join('\n'));
  console.log('PASS banc d\'essai : boot, Tetris, Échap, crash tué, exceptions 0');
  b.close(); process.exit(0);
})().catch(e => { console.error(e.stack); process.exit(1); });
