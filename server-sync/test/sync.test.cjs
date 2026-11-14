'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
process.env.GOOGLE_CALENDAR_OWNER='c1';
const api=require('../sync.js');
function clone(v){return structuredClone(v)}
class MemoryDB {
 constructor(initial={}){this.consultas=[];this.rows=new Map();this.version=0;this.tail=Promise.resolve();for(const [key,data] of Object.entries(initial))this.put(key,data)}
 put(key,data){this.rows.set(key,{data:clone(data),version:++this.version})}
 ref(key){return {key,id:key.split('/').at(-1),get:async()=>this.snapshot(key),update:async patch=>{if(!this.rows.has(key))throw Error('missing');this.put(key,{...this.rows.get(key).data,...patch})},delete:async()=>this.rows.delete(key)}}
 snapshot(key){const row=this.rows.get(key);return {id:key.split('/').at(-1),ref:this.ref(key),exists:!!row,data:()=>row?clone(row.data):undefined,updateTime:row?{version:row.version,isEqual(other){return this.version===other?.version}}:undefined}}
 collection(name){const get=async filter=>{const docs=[...this.rows.keys()].filter(k=>k.startsWith(name+'/')).map(k=>this.snapshot(k)).filter(d=>!filter||filter(d.data()));return {docs,size:docs.length}};return {doc:id=>this.ref(name+'/'+id),get:()=>get(),where:(field,op,value)=>{const filtros=[];const q={where:(f,o,v)=>{filtros.push([f,o,v]);return q},get:()=>{this.consultas.push(name+':'+filtros.map(x=>x.join('')).join('&'));return get(d=>filtros.every(([f,o,v])=>o==='>='?d[f]>=v:o==='in'?v.includes(d[f]):d[f]===v))}};return q.where(field,op,value)}}}
 async runTransaction(fn){let release;const prev=this.tail;this.tail=new Promise(r=>release=r);await prev;try{const operations=[];const tx={get:async ref=>this.snapshot(ref.key),update:(ref,patch)=>operations.push(()=>{assert(this.rows.has(ref.key));this.put(ref.key,{...this.rows.get(ref.key).data,...patch})}),create:(ref,data)=>operations.push(()=>{assert(!this.rows.has(ref.key));this.put(ref.key,data)}),delete:ref=>operations.push(()=>this.rows.delete(ref.key))};const result=await fn(tx);operations.forEach(op=>op());return result}finally{release()}}
}
const event=(calendarId='c1',id='e1')=>({id,calendarId,titulo:'Visita antiga',data:'2026-11-15',local:'Centro',descricao:'',raw:{start:{date:'2026-11-15'},end:{date:'2026-11-16'}}});
function response(data,status=200){return new Response(JSON.stringify(data),{status})}
function mockFetch(fn){global.fetch=fn}

