const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cota = require('../quota.cjs');
const {runControlled} = require('../run-sync.cjs');
const HOUR = 3600000;
// 12/11/2026 03:00 UTC = 11/11 19:00 no Pacífico (PST, UTC-8).
const NOITE = Date.UTC(2026,10,12,3,0);
function fixture(t) { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sync-quota-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true})); return path.join(dir,'state.json'); }

test('dia da cota segue o Pacífico e a virada cai na meia-noite de lá', () => {
  assert.equal(cota.diaDaCota(NOITE), '2026-11-11');
  assert.equal(new Date(cota.proximaVirada(NOITE)).toISOString(), '2026-11-12T08:00:00.000Z');
  // Horário de verão dos EUA (PDT, UTC-7).
  assert.equal(new Date(cota.proximaVirada(Date.UTC(2026,6,1,12,0))).toISOString(), '2026-07-02T07:00:00.000Z');
});

test('uso de outro dia vale zero e duas fontes se juntam pelo maior valor', () => {
  assert.deepEqual(cota.usoDeHoje({dia:'2026-11-10',leituras:9999,gravacoes:9},NOITE), {dia:'2026-11-11',leituras:0,gravacoes:0});
  assert.deepEqual(cota.maiorUso({dia:'2026-11-11',leituras:100,gravacoes:50},{dia:'2026-11-11',leituras:80,gravacoes:70},NOITE), {dia:'2026-11-11',leituras:100,gravacoes:70});
});

test('orçamento é metade da cota grátis e ciclo completo só cabe abaixo de 80%', () => {
  assert.deepEqual({...cota.LIMITE}, {leituras:25000,gravacoes:10000});
  const dia = '2026-11-11', FIM = Date.UTC(2026,10,12,7,30); // 23:30 no Pacífico
  assert.equal(cota.cabeCicloCompleto({dia,leituras:16000,gravacoes:0},{leituras:3000,gravacoes:10},FIM), true);
  assert.equal(cota.cabeCicloCompleto({dia,leituras:17500,gravacoes:0},{leituras:3000,gravacoes:10},FIM), false);
  assert.equal(cota.esgotado({dia,leituras:24999,gravacoes:0},NOITE), false);
  assert.equal(cota.esgotado({dia,leituras:0,gravacoes:10000},NOITE), true);
});

test('medidor conta documentos lidos e gravações sem contar em dobro, e desliga limpo', async () => {
  class Query { async get() { return {size:this.n}; } }
  class DocumentReference { async get() { return {exists:true}; } }
  class Transaction { async get(x) { return x instanceof Query ? {size:x.n} : {exists:true}; } }
  class WriteBatch { set() { return this; } update() { return this; } create() { return this; } delete() { return this; } }
  const ns = {Query, DocumentReference, Transaction, WriteBatch};
  const originalGet = Query.prototype.get;
  const m = cota.medirFirestore(ns);
  const q = Object.assign(new Query(), {n:40}), vazia = Object.assign(new Query(), {n:0});
  await q.get(); await vazia.get(); await new DocumentReference().get();
  const tx = new Transaction(); await tx.get(new DocumentReference()); await tx.get(q);
  new WriteBatch().set().update(); new WriteBatch().delete();
  assert.deepEqual(m.contador, {leituras:40+1+1+1+40, gravacoes:3});
  m.desligar();
  assert.equal(Query.prototype.get, originalGet);
});

test('orçamento esgotado pausa sem tocar no Firebase até a virada da cota', async t => {
  const file = fixture(t); let calls = 0;
  fs.writeFileSync(file, JSON.stringify({uso:{dia:'2026-11-11',leituras:25000,gravacoes:10}}));
  const sync = async () => { calls++; return {healthy:true,leituraCompleta:true}; };
  const r = await runControlled({sync,file,now:NOITE});
  assert.equal(r.state,'budget_paused'); assert.equal(calls,0);
  assert.equal(new Date(r.retryAfter).toISOString(),'2026-11-12T08:00:00.000Z');
  assert.equal((await runControlled({sync,file,now:NOITE+HOUR})).state,'paused'); assert.equal(calls,0);
  // Depois da virada, o dia novo começa do zero.
  const depois = await runControlled({sync,file,now:Date.UTC(2026,10,12,8,5)});
  assert.equal(depois.state,'completed'); assert.equal(calls,1);
});

test('perto do limite o ciclo completo é adiado e só a fila roda', async t => {
  const file = fixture(t); const modes = [];
  fs.writeFileSync(file, JSON.stringify({uso:{dia:'2026-11-11',leituras:18000,gravacoes:0},custoCompleto:{leituras:3000,gravacoes:20}}));
  const r = await runControlled({file,now:NOITE,sync:async o=>{modes.push(o.fullSync);return {healthy:true,leituraCompleta:true,fullSync:o.fullSync,uso:{dia:'2026-11-11',leituras:18050,gravacoes:2},custoCiclo:{leituras:50,gravacoes:2}};}});
  assert.deepEqual(modes,[false]); assert.equal(r.economia,true);
  const salvo = JSON.parse(fs.readFileSync(file));
  assert.equal(salvo.lastFullSyncAt,undefined); assert.equal(salvo.uso.leituras,18050);
  assert.deepEqual(salvo.custoCompleto,{leituras:3000,gravacoes:20});
});

test('ciclo que atinge o orçamento já agenda a pausa; custo do completo fica medido', async t => {
  const file = fixture(t);
  const r = await runControlled({file,now:NOITE,sync:async o=>({healthy:true,leituraCompleta:true,fullSync:o.fullSync,uso:{dia:'2026-11-11',leituras:25100,gravacoes:5},custoCiclo:{leituras:4200,gravacoes:5}})});
  assert.equal(r.state,'budget_paused');
  const salvo = JSON.parse(fs.readFileSync(file));
  assert.deepEqual(salvo.custoCompleto,{leituras:4200,gravacoes:5}); assert.equal(salvo.lastFullSyncAt,NOITE);
});

test('estouro real da cota guarda o uso medido até o erro', async t => {
  const file = fixture(t);
  const r = await runControlled({file,now:NOITE,sync:async()=>{throw Object.assign(new Error('Quota exceeded'),{code:8,uso:{dia:'2026-11-11',leituras:700,gravacoes:3}})}});
  assert.equal(r.state,'quota_exceeded'); assert.equal(r.motivo,'cota');
  assert.equal(JSON.parse(fs.readFileSync(file)).uso.leituras,700);
});

test('ritmo espalha o ciclo completo pelas 24 h do dia da cota', () => {
  const dia = '2026-11-11', custo = {leituras:3000,gravacoes:10};
  const h = horaPT => Date.UTC(2026,10,11,8+horaPT,0);
  assert.ok(Math.abs(cota.fracaoDoDia(h(6)) - 0.25) < 1e-9);
  // 06h no Pacífico: permitido 20.000 x (6+2)/24 = 6.667 leituras acumuladas.
  assert.equal(cota.cabeCicloCompleto({dia,leituras:3500,gravacoes:0},custo,h(6)), true);
  assert.equal(cota.cabeCicloCompleto({dia,leituras:4000,gravacoes:0},custo,h(6)), false);
  // O mesmo gasto volta a caber mais tarde no dia.
  assert.equal(cota.cabeCicloCompleto({dia,leituras:4000,gravacoes:0},custo,h(12)), true);
});
