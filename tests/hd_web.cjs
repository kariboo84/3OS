// tests/hd_web.cjs — mode vidéo 3 dans le navigateur : la démo hd.tas affiche 1920x1080 sans erreur.
// Prérequis : serveur :8124 (racine du dépôt), Chrome headless CDP :9231. Lancé par ./check.sh --web.
const assert = require('assert');
const { connect, sleep } = require('./cdp.cjs');
(async () => {
  const b = await connect();
  await b.cdp('Page.navigate', { url: 'http://127.0.0.1:8124/web/?v=' + Date.now() });
  await b.until(() => b.ev(`!!document.getElementById('examples') && document.getElementById('examples').options.length > 2`), 'page chargée');
  await sleep(500);
  await b.ev(`(async()=>{const s=document.getElementById('examples'); s.value='hd.tas'; s.dispatchEvent(new Event('change')); await new Promise(r=>setTimeout(r,1500)); document.getElementById('btnRun').click(); return 1})()`);
  await b.until(() => b.ev(`document.getElementById('console').textContent.includes('hd : 1920x1080')`), 'démo hd terminée', 600);
  await sleep(500);
  const size = await b.ev(`document.getElementById('screen').width + 'x' + document.getElementById('screen').height`);
  assert.equal(size, '1920x1080', 'canvas en 1920x1080');
  // échantillons du canvas : coin haut gauche ≈ noir, haut droit ≈ rouge, bas droit (rampe) ≈ blanc
  const px = await b.ev(`(()=>{const c=document.getElementById('screen').getContext('2d');
    const g=(x,y)=>Array.from(c.getImageData(x,y,1,1).data.slice(0,3));
    return {tl:g(2,2), tr:g(1917,2), br:g(1917,1077), bl:g(2,1077)}})()`);
  const near = (a, e) => a.every((v, i) => Math.abs(v - e[i]) <= 3);
  assert(near(px.tl, [0, 0, 0]) && near(px.tr, [255, 0, 0]) && near(px.br, [255, 255, 255]) && near(px.bl, [0, 0, 0]), 'pixels attendus ' + JSON.stringify(px));
  const shot = await b.shot('hd_web');
  assert.equal(b.exceptions.length, 0, 'exceptions JS : ' + b.exceptions.join(' | '));
  console.log('PASS hd 1920x1080 dans le navigateur, pixels ' + JSON.stringify(px) + ', capture ' + shot);
  // carte graphique 2D dans le navigateur : la démo gpu.tas doit tourner et rapporter ses images/s
  await b.ev(`(async()=>{const s=document.getElementById('examples'); s.value='gpu.tas'; s.dispatchEvent(new Event('change')); await new Promise(r=>setTimeout(r,1500)); document.getElementById('btnRun').click(); return 1})()`);
  await b.until(() => b.ev(`/gpu : 1920x1080, 120 images/.test(document.getElementById('console').textContent)`), 'démo gpu terminée', 900);
  const line = (await b.ev(`document.getElementById('console').textContent`)).split('\n').find(l => l.startsWith('gpu :'));
  const fps = +(/(\d+) images\/s/.exec(line) || [])[1];
  assert(fps > 0, 'images/s mesurées');
  await sleep(300);
  const g = await b.shot('gpu_web');
  assert.equal(b.exceptions.length, 0, 'exceptions JS : ' + b.exceptions.join(' | '));
  console.log('PASS gpu 2D dans le navigateur : ' + line.trim() + ', capture ' + g);
  b.close(); process.exit(0);
})().catch(e => { console.log('FAIL ' + e.message); process.exit(1); });