test('calendarList segue todas as páginas',async()=>{
 const calls=[];mockFetch(async url=>{const u=new URL(url);calls.push(u.searchParams.get('pageToken'));return response(calls.length===1?{items:[{id:'c1',primary:true}],nextPageToken:'p2'}:{items:[{id:'c2'}]})});
 assert.deepEqual(await api.fetchCalendarIds('token'),['c1','c2']);assert.deepEqual(calls,[null,'p2']);
});
test('IDs de criação e importação são estáveis e distintos por calendário',()=>{
 assert.match(api.createdEventId('v1'),/^[0-9a-v]{5,1024}$/);assert.equal(api.createdEventId('v1'),api.createdEventId('v1'));assert.notEqual(api.importedVisitId('c1','e1'),api.importedVisitId('c2','e1'));
});
test('envio seguido de importação não restaura o snapshot antigo',async()=>{
 const db=new MemoryDB({'visits/v1':{sourceId:'e1',calendarId:'c1',imovel:'Visita nova',data:'2026-11-15',pendingGoogleSync:true}});
 mockFetch(async()=>response({}));const ev=event();const pushed=await api.pushPendingVisits(db,'token',new Map([[api.eventKey('c1','e1'),ev]]));
 await api.importGoogleEventsIntoVisits(db,[ev],{protegidos:pushed.protegidos});assert.equal(db.snapshot('visits/v1').data().imovel,'Visita nova');assert.equal(db.snapshot('visits/v1').data().pendingGoogleSync,false);
});
test('edição concorrente durante PATCH mantém pendência',async()=>{
 const db=new MemoryDB({'visits/v1':{sourceId:'e1',calendarId:'c1',imovel:'Visita original',pendingGoogleSync:true}});
 mockFetch(async()=>{await db.ref('visits/v1').update({imovel:'Visita editada durante envio'});return response({})});await api.pushPendingVisits(db,'token',new Map([[api.eventKey('c1','e1'),event()]]));
 assert.equal(db.snapshot('visits/v1').data().pendingGoogleSync,true);assert.equal(db.snapshot('visits/v1').data().imovel,'Visita editada durante envio');
});
test('evento ausente na janela é buscado diretamente sem descartar a edição',async()=>{
 const db=new MemoryDB({'visits/v1':{sourceId:'e1',calendarId:'c1',imovel:'Visita',pendingGoogleSync:true}});let methods=[];
 mockFetch(async(url,opts)=>{methods.push(opts?.method||'GET');return response({id:'e1',...event().raw})});await api.pushPendingVisits(db,'token',new Map());assert.deepEqual(methods,['GET','PATCH']);assert.equal(db.snapshot('visits/v1').data().pendingGoogleSync,false);
});
test('404 no Google preserva alteração e registra erro',async()=>{
 const db=new MemoryDB({'visits/v1':{sourceId:'e1',calendarId:'c1',imovel:'Visita',pendingGoogleSync:true}});mockFetch(async()=>response({error:{message:'Not found'}},404));
 const result=await api.pushPendingVisits(db,'token',new Map());assert.equal(result.falhas,1);assert.equal(db.snapshot('visits/v1').data().pendingGoogleSync,true);assert.match(db.snapshot('visits/v1').data().googleSyncError,/Not found/);
});
test('criação interrompida recupera o mesmo evento após 409',async()=>{
 const db=new MemoryDB({'visits/v1':{imovel:'Imóvel',data:'2026-11-15',pendingGoogleSync:true}});let posted;
 mockFetch(async(url,opts)=>{if(opts?.method==='POST'){posted=JSON.parse(opts.body);return response({error:{message:'exists'}},409)}if(opts?.method==='PATCH')return response({});return response({id:api.createdEventId('v1'),extendedProperties:{private:{crmVisitId:'v1'}}})});
 const result=await api.pushPendingVisits(db,'token',new Map());assert.equal(result.criados,1);assert.equal(posted.id,api.createdEventId('v1'));assert.equal(db.snapshot('visits/v1').data().sourceId,posted.id);
});
test('edição durante criação preserva campos novos e vincula evento sem duplicar',async()=>{
 const db=new MemoryDB({'visits/v1':{imovel:'Original',data:'2026-11-15',pendingGoogleSync:true}});mockFetch(async()=>{await db.ref('visits/v1').update({imovel:'Nova edição'});return response({id:api.createdEventId('v1')})});
 await api.pushPendingVisits(db,'token',new Map());const v=db.snapshot('visits/v1').data();assert.equal(v.imovel,'Nova edição');assert.equal(v.pendingGoogleSync,true);assert.equal(v.sourceId,api.createdEventId('v1'));
});
test('importações concorrentes criam apenas um documento',async()=>{
 const db=new MemoryDB();await Promise.all([api.importGoogleEventsIntoVisits(db,[event()]),api.importGoogleEventsIntoVisits(db,[event()])]);assert.equal((await db.collection('visits').get()).size,1);
});
test('mesmo eventId em calendários diferentes preserva ambos',async()=>{
 const db=new MemoryDB();await api.importGoogleEventsIntoVisits(db,[event('c1'),event('c2')]);assert.equal((await db.collection('visits').get()).size,2);
});
test('ausência ou renomeação não apaga histórico',async()=>{
 const db=new MemoryDB({'visits/v1':{sourceId:'e1',calendarId:'c1',imovel:'Visita',fromGoogle:true}});await api.importGoogleEventsIntoVisits(db,[],{leituraCompleta:true});await api.importGoogleEventsIntoVisits(db,[{...event(),titulo:'Outro compromisso'}]);assert(db.snapshot('visits/v1').exists);
});
test('falha de commit não retorna sucesso de importação',async()=>{
 const db=new MemoryDB();db.runTransaction=async()=>{throw Error('permission-denied')};await assert.rejects(api.importGoogleEventsIntoVisits(db,[event()]),/permission-denied/);
});
test('pendência impede sobrescrever uma edição local',async()=>{
 const db=new MemoryDB({'visits/v1':{sourceId:'e1',calendarId:'c1',imovel:'Edição local',pendingGoogleSync:true}});await api.importGoogleEventsIntoVisits(db,[event()]);assert.equal(db.snapshot('visits/v1').data().imovel,'Edição local');
});
test('tombstone evita reimportação mesmo se exclusão do Google falhar',async()=>{
 const ev=event();const key=api.importedVisitId('c1','e1');const db=new MemoryDB({['googleDeletions/'+key]:{sourceId:'e1',calendarId:'c1'}});mockFetch(async()=>response({error:{message:'forbidden'}},403));
 const deletion=await api.processDeletions(db,'token');await api.importGoogleEventsIntoVisits(db,[ev],deletion);assert.equal(deletion.falhas,1);assert.equal((await db.collection('visits').get()).size,0);
});
test('pedido novo de exclusão durante DELETE não é apagado',async()=>{
 const db=new MemoryDB({'googleDeletions/q':{sourceId:'e1',calendarId:'c1',requestedAt:1}});mockFetch(async()=>{await db.ref('googleDeletions/q').update({requestedAt:2});return new Response(null,{status:204})});await api.processDeletions(db,'token');assert(db.snapshot('googleDeletions/q').exists);
});
test('requisição temporariamente indisponível é repetida com limite',async()=>{
 let calls=0;mockFetch(async()=>++calls<3?response({error:{message:'unavailable'}},503):response({ok:true}));
 const result=await api.calendarFetch('token','https://example.test/events');assert.equal(result.ok,true);assert.equal(calls,3);
});
test('recibo de exclusão confirmada impede recriação e não repete DELETE',async()=>{
 const id=api.importedVisitId('c1','e1');const db=new MemoryDB({['googleDeletions/'+id]:{sourceId:'e1',calendarId:'c1',completedAt:'confirmed'}});let calls=0;mockFetch(async()=>{calls++;return new Response(null,{status:204})});const deleted=await api.processDeletions(db,'token');await api.importGoogleEventsIntoVisits(db,[event()],deleted);assert.equal(calls,0);assert.equal((await db.collection('visits').get()).size,0);
});
test('importação reaproveita documento legado sem renumerar registros',async()=>{
 const db=new MemoryDB({'visits/legacy1':{sourceId:'e1',imovel:'Título antigo',cliente:'Cliente preservado',obs:'Nota manual'}});await api.importGoogleEventsIntoVisits(db,[event()]);const snap=await db.collection('visits').get();assert.equal(snap.size,1);assert.equal(snap.docs[0].id,'legacy1');assert.equal(snap.docs[0].data().cliente,'Cliente preservado');assert.equal(snap.docs[0].data().calendarId,'c1');
});
test('mudança após snapshot da importação não é sobrescrita',async()=>{
 const db=new MemoryDB({'visits/v1':{sourceId:'e1',calendarId:'c1',imovel:'Antes'}});const original=db.runTransaction.bind(db);db.runTransaction=async fn=>{await db.ref('visits/v1').update({imovel:'Edição concorrente',pendingGoogleSync:true});return original(fn)};await api.importGoogleEventsIntoVisits(db,[event()]);assert.equal(db.snapshot('visits/v1').data().imovel,'Edição concorrente');
});

