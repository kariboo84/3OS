// End-to-end native image decoding: Finder -> 3FS -> C codec -> framebuffer -> Escape.
const assert=require('assert'),fs=require('fs'),path=require('path');
const {connect,sleep}=require('./cdp.cjs');
(async()=>{
  const b=await connect(),{cdp,ev,until}=b;
  await cdp('Emulation.setDeviceMetricsOverride',{width:1500,height:1000,deviceScaleFactor:1,mobile:false});
  await cdp('Page.navigate',{url:'http://127.0.0.1:'+(process.env.TRI27_HTTP||8124)+'/web/index.html?boot=3os'});
  await until(()=>ev("typeof W!=='undefined'&&W&&typeof diskReady!=='undefined'"),'WASM');
  await ev("(async()=>{running=false;await diskReady;for(const k of Object.keys(localStorage))if(k.startsWith('3os.disk:'))localStorage.removeItem(k);diskImage=new Int16Array(await(await fetch('../os/3os.t3d',{cache:'no-store'})).arrayBuffer());await assembleAndRun();})()");
  await until(()=>ev('W.frames()>=2&&canvas.width===576'),'desktop');
  // Turn host image decoders into errors: the native acceptance path needs neither.
  await ev("window.Image=class{constructor(){throw Error('host Image decoder forbidden')}};window.createImageBitmap=()=>Promise.reject(Error('host bitmap decoder forbidden'))");
  const key=async(k,c)=>{await ev('canvas.focus()');await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:k,windowsVirtualKeyCode:c});await sleep(80);await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:k,windowsVirtualKeyCode:c});await sleep(180);};
  const click=async(x,y)=>{
    const r=await ev('(()=>{const r=canvas.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}})()');
    const p={x:r.x+x*r.w/576,y:r.y+y*r.h/360,button:'left',clickCount:1};
    await cdp('Input.dispatchMouseEvent',{...p,type:'mouseMoved',buttons:0});await sleep(80);
    await cdp('Input.dispatchMouseEvent',{...p,type:'mousePressed',buttons:1});await sleep(90);
    await cdp('Input.dispatchMouseEvent',{...p,type:'mouseReleased',buttons:0});await sleep(200);
  };
  await key('F4',115);await click(361,196);await key('Enter',13); // Actual UI selects 27-trit color.
  const disk=()=>ev(`(()=>{const d=new Int16Array(W.memory.buffer,W.disk_ptr(),W.disk_len()),word=p=>d[p]+3**9*d[p+1]+3**18*d[p+2],files=[];for(let i=0;i<word(3);i++){const p=6+i*30;let name='';for(let j=0;j<16&&d[p+j];j++)name+=String.fromCharCode(d[p+j]);files.push({name,start:word(p+16)*729,length:word(p+19)});}return files})()`);
  const rgb=(x,y)=>ev(`Array.from(ctx.getImageData(${x},${y},1,1).data).slice(0,3)`);
  const original=await rgb(40,8),files=await disk(),report=[];
  for(const name of ['demo.png','demo.bmp','demo.ppm']){
    const idx=files.findIndex(f=>f.name===name);assert(idx>=0,name+' in 3FS');
    const entry=files[idx];
    if(name.endsWith('.png'))assert.deepEqual(await ev(`Array.from(new Int16Array(W.memory.buffer,W.disk_ptr(),W.disk_len()).slice(${entry.start},${entry.start+8}))`),[137,80,78,71,13,10,26,10],'PNG binary signature, not UTF-8 lossy text');
    const old=await ev('conText.length');
    await key('End',35);for(let i=files.length-1;i>idx;i--)await key('ArrowUp',38);
    await key('Enter',13);
    await until(()=>ev(`conText.slice(${old}).includes('[images] ${name} 384 x 216 RGBA native depth=27 origin=96,72')`),'native '+name,900);
    await until(async()=>JSON.stringify(await rgb(371,115))!==JSON.stringify(original),'image pixels');await sleep(150);
    assert.equal(await ev(`(()=>{const d=new Int16Array(W.memory.buffer,W.disk_ptr(),W.disk_len()),word=p=>d[p]+3**9*d[p+1]+3**18*d[p+2];for(let i=0;i<word(3);i++){const p=6+i*30;let n='';for(let j=0;j<16&&d[p+j];j++)n+=String.fromCharCode(d[p+j]);if(n==='image-cible')return String.fromCharCode(...d.slice(word(p+16)*729,word(p+16)*729+word(p+19)));}})()`),name,'Finder passed the exact selected file');
    // Opaque sky, sun and ground: exact RGB8 values, within final HD quantization.
    const probes=[[40,25,[42,82,153]],[280,44,[246, 209, 101]],[25,190,[41,126,102]]];
    if(name!=='demo.png')probes[1][2]=[255,212,87];
    for(const [x,y,expected] of probes){const got=await rgb(96+x,72+y);assert(got.every((v,i)=>Math.abs(v-expected[i])<=1),`${name} pixel ${x},${y}: ${got} vs ${expected}`);}
    assert.deepEqual(await rgb(96+4,72+4),name==='demo.png'?[192,192,192]:[255,255,255],'transparent PNG corner blended over native checkerboard');
    const shot=path.join(b.shotDir,'images-native-'+name.split('.')[1]+'.png');fs.writeFileSync(shot,Buffer.from(await ev("canvas.toDataURL('image/png').split(',')[1]"),'base64'));
    report.push({name,dimensions:[384,216],native: true,hostDecodersForbidden:true,shot});
    await key('Escape',27);await until(async()=>JSON.stringify(await rgb(40,8))===JSON.stringify(original),'return from '+name);
    console.log('PASS Finder -> '+name+' -> native RGBA/alpha/1:1 -> Escape');
  }
  assert.equal(b.exceptions.length,0,b.exceptions.join('\n'));
  fs.writeFileSync(path.join(b.shotDir,'images-native.json'),JSON.stringify(report,null,2));
  await cdp('Emulation.clearDeviceMetricsOverride');
  console.log('PASS 3 native formats; no host image decoder, no JS exception');b.close();process.exit(0);
})().catch(e=>{console.error(e.stack);process.exit(1)});
