// Run against the actual shipped WebAssembly: node tests/present_snapshot.cjs.
// A guest may mutate video RAM/mode after PRESENT; host must keep the last complete frame.
const fs=require('fs'),path=require('path'),assert=require('assert');
(async()=>{
 const {instance}=await WebAssembly.instantiate(fs.readFileSync(path.resolve(__dirname,'../web/tri27.wasm')),{});
 const W=instance.exports;
 const assemble=s=>{const bytes=new TextEncoder().encode(s),p=W.src_alloc(bytes.length);new Uint8Array(W.memory.buffer,p,bytes.length).set(bytes);assert.equal(W.assemble(p,bytes.length),0);};
 const pixel=()=>{const p=W.fb_render();return Array.from(new Uint8Array(W.memory.buffer,p,4));};
 for(const mode of [0,1,2]){
  const white=mode===1?9841:9841,black=-9841;
  assemble(`li t0,1000
stw t0,-5(zero)
li t1,${mode}
stw t1,-9(zero)
li t1,${white}
stt t1,0(t0)
stw zero,-6(zero)
li t1,${black}
stt t1,0(t0)
wfi
stw zero,-6(zero)
loop: wfi
j loop`);
  W.run(100);assert.equal(W.frames(),1);
  assert.deepEqual(pixel(),[255,255,255,255],`mode ${mode}: no scanout of RAM modified after PRESENT`);
  W.run(100);assert.equal(W.frames(),2);assert.deepEqual(pixel(),[0,0,0,255],`mode ${mode}: next PRESENT publishes new pixels`);
  console.log('PASS latched pixels mode',mode);
 }
 assemble(`li t0,1000
stw t0,-5(zero)
stw zero,-6(zero)
li t1,2
stw t1,-9(zero)
wfi
stw zero,-6(zero)
loop: wfi
j loop`);
 W.run(100);assert.equal(W.fb_width(),320,'mode dimensions belong to last presented image');assert.equal(W.fb_height(),200);
 W.run(100);assert.equal(W.fb_width(),576);assert.equal(W.fb_height(),360);console.log('PASS latched dimensions');
 W.reset();assert.equal(W.frames(),0);assert.deepEqual(pixel(),[0,0,0,255],'reset removes stale frame');console.log('PASS reset');
})().catch(e=>{console.error(e.stack);process.exit(1);});