test('token de outra conta é rejeitado antes de qualquer escrita',async()=>{
 mockFetch(async()=>response({items:[{id:'wrong-account',primary:true}]}));
 await assert.rejects(api.fetchCalendarIds('token'),/conta do token Google/);
});
test('exclusão confirmada mantém recibo e não apaga pedido de proteção',async()=>{
 const db=new MemoryDB({'googleDeletions/q':{sourceId:'e1',calendarId:'c1'}});mockFetch(async()=>new Response(null,{status:204}));
 const result=await api.processDeletions(db,'token');assert.equal(result.excluidos,1);assert(db.snapshot('googleDeletions/q').data().completedAt);assert(result.pendentesIds.has(api.eventKey('c1','e1')));
});

test('cancelamento confirmado no Google marca exclusão sem apagar cliente e notas',async()=>{
 const db=new MemoryDB({'visits/v1':{sourceId:'e1',calendarId:'c1',status:'Realizada',cliente:'Cliente',obs:'Histórico preservado'}});mockFetch(async()=>response({id:'e1',status:'cancelled'}));const result=await api.reconcileGoogleDeletions(db,'token',new Map());const v=db.snapshot('visits/v1').data();assert.equal(result.marked,1);assert.equal(v.googleCalendarState,'deleted');assert.equal(v.status,'Atendimento finalizado');assert.equal(v.statusAntesDaExclusao,'Realizada');assert.equal(v.obs,'Histórico preservado');assert.equal(v.cliente,'Cliente');
});
test('404 marca evento indisponível, sem afirmar exclusão',async()=>{
 const db=new MemoryDB({'visits/v1':{sourceId:'e1',calendarId:'c1',imovel:'Visita'}});mockFetch(async()=>response({error:{message:'not found'}},404));await api.reconcileGoogleDeletions(db,'token',new Map());assert.equal(db.snapshot('visits/v1').data().googleCalendarState,'unavailable');assert.equal(db.snapshot('visits/v1').data().googleDeletedAt,undefined);
});
test('403 e falha de conexão não marcam exclusão',async()=>{
 const db=new MemoryDB({'visits/v1':{sourceId:'e1',calendarId:'c1',imovel:'Visita'}});mockFetch(async()=>response({error:{message:'forbidden'}},403));const result=await api.reconcileGoogleDeletions(db,'token',new Map());assert.equal(result.failed,1);assert.equal(db.snapshot('visits/v1').data().googleCalendarState,undefined);
});
test('evento restaurado no Google remove etiqueta sem alterar status comercial',async()=>{
 const db=new MemoryDB({'visits/v1':{sourceId:'e1',calendarId:'c1',googleCalendarState:'deleted',status:'Interessado',obs:'Nota'}});await api.reconcileGoogleDeletions(db,'token',new Map([[api.eventKey('c1','e1'),event()]]));const v=db.snapshot('visits/v1').data();assert.equal(v.googleCalendarState,'active');assert.equal(v.status,'Interessado');assert.equal(v.obs,'Nota');
});
test('evento fora da janela mas existente não é marcado como excluído',async()=>{
 const db=new MemoryDB({'visits/v1':{sourceId:'e1',calendarId:'c1',data:'2040-01-01'}});mockFetch(async()=>response({id:'e1',status:'confirmed',start:{date:'2040-01-01'}}));await api.reconcileGoogleDeletions(db,'token',new Map());assert.equal(db.snapshot('visits/v1').data().googleCalendarState,undefined);
});
test('edição pendente de evento excluído não recria compromisso',async()=>{
 const db=new MemoryDB({'visits/v1':{sourceId:'e1',calendarId:'c1',googleCalendarState:'deleted',pendingGoogleSync:true,obs:'Edição local'}});let calls=0;mockFetch(async()=>{calls++;return response({})});await api.pushPendingVisits(db,'token',new Map());assert.equal(calls,0);assert.equal(db.snapshot('visits/v1').data().pendingGoogleSync,false);assert.equal(db.snapshot('visits/v1').data().status,'Atendimento finalizado');assert.equal(db.snapshot('visits/v1').data().obs,'Edição local');
});
test('404 posterior não desfaz exclusão já confirmada',async()=>{
 const db=new MemoryDB({'visits/v1':{sourceId:'e1',calendarId:'c1',googleCalendarState:'deleted'}});mockFetch(async()=>response({error:{message:'not found'}},404));await api.reconcileGoogleDeletions(db,'token',new Map());assert.equal(db.snapshot('visits/v1').data().googleCalendarState,'deleted');
});

