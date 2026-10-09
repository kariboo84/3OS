// Bureau réel via CDP : panneau Affichage, neuf formats, 3FS, rechargement et coût VM.
// TRI27_HTTP / TRI27_CDP comme check.sh ; aucun changement au disque hôte.
const assert = require('assert'), fs = require('fs'), path = require('path');
const { connect, sleep } = require('./cdp.cjs');
(async () => {
  const b = await connect(), { cdp, ev, until, shot } = b;
  const url = 'http://127.0.0.1:' + (process.env.TRI27_HTTP || 8124) + '/web/index.html?boot=3os';
  const widths = [576, 1280, 1920], heights = [360, 720, 1080], depths = [1, 9, 27];
  await cdp('Emulation.setDeviceMetricsOverride', { width: 2200, height: 1500, deviceScaleFactor: 1, mobile: false });
  const size = () => ev('[canvas.width,canvas.height]');
  const scale = async () => { const [w] = await size(); return w === 576 ? 1 : 2; };
  const pointer = async (type, x, y, buttons = 0) => {
    const s = await scale();
    const r = await ev('(()=>{const r=canvas.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height,cw:canvas.width,ch:canvas.height}})()');
    await cdp('Input.dispatchMouseEvent', { type, x: r.x + x*s*r.w/r.cw, y: r.y + y*s*r.h/r.ch,
      button: type === 'mouseMoved' ? 'none' : 'left', buttons, clickCount: 1 });
  };
  const click = async (x, y) => {
    await pointer('mouseMoved', x, y); await sleep(90);
    await pointer('mousePressed', x, y, 1); await sleep(180);
    // La taille peut changer pendant l'appui : relâcher au même point LOGIQUE.
    await pointer('mouseReleased', x, y); await sleep(220);
  };
  const key = async (k, code) => {
    await ev('canvas.focus()');
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, windowsVirtualKeyCode: code }); await sleep(100);
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, windowsVirtualKeyCode: code }); await sleep(200);
  };
  const panelX = async () => { const [w] = await size(); return (w / await scale() - 290) / 2; };
  const rgb = (x, y, s) => ev(`Array.from(ctx.getImageData(${x*s},${y*s},1,1).data).slice(0,3)`);
  const panel = async () => {
    await click(270, 10); await click(280, 33);
    const x = await panelX(), s = await scale();
    assert.deepEqual(await rgb(x+3, 103, s), [255,255,245], 'vrai contenu du panneau rendu par le guest');
  };
  // Relecture exacte du fichier dans le disque 3FS attaché à la VM, pas seulement localStorage.
  const readConfig = () => ev(`(()=>{
    const d=new Int16Array(W.memory.buffer,W.disk_ptr(),W.disk_len());
    const word=p=>d[p]+19683*d[p+1]+387420489*d[p+2];
    for(let i=0;i<word(3);i++){
      const p=6+i*30;let name='';for(let j=0;j<16&&d[p+j];j++)name+=String.fromCharCode(d[p+j]);
      if(name==='config'){const start=word(p+16)*729,n=word(p+19);let t='';for(let j=0;j<n;j++)t+=String.fromCharCode(d[start+j]);return t;}
    }return null;
  })()`);
  const capture = async name => {
    const data = await ev("canvas.toDataURL('image/png').split(',')[1]");
    const file = path.join(b.shotDir, name+'.png');
    const png = Buffer.from(data, 'base64'); fs.writeFileSync(file, png);
    const [w,h] = await size();
    assert.equal(png.readUInt32BE(16), w); assert.equal(png.readUInt32BE(20), h);
    return file; // Pixels natifs du canvas, sans agrandissement artificiel.
  };
  const palette = () => ev(`(()=>{const d=ctx.getImageData(0,0,canvas.width,canvas.height).data,c=new Set();
    for(let i=0;i<d.length;i+=4)c.add(d[i]+256*d[i+1]+65536*d[i+2]);return c.size;})()`);
  const bootReady = (w,h) => until(() => ev(`W.frames()>=2&&canvas.width===${w}&&canvas.height===${h}`), 'bureau '+w+'x'+h, 200);
  await cdp('Page.navigate', { url });
  await until(() => ev("typeof W!=='undefined'&&W&&typeof diskReady!=='undefined'"), 'WASM');
  // Fixtures uniquement dans le navigateur : absent, format invalide, paire invalide, profondeur invalide, dépassement.
  const fixtureBoot = async text => {
    await ev(`(async()=>{
      running=false;await diskReady;
      for(const k of Object.keys(localStorage))if(k.startsWith('3os.disk:'))localStorage.removeItem(k);
      diskImage=new Int16Array(await(await fetch('../os/3os.t3d',{cache:'no-store'})).arrayBuffer());
      const d=diskImage,word=p=>d[p]+19683*d[p+1]+387420489*d[p+2];
      for(let i=0;i<word(3);i++){
        const p=6+i*30;let name='';for(let j=0;j<16&&d[p+j];j++)name+=String.fromCharCode(d[p+j]);
        if(name==='config'){
          const t=${JSON.stringify(text)};
          if(t===null)d[p]=120; // « xonfig » = fichier absent, répertoire restant intact.
          else {const start=word(p+16)*729;d.fill(0,start,start+729);for(let j=0;j<t.length;j++)d[start+j]=t.charCodeAt(j);d[p+19]=t.length;d[p+20]=d[p+21]=0;}
        }
      }
      srcEl.value=await(await fetch('../os/kernel3.tas',{cache:'no-store'})).text();await assembleAndRun();
    })()`);
    await bootReady(576,360);
  };
  for (const text of [null, '1920 1080 27junk\n', '1280 1080 27\n', '1920 1080 8\n', '999999999999999999999 1080 27\n']) {
    await fixtureBoot(text);
    await panel(); // Le bouton 27 doit être sélectionné : repli 576x360@27, pas l'ancien mode 2.
    const x=await panelX(),s=await scale();
    assert.deepEqual(await rgb(x+165,80+58+48+1,s),[59,108,196]);
    assert(await palette()>=8);
    console.log('PASS défaut 576x360@27 :', text===null?'config absent':JSON.stringify(text));
  }
  // Repartir du disque servi, sans fixture ni choix injecté, avant les clics utilisateur.
  await ev(`(async()=>{running=false;diskImage=new Int16Array(await(await fetch('../os/3os.t3d',{cache:'no-store'})).arrayBuffer());await assembleAndRun();})()`);
  await bootReady(576,360); await panel();
  const modes=[];
  // Ordre : trois exigences en premier, puis les six autres couples (dont trit 1280 non divisible par 9).
  for(const [r,d] of [[0,1],[1,2],[2,2],[2,1],[2,0],[1,0],[1,1],[0,0],[0,2]]) {
    let x=await panelX(); await click(x+50,80+58+r*24+10);
    await until(async()=>JSON.stringify(await size())===JSON.stringify([widths[r],heights[r]]),'changement immédiat');
    x=await panelX(); await click(x+205,80+58+d*24+10);
    const expected=`${widths[r]} ${heights[r]} ${depths[d]}\n`;
    await until(async()=>await readConfig()===expected,'écriture 3FS exacte');
    const s=await scale();let colors=await palette();
    if(depths[d]===1&&colors!==3){
      const oldFrames=await ev('W.frames()'),oldColors=colors;
      await until(async()=>await palette()===3,'PRESENT du bureau trois gris',300);
      colors=await palette();console.log('PASS transition terminée au PRESENT',{oldColors,colors,oldFrames,frames:await ev('W.frames()')});
    }
    assert.equal(s,r===0?1:2); if(depths[d]===1)assert.equal(colors,3);else assert(colors>=8);
    assert.deepEqual(await rgb(x+17,80+58+r*24+1,s),depths[d]===1?[0,0,0]:depths[d]===9?[58,107,196]:[59,108,196]);
    assert.deepEqual(await rgb(x+165,80+58+d*24+1,s),depths[d]===1?[0,0,0]:depths[d]===9?[58,107,196]:[59,108,196]);
    const file=await capture(`desktop-display-${widths[r]}x${heights[r]}-${depths[d]}`);
    modes.push({width:widths[r],height:heights[r],depth:depths[d],scale:s,colors,file});
    console.log('PASS panneau',`${widths[r]}x${heights[r]}@${depths[d]}`, 'échelle',s,'3FS relu, PNG natif',file);
  }
  // Choix final 1080p profond ; fermer et lancer Tetris par le raccourci existant.
  await click((await panelX())+50,80+58+48+10);
  await until(async()=>await readConfig()==='1920 1080 27\n','choix final');
  await shot('desktop-display-panel-1080'); await key('Enter',13);
  await key('4',52); await until(async()=>JSON.stringify(await size())==='[320,200]','Tetris');
  await key('Escape',27); await bootReady(1920,1080);
  assert.equal(await readConfig(),'1920 1080 27\n'); console.log('PASS retour de Tetris : 1920x1080@27 conservé');
  // Page.reload, sans assembleAndRun ni disque injecté : vrai boot auto depuis la copie persistée.
  await ev('window.__displayBeforeReload=true');
  await cdp('Page.reload', { ignoreCache: true });
  await until(() => ev("typeof window.__displayBeforeReload==='undefined'&&typeof W!=='undefined'&&W&&W.frames()>=2&&canvas.width===1920&&canvas.height===1080"),'rechargement persistant',200);
  assert.equal(await readConfig(),'1920 1080 27\n');
  assert(await ev("Boolean(diskKey&&localStorage.getItem(diskKey))"), "copie de disque persistée");
  await panel(); const px=await panelX();
  assert.deepEqual(await rgb(px+165,80+58+48+1,await scale()),[59,108,196]);
  await capture('desktop-display-reload-1080'); await key('Enter',13);
  console.log('PASS rechargement : config relu, profondeur 27 sélectionnée, panneau et pixels corrects');
  // Mesure contrôlée : vraie entrée CDP, exécution VM manuelle par tranches de 1000.
  // Le compteur inclut le noyau ; borne d'arrondi d'une image <1000 instructions.
  await pointer('mouseMoved',170,47); await sleep(350); await ev('running=false');
  const settle = () => ev('(()=>{for(let i=0;i<4;i++)W.run(2000000);drawFrame();lastFrames=W.frames();})()');
  await settle();
  const idle=await ev(`(()=>{const c=W.cycles(),f=W.frames();for(let i=0;i<32;i++){vmTime+=16;W.set_time_ms(vmTime);W.run(2000000);}
    return {instructions:W.cycles()-c,frames:W.frames()-f,wakes:32};})()`);
  assert.equal(idle.frames,0,'repos sans redessin');
  const step = () => ev(`(()=>{const c=W.cycles(),f=W.frames();for(let i=0;i<20000&&W.frames()===f&&!W.halted();i++)W.run(1000);
    drawFrame();lastFrames=W.frames();return{instructions:W.cycles()-c,frames:W.frames()-f};})()`);
  await pointer('mousePressed',170,47,1); assert.equal((await step()).frames,1); await settle();
  const drag=[];
  for(let i=0;i<20;i++){
    await pointer('mouseMoved',171+i%10,48+i%10,1);
    const m=await step(); assert.equal(m.frames,1,'une image complète par déplacement');drag.push(m.instructions);await settle();
  }
  await pointer('mouseReleased',180,57); await settle();
  const perf={resolution:'1920x1080@27',scope:'VM + noyau, CDP réel, tranches de 1000 instructions',idle,
    drag:{frames:drag.length,instructions:drag.reduce((a,c)=>a+c,0),perFrame:drag.reduce((a,c)=>a+c,0)/drag.length,
      min:Math.min(...drag),max:Math.max(...drag),samples:drag}};
  fs.writeFileSync(path.join(b.shotDir,'desktop-display-perf.json'),JSON.stringify(perf,null,2)+'\n');
  fs.writeFileSync(path.join(b.shotDir,'desktop-display-modes.json'),JSON.stringify(modes,null,2)+'\n');
  await capture('desktop-display-drag-1080');
  console.log('PASS coût 1080p :',JSON.stringify(perf));
  assert.equal(b.exceptions.length,0,b.exceptions.join('\n'));
  // Le profil de check.sh est dédié ; laisser les tests suivants sur le disque original.
  await ev("for(const k of Object.keys(localStorage))if(k.startsWith('3os.disk:'))localStorage.removeItem(k)");
  await cdp('Emulation.clearDeviceMetricsOverride');
  console.log('PASS exceptions 0 ; neuf formats, persistance et mesures',b.shotDir);
  b.close(); process.exit(0);
})().catch(e=>{console.error(e.stack);process.exit(1);});
