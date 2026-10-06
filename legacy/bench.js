const {readExecutableFile}=require('./src/runtime/executable');
const {TernaryVM}=require('./src/runtime/ternary_vm');
const exe=readExecutableFile('./build/wolf3d_patched.tna');
const vm=new TernaryVM(1<<22,{videoWidth:160,videoHeight:120,backend:'interpreter'});
vm.reset(); vm.loadExecutable(exe);
let prev=exe.entry, bad=0; const N=600000;
let t=process.hrtime.bigint();
for(let i=0;i<N;i++){vm.run(1);const pc=vm.backend.cpu.PC;if(pc<1000&&prev>=1000)bad++;prev=pc;}
let ms=Number(process.hrtime.bigint()-t)/1e6;
console.log(bad===0?'CLEAN':'REGRESSIONS: '+bad, `| run(1)x${N}: ${ms.toFixed(0)} ms = ${(N/ms*1000/1e6).toFixed(2)} M instr/s`, '| halted', vm.backend.cpu.halted, '| PC', vm.backend.cpu.PC);
t=process.hrtime.bigint(); vm.run(3000000); ms=Number(process.hrtime.bigint()-t)/1e6;
console.log(`run(3M) en bloc: ${ms.toFixed(0)} ms = ${(3e6/ms*1000/1e6).toFixed(2)} M instr/s | halted ${vm.backend.cpu.halted} PC ${vm.backend.cpu.PC}`);