test('horário inicia conclusão no instante certo sem afetar dia inteiro, exclusão ou edição pendente',()=>{
 const check=api.visitaAtingiuHorario;
 const v={sourceId:'event',status:'Agendada',data:'2026-11-11',googleStartDate:'2026-11-11',googleStartAt:'2026-11-11T12:00:00-03:00'};
 const start=Date.parse(v.googleStartAt);
 assert.equal(check(v,start-1),false);assert.equal(check(v,start),true);assert.equal(check(v,start+60000),true);
 for(const patch of [{googleStartAt:null},{googleCalendarState:'deleted'},{googleCalendarState:'unavailable'},{pendingGoogleSync:true},{data:'2026-11-12'},{status:'Realizada'},{foraDoFunil:true}])assert.equal(check({...v,...patch},start),false);
 assert.equal(check(v,start+86400000),false);
});

test('importação persiste horário e conclusão automática é idempotente',async()=>{
 const db=new MemoryDB();const ev={...event(),data:'2026-11-11',raw:{start:{dateTime:'2026-11-11T12:00:00-03:00'}}};
 await api.importGoogleEventsIntoVisits(db,[ev]);const snap=await db.collection('visits').get();const ref=snap.docs[0].ref;
 assert.equal(snap.docs[0].data().googleStartAt,ev.raw.start.dateTime);
 await ref.update({status:'Agendada'});const time=Date.parse(ev.raw.start.dateTime);
 assert.equal(await api.concluirVisitasPorHorario(db,time),1);assert.equal(await api.concluirVisitasPorHorario(db,time),0);assert.equal((await ref.get()).data().status,'Realizada');
});

test('edição posterior à exclusão permanece local e limpa fila sem perder a observação',async()=>{
 const db=new MemoryDB({'visits/v1':{sourceId:'e1',calendarId:'c1',status:'Atendimento finalizado',finalizadaPorExclusao:true,googleCalendarState:'deleted',pendingGoogleSync:true,googleSyncError:'antigo',obs:'Nota nova'}});let calls=0;mockFetch(async()=>{calls++;return response({})});await api.pushPendingVisits(db,'token',new Map());const v=db.snapshot('visits/v1').data();assert.equal(calls,0);assert.equal(v.pendingGoogleSync,false);assert.equal(v.googleSyncError,null);assert.equal(v.obs,'Nota nova');
});

test('ciclo sem mudança não abre transações para cada visita já importada',async()=>{
 const db=new MemoryDB();await api.importGoogleEventsIntoVisits(db,[event()]);let calls=0;const previous=db.runTransaction.bind(db);db.runTransaction=fn=>{calls++;return previous(fn)};
 const result=await api.importGoogleEventsIntoVisits(db,[event()]);assert.equal(calls,0);assert.equal(result.updated,0);
});

