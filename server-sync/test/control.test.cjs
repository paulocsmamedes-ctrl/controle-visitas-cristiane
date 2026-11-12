const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {runControlled} = require('../run-sync.cjs');
const HOUR = 3600000;
function fixture(t) { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sync-control-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true})); return path.join(dir,'state.json'); }
test('cota interrompe tentativas por uma hora e retoma após expiração', async t=>{
 const file=fixture(t);let calls=0;
 const sync=async()=>{calls++;throw Object.assign(new Error('Quota exceeded'),{code:8})};
 assert.equal((await runControlled({sync,file,now:HOUR})).state,'quota_exceeded');
 assert.equal((await runControlled({sync,file,now:HOUR+1})).state,'paused');assert.equal(calls,1);
 assert.equal((await runControlled({sync,file,now:2*HOUR})).state,'quota_exceeded');assert.equal(calls,2);
});
test('ciclo frequente processa fila sem reler histórico; histórico volta após uma hora',async t=>{
 const file=fixture(t);const modes=[];const sync=async opts=>{modes.push(opts.fullSync);return {healthy:true,leituraCompleta:true}};
 for(const now of [HOUR,HOUR+300000,2*HOUR])await runControlled({sync,file,now});
 assert.deepEqual(modes,[true,false,true]);
});
test('ciclo incompleto não confirma importação completa e erros inesperados continuam falhando',async t=>{
 const file=fixture(t);await runControlled({file,now:HOUR,sync:async()=>({healthy:false,leituraCompleta:false})});
 assert.equal(JSON.parse(fs.readFileSync(file)).lastFullSyncAt,undefined);
 await assert.rejects(runControlled({file,now:HOUR+1,sync:async()=>{throw Object.assign(new Error('permission denied'),{code:7})}}),/permission denied/);
 assert.equal(JSON.parse(fs.readFileSync(file)).retryAfter,undefined);
});
test('sucesso após cota limpa pausa e não grava dados de clientes no controle',async t=>{
 const file=fixture(t);fs.writeFileSync(file,JSON.stringify({retryAfter:HOUR}));
 await runControlled({file,now:HOUR,sync:async()=>({healthy:true,leituraCompleta:true})});
 const salvo=JSON.parse(fs.readFileSync(file));
 assert.equal(salvo.lastFullSyncAt,HOUR);assert.equal(salvo.retryAfter,undefined);
 assert.deepEqual(Object.keys(salvo).filter(k=>!['lastFullSyncAt','uso','custoCompleto'].includes(k)),[]);
});
