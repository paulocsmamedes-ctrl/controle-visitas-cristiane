'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
process.env.GOOGLE_CALENDAR_OWNER='c1';
const api=require('../sync.js');
function clone(v){return structuredClone(v)}
class MemoryDB {
 constructor(initial={}){this.rows=new Map();this.version=0;this.tail=Promise.resolve();for(const [key,data] of Object.entries(initial))this.put(key,data)}
 put(key,data){this.rows.set(key,{data:clone(data),version:++this.version})}
 ref(key){return {key,id:key.split('/').at(-1),get:async()=>this.snapshot(key),update:async patch=>{if(!this.rows.has(key))throw Error('missing');this.put(key,{...this.rows.get(key).data,...patch})},delete:async()=>this.rows.delete(key)}}
 snapshot(key){const row=this.rows.get(key);return {id:key.split('/').at(-1),ref:this.ref(key),exists:!!row,data:()=>row?clone(row.data):undefined,updateTime:row?{version:row.version,isEqual(other){return this.version===other?.version}}:undefined}}
 collection(name){const get=async filter=>{const docs=[...this.rows.keys()].filter(k=>k.startsWith(name+'/')).map(k=>this.snapshot(k)).filter(d=>!filter||filter(d.data()));return {docs,size:docs.length}};return {doc:id=>this.ref(name+'/'+id),get:()=>get(),where:(field,op,value)=>({get:()=>get(d=>d[field]===value)})}}
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
 const db=new MemoryDB({'visits/v1':{sourceId:'e1',calendarId:'c1',status:'Realizada',cliente:'Cliente',obs:'Histórico preservado'}});mockFetch(async()=>response({id:'e1',status:'cancelled'}));const result=await api.reconcileGoogleDeletions(db,'token',new Map());const v=db.snapshot('visits/v1').data();assert.equal(result.marked,1);assert.equal(v.googleCalendarState,'deleted');assert.equal(v.status,'Realizada');assert.equal(v.obs,'Histórico preservado');assert.equal(v.cliente,'Cliente');
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
 const db=new MemoryDB({'visits/v1':{sourceId:'e1',calendarId:'c1',googleCalendarState:'deleted',pendingGoogleSync:true,obs:'Edição local'}});let calls=0;mockFetch(async()=>{calls++;return response({})});await api.pushPendingVisits(db,'token',new Map());assert.equal(calls,0);assert.equal(db.snapshot('visits/v1').data().pendingGoogleSync,true);assert.equal(db.snapshot('visits/v1').data().obs,'Edição local');
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