test('ciclo de fila lê só pedidos de exclusão recentes e conta os restantes sem reler',async()=>{
 const db=new MemoryDB({'googleDeletions/velho':{sourceId:'e0',calendarId:'c1',requestedAt:1000,completedAt:'x'},'googleDeletions/novo':{sourceId:'e1',calendarId:'c1',requestedAt:5000},'googleDeletions/falho':{sourceId:'e2',calendarId:'c1',requestedAt:6000}});
 mockFetch(async url=>url.includes('/e2')?response({},500):new Response(null,{status:204}));
 const r=await api.processDeletions(db,'token',{desde:4000});
 assert.equal(r.excluidos,1);assert.equal(r.restantes,1);assert.equal(r.pendentesIds.size,2);
 assert.ok(db.snapshot('googleDeletions/novo').data().completedAt);assert.equal(db.snapshot('googleDeletions/velho').data().completedAt,'x');
 assert.deepEqual(db.consultas,['googleDeletions:requestedAt>=4000']);
});
test('conclusão por horário consulta só as agendadas de hoje',async()=>{
 const now=Date.parse('2026-11-12T15:00:00Z');
 const db=new MemoryDB({'visits/hoje':{status:'Agendada',sourceId:'e1',data:'2026-11-12',googleStartDate:'2026-11-12',googleStartAt:'2026-11-12T10:00:00-03:00'},'visits/amanha':{status:'Agendada',sourceId:'e2',data:'2026-11-13',googleStartDate:'2026-11-13',googleStartAt:'2026-11-13T10:00:00-03:00'}});
 assert.equal(await api.concluirVisitasPorHorario(db,now),1);
 assert.equal(db.snapshot('visits/hoje').data().status,'Realizada');assert.equal(db.snapshot('visits/amanha').data().status,'Agendada');
 assert.deepEqual(db.consultas,['visits:status==Agendada&data==2026-11-12']);
});
test('pedido de exclusão com visita que não é dona do evento é recusado sem DELETE e não bloqueia reimportação',async()=>{
 const db=new MemoryDB({'visits/v1':{sourceId:'outro',calendarId:'c1',imovel:'A'},'googleDeletions/q':{sourceId:'e1',calendarId:'c1',requestedAt:1,visitId:'v1'}});
 let calls=0;mockFetch(async()=>{calls++;return new Response(null,{status:204})});
 const r=await api.processDeletions(db,'token');
 assert.equal(calls,0);assert.equal(r.recusados,1);assert.equal(r.excluidos,0);assert.equal(r.restantes,0);
 const q=db.snapshot('googleDeletions/q').data();assert.ok(q.completedAt);assert.ok(q.recusadoEm);
 const r2=await api.processDeletions(db,'token');assert.equal(r2.pendentesIds.size,0);
});
test('pedido de exclusão confere: evento importado da visita e evento criado pelo CRM são apagados',async()=>{
 const criado=api.createdEventId('v2');
 const db=new MemoryDB({'visits/v1':{sourceId:'e1',calendarId:'c1'},'visits/v2':{pendingGoogleSync:false},
  'googleDeletions/a':{sourceId:'e1',calendarId:'c1',requestedAt:1,visitId:'v1'},'googleDeletions/b':{sourceId:criado,calendarId:'primary',requestedAt:1,visitId:'v2'},
  'googleDeletions/c':{sourceId:'e9',calendarId:'c1',requestedAt:1}});
 const urls=[];mockFetch(async url=>{urls.push(url);return new Response(null,{status:204})});
 const r=await api.processDeletions(db,'token');
 assert.equal(r.excluidos,3);assert.equal(r.recusados,0);assert.equal(urls.length,3);
 assert.equal(db.snapshot('visits/v1').data().googleCalendarState,'deleted');
});
test('orçamento esgotado no meio da fila para sem apagar o resto e mantém os pedidos pendentes',async()=>{
 const db=new MemoryDB({'googleDeletions/a':{sourceId:'e1',calendarId:'c1',requestedAt:1},'googleDeletions/b':{sourceId:'e2',calendarId:'c1',requestedAt:2}});
 let calls=0;mockFetch(async()=>{calls++;return new Response(null,{status:204})});
 let n=0;const r=await api.processDeletions(db,'token',{parar:()=>n++>=1});
 assert.equal(r.interrompido,true);assert.equal(calls,1);assert.equal(r.excluidos,1);assert.equal(r.restantes,1);
 assert.equal(r.pendentesIds.size,2);
});
test('orçamento esgotado no envio protege as pendências da importação',async()=>{
 const db=new MemoryDB({'visits/v1':{sourceId:'e1',calendarId:'c1',pendingGoogleSync:true,imovel:'Editado'}});
 let calls=0;mockFetch(async()=>{calls++;return response({})});
 const r=await api.pushPendingVisits(db,'token',new Map(),{parar:()=>true});
 assert.equal(r.interrompido,true);assert.equal(calls,0);assert.ok(r.protegidos.has(api.eventKey('c1','e1')));
 assert.equal(db.snapshot('visits/v1').data().pendingGoogleSync,true);
});
test('excluir no Google o compromisso de venda mantém o status e só etiqueta',async()=>{
 const db=new MemoryDB({'visits/v1':{sourceId:'e1',calendarId:'c1',status:'Vendido',cliente:'C'},'visits/v2':{sourceId:'e2',calendarId:'c1',status:'Realizada'}});
 mockFetch(async()=>response({status:'cancelled'}));
 await api.reconcileGoogleDeletions(db,'token',new Map());
 const v1=db.snapshot('visits/v1').data(),v2=db.snapshot('visits/v2').data();
 assert.equal(v1.status,'Vendido');assert.equal(v1.exclusaoPreservouStatus,true);assert.equal(v1.googleCalendarState,'deleted');assert.equal(v1.finalizadaPorExclusao,undefined);
 assert.equal(v2.status,'Atendimento finalizado');
 // Ciclo seguinte: já regularizada e fora da lista, não consulta o Google.
 let calls=0;mockFetch(async()=>{calls++;return response({status:'cancelled'})});
 await api.reconcileGoogleDeletions(db,'token',new Map());assert.equal(calls,0);
});
test('envio manda só o que mudou no CRM e não desfaz reagendamento feito no Google',async()=>{
 const raw={id:'e1',start:{date:'2026-11-20'},end:{date:'2026-11-21'},description:''};
 const db=new MemoryDB({'visits/v1':{sourceId:'e1',calendarId:'c1',imovel:'Visita Casa',data:'2026-11-15',bairro:'Centro',status:'Proposta enviada',
  googleTitulo:'Visita Casa',googleData:'2026-11-15',googleLocal:'Centro',pendingGoogleSync:true}});
 let enviado=null;mockFetch(async(url,o)=>{if(o?.method==='PATCH')enviado=JSON.parse(o.body);return response({})});
 await api.pushPendingVisits(db,'token',new Map([[api.eventKey('c1','e1'),{id:'e1',calendarId:'c1',raw}]]));
 assert.ok(enviado.description);assert.equal(enviado.summary,undefined);assert.equal(enviado.start,undefined);assert.equal(enviado.location,undefined);
 assert.equal(db.snapshot('visits/v1').data().pendingGoogleSync,false);
});
test('data alterada no CRM é enviada e vira a nova referência',async()=>{
 const raw={id:'e1',start:{date:'2026-11-15'},end:{date:'2026-11-16'},description:''};
 const db=new MemoryDB({'visits/v1':{sourceId:'e1',calendarId:'c1',imovel:'Visita Casa',data:'2026-11-18',status:'Agendada',googleTitulo:'Visita Casa',googleData:'2026-11-15',googleLocal:'',pendingGoogleSync:true}});
 let enviado=null;mockFetch(async(url,o)=>{if(o?.method==='PATCH')enviado=JSON.parse(o.body);return response({})});
 await api.pushPendingVisits(db,'token',new Map([[api.eventKey('c1','e1'),{id:'e1',calendarId:'c1',raw}]]));
 assert.equal(enviado.start.date,'2026-11-18');assert.equal(db.snapshot('visits/v1').data().googleData,'2026-11-18');
});
test('visita concluída pelo horário e reagendada para o futuro volta para Agendada',()=>{
 const now=Date.parse('2026-11-12T14:00:00Z');
 const v={status:'Realizada',realizadaPorHorario:true,data:'2026-11-12',googleStartAt:'2026-11-12T10:00:00-03:00',googleStartDate:'2026-11-12',imovel:'Visita X'};
 const ev={data:'2026-11-14',titulo:'Visita X',local:'',descricao:'',calendarId:'c1',raw:{start:{dateTime:'2026-11-14T10:00:00-03:00'}}};
 const p=api.patchDaAgenda(v,ev,'2026-11-12',now);assert.equal(p.status,'Agendada');assert.equal(p.realizadaPorHorario,false);
 const manual=api.patchDaAgenda({...v,realizadaPorHorario:false},ev,'2026-11-12',now);assert.equal(manual.status,undefined);
});
test('compromisso fora do funil vai ao Google sem o prefixo de visita',()=>{
 assert.equal(api.tituloParaGoogle('Reunião com advogado',true),'Reunião com advogado');
 assert.equal(api.tituloParaGoogle('Casa Jaó',false),'Visita - Casa Jaó');
});
test('pedido concluído sem calendarId não conta como falha',async()=>{
 const db=new MemoryDB({'googleDeletions/x':{sourceId:'e1',completedAt:'ok'}});mockFetch(async()=>{throw Error('não deveria chamar')});
 const r=await api.processDeletions(db,'token');assert.equal(r.falhas,0);
});
test('visita criada no CRM com horário nasce no Google com hora marcada e 1 h de duração',async()=>{
 const db=new MemoryDB({'visits/v1':{imovel:'Casa Jaó',data:'2026-11-20',hora:'15:30',pendingGoogleSync:true}});let posted;
 mockFetch(async(url,o)=>{if(o?.method==='POST')posted=JSON.parse(o.body);return response({})});
 const r=await api.pushPendingVisits(db,'token',new Map());assert.equal(r.criados,1);
 assert.deepEqual(posted.start,{dateTime:'2026-11-20T15:30:00-03:00',timeZone:'America/Sao_Paulo'});
 assert.equal(posted.end.dateTime,'2026-11-20T16:30:00-03:00');
 const v=db.snapshot('visits/v1').data();assert.equal(v.googleHora,'15:30');assert.equal(v.googleStartAt,'2026-11-20T15:30:00-03:00');assert.equal(v.googleStartDate,'2026-11-20');assert.equal(v.pendingGoogleSync,false);
});
test('visita criada no CRM sem horário continua nascendo como dia inteiro',async()=>{
 const db=new MemoryDB({'visits/v1':{imovel:'Casa',data:'2026-11-20',hora:'',pendingGoogleSync:true}});let posted;
 mockFetch(async(url,o)=>{if(o?.method==='POST')posted=JSON.parse(o.body);return response({})});
 await api.pushPendingVisits(db,'token',new Map());assert.deepEqual(posted.start,{date:'2026-11-20'});assert.equal(db.snapshot('visits/v1').data().googleStartAt,undefined);
});
test('horário alterado no CRM vai ao Google preservando a duração; dia inteiro vira horário',async()=>{
 const envia=async(visita,raw)=>{const db=new MemoryDB({'visits/v1':{sourceId:'e1',calendarId:'c1',imovel:'Visita Casa',googleTitulo:'Visita Casa',googleLocal:'',pendingGoogleSync:true,...visita}});
  let enviado=null;mockFetch(async(url,o)=>{if(o?.method==='PATCH')enviado=JSON.parse(o.body);return response({})});
  await api.pushPendingVisits(db,'token',new Map([[api.eventKey('c1','e1'),{id:'e1',calendarId:'c1',raw}]]));return {enviado,v:db.snapshot('visits/v1').data()}};
 // Evento de 2 h: muda só a hora, a duração é mantida.
 let x=await envia({data:'2026-11-20',googleData:'2026-11-20',hora:'09:00',googleHora:'14:00'},{id:'e1',start:{dateTime:'2026-11-20T14:00:00-03:00'},end:{dateTime:'2026-11-20T16:00:00-03:00'}});
 assert.equal(x.enviado.start.dateTime,'2026-11-20T09:00:00-03:00');assert.equal(x.enviado.end.dateTime,'2026-11-20T11:00:00-03:00');assert.equal(x.v.googleHora,'09:00');assert.equal(x.v.googleStartAt,'2026-11-20T09:00:00-03:00');
 // Dia inteiro ganha horário: precisa zerar `date`.
 x=await envia({data:'2026-11-20',googleData:'2026-11-20',hora:'10:15',googleHora:''},{id:'e1',start:{date:'2026-11-20'},end:{date:'2026-11-21'}});
 assert.equal(x.enviado.start.dateTime,'2026-11-20T10:15:00-03:00');assert.equal(x.enviado.start.date,null);assert.equal(x.enviado.end.dateTime,'2026-11-20T11:15:00-03:00');
 // Data e hora mudam juntas.
 x=await envia({data:'2026-11-22',googleData:'2026-11-20',hora:'08:00',googleHora:'14:00'},{id:'e1',start:{dateTime:'2026-11-20T14:00:00-03:00'},end:{dateTime:'2026-11-20T15:00:00-03:00'}});
 assert.equal(x.enviado.start.dateTime,'2026-11-22T08:00:00-03:00');assert.equal(x.v.googleData,'2026-11-22');assert.equal(x.v.googleStartDate,'2026-11-22');
});
test('horário igual ao da agenda ou vazio no CRM não mexe no horário do Google',async()=>{
 const raw={id:'e1',start:{dateTime:'2026-11-20T17:00:00Z'},end:{dateTime:'2026-11-20T18:00:00Z'}};
 for(const visita of [{hora:'14:00',googleHora:'14:00'},{hora:'14:00'},{hora:'',googleHora:'14:00'},{},{hora:'13:00',googleHora:'13:00'}]){
  const db=new MemoryDB({'visits/v1':{sourceId:'e1',calendarId:'c1',imovel:'Visita Casa',data:'2026-11-20',googleTitulo:'Visita Casa',googleData:'2026-11-20',googleLocal:'',pendingGoogleSync:true,...visita}});
  let enviado=null;mockFetch(async(url,o)=>{if(o?.method==='PATCH')enviado=JSON.parse(o.body);return response({})});
  await api.pushPendingVisits(db,'token',new Map([[api.eventKey('c1','e1'),{id:'e1',calendarId:'c1',raw}]]));
  assert.equal(enviado.start,undefined,JSON.stringify(visita));
 }
});
test('importação traz o horário do Google para o campo do formulário',async()=>{
 const ev={id:'e9',calendarId:'c1',titulo:'Visita Apto',data:'2026-11-20',local:'',descricao:'',raw:{start:{dateTime:'2026-11-20T14:30:00-03:00'},end:{dateTime:'2026-11-20T15:30:00-03:00'}}};
 const db=new MemoryDB();await api.importGoogleEventsIntoVisits(db,[ev]);
 const key='visits/'+api.importedVisitId('c1','e9');let v=db.snapshot(key).data();assert.equal(v.hora,'14:30');assert.equal(v.googleHora,'14:30');
 // Reagendado no Google para outro horário: o campo acompanha.
 ev.raw.start.dateTime='2026-11-20T09:00:00-03:00';await api.importGoogleEventsIntoVisits(db,[ev]);
 v=db.snapshot(key).data();assert.equal(v.hora,'09:00');assert.equal(v.googleHora,'09:00');
 assert.equal(api.horaDoEvento({start:{date:'2026-11-20'}}),'');
});

