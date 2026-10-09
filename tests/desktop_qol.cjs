// Gestes réels : espace 1080p, fenêtres natives, réduire/restaurer, maximiser et raccourcis.
const assert=require('assert'),fs=require('fs'),path=require('path');
const {connect,sleep}=require('./cdp.cjs');
(async()=>{
  const b=await connect(),{cdp,ev,until}=b;
  await cdp('Emulation.setDeviceMetricsOverride',{width:2200,height:1500,deviceScaleFactor:1,mobile:false});
  const url='http://127.0.0.1:'+(process.env.TRI27_HTTP||8124)+'/web/index.html?boot=3os';
  await cdp('Page.navigate',{url});
  await until(()=>ev("typeof W!=='undefined'&&W&&typeof diskReady!=='undefined'"),'WASM');
  await ev(`(async()=>{running=false;await diskReady;for(const k of Object.keys(localStorage))if(k.startsWith('3os.disk:'))localStorage.removeItem(k);diskImage=new Int16Array(await(await fetch('../os/3os.t3d',{cache:'no-store'})).arrayBuffer());await assembleAndRun();})()`);
  await until(()=>ev('W.frames()>=2&&canvas.width===576'),'bureau');
  const scale=async()=>await ev('canvas.width===576?1:2');
  const pointer=async(type,x,y,buttons=0)=>{
    const u=await scale(),r=await ev('(()=>{const r=canvas.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height,cw:canvas.width,ch:canvas.height,fs:document.fullscreenElement===canvas}})()');
    if(r.fs){const k=Math.min(r.w/r.cw,r.h/r.ch),w=r.cw*k,h=r.ch*k;r.x+=(r.w-w)/2;r.y+=(r.h-h)/2;r.w=w;r.h=h;}
    await cdp('Input.dispatchMouseEvent',{type,x:r.x+x*u*r.w/r.cw,y:r.y+y*u*r.h/r.ch,button:type==='mouseMoved'?'none':'left',buttons,clickCount:1});
  };
  const click=async(x,y)=>{await pointer('mouseMoved',x,y);await sleep(60);await pointer('mousePressed',x,y,1);await sleep(90);await pointer('mouseReleased',x,y);await sleep(180);};
  const key=async(k,c)=>{await ev('canvas.focus()');await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:k,windowsVirtualKeyCode:c});await sleep(90);await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:k,windowsVirtualKeyCode:c});await sleep(180);};
  const rgb=async(x,y)=>{const u=await scale();return ev(`Array.from(ctx.getImageData(${x*u},${y*u},1,1).data).slice(0,3)`);};
  const capture=async(name)=>{
    const data=await ev("canvas.toDataURL('image/png').split(',')[1]");
    fs.writeFileSync(path.join(b.shotDir,name+'.png'),Buffer.from(data,'base64'));
  };
  await key('F4',115); // Panneau accessible sans souris.
  assert.deepEqual(await rgb(146,105),[255,255,245]);
  await click(193,196); await until(()=>ev('canvas.width===1920&&canvas.height===1080'),'1080p');
  await click(540,196); await capture('desktop-native-settings'); await key('Enter',13);
  await pointer('mouseMoved',10,25);await sleep(200);
  await capture('desktop-native-1080');
  const title=await rgb(40,45);
  await key('F10',121); assert.deepEqual(await rgb(900,30),title,'maximisation utilise le bord droit du vrai écran');
  await capture('desktop-native-maximized');
  await key('F10',121); assert.notDeepEqual(await rgb(900,30),title,'géométrie restaurée');
  console.log('PASS F4 Affichage ; F10 maximiser/restaurer sur 1920 pixels');
  // Géométrie rangée du Disque : x=24, w=390 ; bouton réduire x+w-55.
  await click(379,47); assert.notDeepEqual(await rgb(40,45),title,'fenêtre réellement réduite');
  await click(100,528); assert.deepEqual(await rgb(40,45),title,'barre des fenêtres restaure');
  console.log('PASS réduire et restaurer par la barre des fenêtres');
  // Double-clic de titre, intervalle inférieur aux 450 ms du guest.
  await pointer('mouseMoved',170,47);await sleep(80);
  for(let i=0;i<2;i++){await pointer('mousePressed',170,47,1);await sleep(65);await pointer('mouseReleased',170,47);await sleep(70);}
  assert.deepEqual(await rgb(900,30),title,'double-clic maximise');await key('F10',121);
  await pointer('mouseMoved',170,47);await pointer('mousePressed',170,47,1);await sleep(150);
  await pointer('mouseMoved',800,100,1);await sleep(180);await pointer('mouseReleased',800,100);await sleep(180);
  assert.deepEqual(await rgb(700,100),title,'fenêtre peut occuper la zone au-delà de l’ancien bureau 1280 pixels');
  await capture('desktop-native-extra-space');
  console.log('PASS double-clic de titre et espace de travail supplémentaire');
  await key('F5',116); await key('Home',36);
  assert.deepEqual(await rgb(573,132),[59,108,196],'Home sélectionne réellement la première ligne');
  await key('End',35);const count=await ev('(()=>{const d=new Int16Array(W.memory.buffer,W.disk_ptr(),W.disk_len());return d[3]+3**9*d[4]+3**18*d[5]})()');
  assert.deepEqual(await rgb(573,132+(Math.min(count,Math.floor((360-68)/17))-1)*17),[59,108,196],'End sélectionne réellement la dernière ligne');
  assert.notDeepEqual(await rgb(573,132),[59,108,196],'ancienne sélection retirée');
  await key('Tab',9); assert.deepEqual(await rgb(620,77),title,'Tab donne le premier plan à Lisez-moi');
  await key('F4',115);await key('Escape',27); // Escape ferme le panneau, pas le bureau.
  assert.equal(await ev('canvas.width'),1920);
  await cdp('Runtime.evaluate',{expression:"document.getElementById('btnFullscreen').click()",userGesture:true});
  await until(()=>ev('document.fullscreenElement===canvas'),'vrai plein écran');
  assert.equal(await ev('innerWidth'),2200);assert.equal(await ev('innerHeight'),1500);
  await key('F10',121);assert.deepEqual(await rgb(900,30),title);
  await click(947,32);assert.notDeepEqual(await rgb(900,30),title,'clic exact sur restaurer malgré les bandes du plein écran');
  assert.deepEqual(await rgb(620,77),title,'fenêtre restaurée, pas simplement réduite');
  await ev('document.exitFullscreen()');
  assert.equal(await ev('document.fullscreenElement'),null);
  console.log('PASS vrai plein écran et sortie');
  assert.equal(b.exceptions.length,0,b.exceptions.join('\n'));
  await ev("for(const k of Object.keys(localStorage))if(k.startsWith('3os.disk:'))localStorage.removeItem(k)");
  await cdp('Emulation.clearDeviceMetricsOverride');
  console.log('PASS F5, Home/End, Tab, Escape ; exceptions 0');b.close();process.exit(0);
})().catch(e=>{console.error(e.stack);process.exit(1);});