/* Leitura rápida: mudanças da Agenda nos disparos de 5 min. */
const AGORA=Date.parse('2026-11-13T12:00:00Z');
function agendaFalsa(items,vistos=[]){mockFetch(async url=>{const u=new URL(url);if(u.pathname.endsWith('/calendarList'))return response({items:[{id:'c1',primary:true}]});vistos.push(u.searchParams.get('updatedMin'));return response({items})})}
function contarLeiturasInteiras(db){const cont={n:0};const orig=db.collection.bind(db);db.collection=name=>{const c=orig(name);const g=c.get;c.get=()=>{cont.n++;return g()};return c};return cont}
const bruto=(id,extra={})=>({id,summary:'Visita Jardins',location:'Centro',start:{dateTime:'2026-11-20T09:00:00-03:00'},end:{dateTime:'2026-11-20T10:00:00-03:00'},updated:'2026-11-13T12:03:00Z',...extra});
test('leitura rápida pede ao Google só o que mudou desde o último completo (com margem)',async()=>{
 const vistos=[];agendaFalsa([],vistos);const db=new MemoryDB();
 const r=await api.lerMudancasDaAgenda(db,'token',AGORA);
 assert.deepEqual(vistos,['2026-11-13T11:58:00.000Z']);assert.equal(r.eventos,0);assert.equal(r.imported,0);
});
test('leitura rápida sem mudança na Agenda não lê nada no Firestore',async()=>{
 agendaFalsa([]);const db=new MemoryDB({'visits/v1':{sourceId:'x',calendarId:'c1',imovel:'Visita'}});const cont=contarLeiturasInteiras(db);
 await api.lerMudancasDaAgenda(db,'token',AGORA);assert.equal(cont.n,0);assert.deepEqual(db.consultas,[]);
});
test('leitura rápida importa visita nova sem reler a coleção inteira',async()=>{
 agendaFalsa([bruto('novo1')]);const db=new MemoryDB({'visits/v1':{sourceId:'outro',calendarId:'c1',imovel:'Visita antiga'}});const cont=contarLeiturasInteiras(db);
 const r=await api.lerMudancasDaAgenda(db,'token',AGORA);
 assert.equal(r.imported,1);assert.equal(cont.n,0);assert.equal(db.consultas.length,1);assert.match(db.consultas[0],/^visits:sourceIdin/);
 const nova=db.snapshot('visits/'+api.importedVisitId('c1','novo1')).data();assert.equal(nova.imovel,'Visita Jardins');assert.equal(nova.data,'2026-11-20');assert.equal(nova.hora,'09:00');assert.equal(nova.status,'Agendada');
});
test('leitura rápida atualiza horário de visita existente e preserva os dados do CRM',async()=>{
 agendaFalsa([bruto('e1',{start:{dateTime:'2026-11-21T15:30:00-03:00'},end:{dateTime:'2026-11-21T16:30:00-03:00'}})]);
 const db=new MemoryDB({'visits/v1':{sourceId:'e1',calendarId:'c1',imovel:'Visita Jardins',bairro:'Centro',data:'2026-11-20',hora:'09:00',cliente:'Maria',status:'Agendada'}});
 const r=await api.lerMudancasDaAgenda(db,'token',AGORA);const v=db.snapshot('visits/v1').data();
 assert.equal(r.updated,1);assert.equal(v.data,'2026-11-21');assert.equal(v.hora,'15:30');assert.equal(v.cliente,'Maria');assert.equal((await db.collection('visits').get()).size,1);
});
test('leitura rápida não sobrescreve edição local pendente de envio',async()=>{
 agendaFalsa([bruto('e1',{summary:'Visita mudada no Google'})]);
 const db=new MemoryDB({'visits/v1':{sourceId:'e1',calendarId:'c1',imovel:'Visita editada no CRM',data:'2026-11-20',pendingGoogleSync:true}});
 const r=await api.lerMudancasDaAgenda(db,'token',AGORA);assert.equal(r.updated,0);assert.equal(db.snapshot('visits/v1').data().imovel,'Visita editada no CRM');
});
test('leitura rápida ignora evento cancelado, evento que não é visita e pedido de exclusão',async()=>{
 agendaFalsa([{id:'apagado',status:'cancelled'},bruto('reuniao',{summary:'Reunião'}),bruto('excluir1')]);
 const db=new MemoryDB({['googleDeletions/'+api.importedVisitId('c1','excluir1')]:{sourceId:'excluir1',calendarId:'c1'}});
 const r=await api.lerMudancasDaAgenda(db,'token',AGORA,{pendentesIds:new Set([api.eventKey('c1','excluir1')])});
 assert.equal(r.imported,0);assert.equal((await db.collection('visits').get()).size,0);
});
test('leitura rápida reaproveita a agenda já lida no disparo e filtra pela data de alteração',async()=>{
 let chamadas=0;mockFetch(async()=>{chamadas++;return response({})});const db=new MemoryDB();
 const ev=(id,updated)=>({id,calendarId:'c1',titulo:'Visita '+id,data:'2026-11-20',local:'',descricao:'',raw:{start:{date:'2026-11-20'},end:{date:'2026-11-21'},updated}});
 const r=await api.lerMudancasDaAgenda(db,'token',AGORA,{eventosDaAgenda:[ev('velho','2026-11-13T11:00:00Z'),ev('novo','2026-11-13T12:01:00Z')]});
 assert.equal(chamadas,0);assert.equal(r.eventos,1);assert.equal(r.imported,1);assert.equal(db.snapshot('visits/'+api.importedVisitId('c1','novo')).exists,true);assert.equal(db.snapshot('visits/'+api.importedVisitId('c1','velho')).exists,false);
});
