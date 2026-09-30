import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, importConversation, importExports, updateApplicant, createProperty, createManualApplicant,
  closePeriod, createPeriod, deleteProperty, purgeProperty, updateProperty } from '../app/database.mjs';
import { createServer } from '../app/server.mjs';
import { countNewIncomingMessages } from '../app/sync-attention.mjs';

test('incoming comparator ignores export/profile/outgoing noise and bridges legacy dates', () => {
  const old={exportedAt:'2026-09-24T10:23:00.000Z',messages:[
    {direction:'received',author:'Persona',time:'10:20',dateLabel:'HOY',text:'Hola',rawText:'10:20 Hola'},
    {direction:'sent',author:'Propietario',time:'10:21',text:'Respuesta'}]};
  const fresh={exportedAt:'2026-09-24T11:00:00.000Z',profile:{text:'Datos nuevos'},
    messages:[{direction:'received',author:'Nombre corregido',time:'10.20',dateLabel:'AYER',
      messageDate:'2026-09-24',occurredAt:'2026-09-24T08:20:00.000Z',text:'Hola',
      rawText:'Ayer 10.20 Hola',embeddedProfile:{text:'Perfil actualizado'}},
    {direction:'sent',author:'Propietario',time:'10:22',text:'Otra respuesta'}]};
  assert.equal(countNewIncomingMessages(old,fresh),0);
  assert.equal(countNewIncomingMessages({messages:[{direction:'received',author:'Persona',
    time:'10:20',text:'Hola',media:[{tag:'IMG',alt:'Foto anterior'}]}]},
  {messages:[{direction:'received',author:'Persona',time:'10:20',text:'Hola',
    media:[{tag:'IMG',alt:'Foto nueva'}]}]}),0);
  const profileOnly={direction:'received',author:'Persona',time:'10:24',text:null,
    embeddedProfile:{text:'Ficha'},rawText:'Ficha antigua',media:[{tag:'IMG',alt:'Avatar anterior'}]};
  assert.equal(countNewIncomingMessages({referenceAt:'2026-09-24T08:24:45.000Z',
    messages:[profileOnly]},{messages:[{...profileOnly,rawText:'Ficha actualizada',
      embeddedProfile:{text:'Ficha actualizada'},media:[{tag:'IMG',alt:'Avatar nuevo'}],messageDate:'2026-09-24',
      occurredAt:'2026-09-24T08:24:00.000Z'}]}),0);
});

test('incoming comparator counts repeated bodies one-to-one and fully dated new messages', () => {
  const message=(day,instant)=>({direction:'received',author:'Persona',time:'10:20',
    messageDate:day,occurredAt:instant,text:'Mismo texto'});
  const old={exportedAt:'2026-09-24T08:30:00.000Z',messages:[
    message('2026-09-24','2026-09-24T08:20:00.000Z')]};
  const fresh={messages:[...old.messages,
    message('2026-09-24','2026-09-24T09:20:00.000Z')]};
  assert.equal(countNewIncomingMessages(old,fresh),1);
  assert.equal(countNewIncomingMessages(old,{messages:[{...old.messages[0],time:'10:20 h'}]}),0);
  assert.equal(countNewIncomingMessages(old,{messages:[...old.messages,{...old.messages[0]}]}),0,
    'an identical message before the previous snapshot is historical backfill');
  const legacy={...old,messages:[{direction:'received',author:'Persona',time:'10:20',text:'Mismo texto'}]};
  assert.equal(countNewIncomingMessages(legacy,{messages:[...fresh.messages]}),1);
});

test('incoming comparator uses complete minute and prior reference instant for backfill', () => {
  const fresh={messages:[{direction:'received',author:'Persona',time:'10:24',
    messageDate:'2026-09-24',occurredAt:'2026-09-24T08:24:00.000Z',text:'Nuevo'}]};
  assert.equal(countNewIncomingMessages({referenceAt:'2026-09-24T08:24:45.000Z',
    exportedAt:'2026-09-24T08:26:00.000Z',messages:[]},fresh),1);
  assert.equal(countNewIncomingMessages({referenceAt:'2026-09-24T08:25:00.000Z',messages:[]},fresh),0);
  const old={referenceAt:'2026-09-24T08:20:30.000Z',messages:[{
    direction:'received',author:'Persona',time:'10:20',text:'Mismo'}]};
  const duplicated={messages:[1,2].map(sequence=>({sequence,direction:'received',
    author:'Persona',time:'10:20',text:'Mismo',messageDate:'2026-09-24',
    occurredAt:'2026-09-24T08:20:00.000Z'}))};
  assert.equal(countNewIncomingMessages(old,duplicated),1);
});

const date = '2026-09-24';
const initialDate = '2026-09-23';
function fixture(id, overrides = {}) {
  const data = { id: String(id), name: 'Nombre compartido', listedDate: '10:30',
    exportedAt: '2026-09-23T12:00:00.000Z', properties: [{url:'https://www.idealista.com/inmueble/13579135/'}],
    profile: { text: 'Perfil', fields: [] }, integrity: { profile: 'completo', history: 'completo' },
    messages: [{ sequence: 1, author: 'Nombre', rawText: 'Original', text: 'Original' }], ...overrides };
  data.messages = data.messages.map(m=>({messageDate:initialDate,
    occurredAt:'2026-09-23T08:00:00.000Z',...m}));
  return data;
}

function fakeWorker() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { child.stdout.end(); child.stderr.end(); queueMicrotask(() => child.emit('close', null, 'SIGTERM')); };
  child.send = event => child.stdout.write(JSON.stringify(event) + '\n');
  child.finish = (code = 0) => {
    child.stdout.end(); child.stderr.end();
    queueMicrotask(() => child.emit('close', code, null));
  };
  return child;
}

const scanFields=(requestedMode,effectiveMode,examined,candidates,earlyStopped=false)=>({
  requestedMode,effectiveMode,examined,candidates,earlyStopped,
  stopReason:earlyStopped?'unchanged_streak':null,unchangedStreak:earlyStopped?5:0,
  unchangedThreshold:5,fullCoverage:!earlyStopped,headRechecked:earlyStopped,
});

async function setup(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'idealista-sync-'));
  const exportsRoot = path.join(root, 'exports');
  mkdirSync(path.join(exportsRoot, date, 'property-13579135'), { recursive: true });
  const db = openDatabase(path.join(root, 'app.sqlite'));
  const children = [];
  const known = [];
  const contexts = [];
  const server = createServer(db, { exportsRoot, today: () => date, spawnWorker(ids, sinceDate, untilDate, propertyId, context) {
    known.push({ ids, sinceDate, untilDate, propertyId });
    contexts.push(context);
    const child = fakeWorker();
    children.push(child);
    return child;
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const api = async (method = 'GET', pathname = '/api/sync', options = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
      method, ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}),
      ...options });
    return { status: response.status, body: await response.json() };
  };
  const write = (data, exportDay = date, idealistaId = '13579135', periodId) => {
    const dir=path.join(exportsRoot, exportDay, `property-${idealistaId}`,
      ...(periodId ? [`period-${encodeURIComponent(periodId)}`] : []));
    mkdirSync(dir, { recursive: true });
    const source = path.join(dir, `${data.id}.json`);
    writeFileSync(source, JSON.stringify(data));
    return source;
  };
  const result = (files, overrides = {}) => ({ type: 'result', date, sinceDate: initialDate,
    untilDate: date, propertyId: '13579135', files,
    discovered: files.length, candidates: files.length, exported: files.length, ...overrides });
  const settled = async () => {
    for (let i = 0; i < 100; i++) {
      const response = await api();
      if (response.body.job.state !== 'running') return response.body.job;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Sync did not settle');
  };
  return { db, dbPath:path.join(root,'app.sqlite'), children, known, contexts,
    server, api, write, result, settled, exportsRoot };
}

test('sync refreshes a hidden listing from its saved identity and preserves notes and attention', async t => {
  const x=await setup(t),periodId='initial:13579135';
  const original=fixture('901',{messages:[{sequence:1,direction:'received',text:'Original',rawText:'Original'}]});
  importConversation(x.db,original,'prior/901.json',initialDate);
  updateApplicant(x.db,'chat:901',{notes:'Nota sintética',favorite:true});
  await x.api('POST');
  const fresh=fixture('901',{periodId,propertyId:'13579135',properties:[],
    sinceDate:initialDate,untilDate:date,activityStartsAt:x.contexts[0].activityStartsAt,includeLegacyHistory:true,
    exportedAt:'2026-09-24T12:00:00.000Z',messages:[...original.messages,
      {sequence:2,direction:'received',text:'Nuevo',rawText:'Nuevo',messageDate:date,occurredAt:'2026-09-24T08:00:00.000Z'}]});
  const file=x.write(fresh,date,'13579135',periodId);
  x.children[0].send(x.result([file],{periodId,activityStartsAt:fresh.activityStartsAt}));x.children[0].finish();
  const job=await x.settled();
  assert.equal(job.state,'succeeded');
  assert.equal(job.updated,1);
  assert.equal(job.newIncomingMessages,1);
  assert.deepEqual({...x.db.prepare('SELECT notes,favorite FROM applicants WHERE id=?').get('chat:901')},
    {notes:'Nota sintética',favorite:1});
  const stored=x.db.prepare('SELECT source_idealista_id,raw_json FROM conversations WHERE external_chat_id=?').get('901');
  assert.equal(stored.source_idealista_id,'13579135');
  assert.deepEqual(JSON.parse(stored.raw_json).properties,[]);
  const next={...fresh,exportedAt:'2026-09-24T13:00:00.000Z'};
  x.write(next,date,'13579135',periodId);
  assert.equal(importExports(x.db,x.exportsRoot).imported,1);
});

test('sync imports verified chats with a warning for unknown closed listings and does not establish a baseline', async t => {
  const x=await setup(t),periodId='initial:13579135';
  const original=fixture('901');
  importConversation(x.db,original,'prior/901.json',initialDate);
  updateApplicant(x.db,'chat:901',{notes:'Nota sintética',favorite:true});
  await x.api('POST');
  const fresh=fixture('901',{periodId,propertyId:'13579135',properties:[],
    sinceDate:initialDate,untilDate:date,activityStartsAt:x.contexts[0].activityStartsAt,includeLegacyHistory:true,
    exportedAt:'2026-09-24T12:00:00.000Z',messages:[...original.messages,
      {sequence:2,direction:'received',text:'Nuevo',rawText:'Nuevo',messageDate:date,occurredAt:'2026-09-24T08:00:00.000Z'}]});
  const files=[x.write(fresh,date,'13579135',periodId),
    x.write({...fresh,id:'902',properties:original.properties},date,'13579135',periodId)];
  x.children[0].send(x.result(files,{...scanFields('incremental','full',3,3),
    periodId,activityStartsAt:fresh.activityStartsAt,
    skippedUnverified:1,fullCoverage:false,headRechecked:true}));x.children[0].finish();
  const job=await x.settled();
  assert.equal(job.state,'succeeded',job.error);
  assert.equal(job.skippedUnverified,1);
  assert.equal(job.updated,1);
  assert.equal(job.imported,1);
  assert.equal(job.newIncomingMessages,1);
  assert.equal(job.fullCoverage,false);
  assert.deepEqual({...x.db.prepare('SELECT notes,favorite FROM applicants WHERE id=?').get('chat:901')},
    {notes:'Nota sintética',favorite:1});
  assert.equal(x.db.prepare('SELECT count(*) AS n FROM conversations').get().n,2);
  assert.equal(x.db.prepare('SELECT count(*) AS n FROM sync_source_baselines').get().n,0);
  assert.equal(x.db.prepare('SELECT full_coverage FROM sync_batches').get().full_coverage,0);
  await x.api('POST');
  assert.equal(x.contexts[1].canEarlyStop,false);
  x.children[1].send(x.result([],{...scanFields('incremental','full',1,1),
    skippedUnverified:1,fullCoverage:false,headRechecked:true}));x.children[1].finish();
  assert.equal((await x.settled()).state,'succeeded','all unknown chats yield a warning, not a failure');
});

test('unknown-listing warnings cannot bypass coverage validation or atomic imports', async t => {
  const x=await setup(t);
  const file=x.write(fixture('904'));
  for(const overrides of [{skippedUnverified:-1},{skippedUnverified:1.5},
    {skippedUnverified:3},{fullCoverage:true},{headRechecked:false},
    {examined:1},{skippedUnverified:0},{earlyStopped:true,stopReason:'unchanged_streak',unchangedStreak:5}]){
    await x.api('POST');
    x.children.at(-1).send(x.result([file],{...scanFields('incremental','full',2,2),
      skippedUnverified:1,fullCoverage:false,headRechecked:true,...overrides}));
    x.children.at(-1).finish();
    assert.equal((await x.settled()).errorCode,'INVALID_RESULT',JSON.stringify(overrides));
    assert.equal(x.db.prepare('SELECT count(*) AS n FROM conversations').get().n,0);
  }
});

test('missing or conflicting listing evidence cannot create or reassign chats and rolls back the batch', async t => {
  const x=await setup(t),periodId='initial:13579135';
  const original=fixture('902');
  importConversation(x.db,original,'prior/902.json',initialDate);
  for(const overrides of [{id:'903',properties:[]},
    {properties:[{url:'https://www.idealista.com/inmueble/12345678/'}]},
    {properties:[{url:'invalid'}]}]){
    await x.api('POST');
    const context=x.contexts.at(-1);
    const valid=fixture('902',{exportedAt:'2026-09-24T12:00:00.000Z'});
    const invalid=fixture('902',{periodId,propertyId:'13579135',sinceDate:initialDate,untilDate:date,
      activityStartsAt:context.activityStartsAt,includeLegacyHistory:true,
      exportedAt:'2026-09-24T13:00:00.000Z',...overrides});
    // Distinct files allow an otherwise valid update to precede the unknown chat.
    const files=invalid.id==='903'?[x.write(valid),x.write(invalid)]:[x.write(invalid)];
    x.children.at(-1).send(x.result(files));x.children.at(-1).finish();
    assert.equal((await x.settled()).state,'failed');
    assert.equal(x.db.prepare('SELECT count(*) AS n FROM conversations').get().n,1);
    assert.equal(x.db.prepare('SELECT exported_at FROM conversations').get().exported_at,original.exportedAt);
  }
  const missing=fixture('902',{periodId,propertyId:'13579135',properties:[],exportedAt:'2026-09-24T13:00:00.000Z'});
  updateProperty(x.db,'13579135',{idealistaUrl:'https://www.idealista.com/inmueble/24682468/'});
  assert.throws(()=>importConversation(x.db,{...missing,propertyId:'24682468'},
    'synthetic.json',date,'13579135',periodId),/no corresponde al anuncio/);
  updateProperty(x.db,'13579135',{idealistaUrl:'https://www.idealista.com/inmueble/13579135/'});
  const other=createProperty(x.db,{title:'Otra vivienda',rentalSince:initialDate,idealistaUrl:'https://www.idealista.com/inmueble/12345678/'});
  assert.throws(()=>importConversation(x.db,{...missing,periodId:other.activePeriodId,propertyId:'12345678'},
    'synthetic.json',date,other.id,other.activePeriodId),/no corresponde al anuncio/);
  const closed=closePeriod(x.db,'13579135',periodId,'chat:902');
  assert.throws(()=>importConversation(x.db,missing,'synthetic.json',date,'13579135',periodId),/cerrado/);
  const nextDay=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(closed.closedAt));
  const next=createPeriod(x.db,'13579135',{rentalSince:nextDay},nextDay);
  assert.throws(()=>importConversation(x.db,{...missing,periodId:next.id},
    'synthetic.json',nextDay,'13579135',next.id),/no corresponde al anuncio/);
});

test('first incremental completes a full baseline, then five unchanged chats stop safely', async t => {
  const x=await setup(t),periodId='initial:13579135';
  const sync=`/api/properties/13579135/periods/${encodeURIComponent(periodId)}/sync`;
  const list=`/api/properties/13579135/periods/${encodeURIComponent(periodId)}/applicants`;
  const message=(id)=>({sequence:1,direction:'received',author:'Persona',time:'10:00',
    text:`Mensaje ${id}`,rawText:`Mensaje ${id}`,messageDate:initialDate,
    occurredAt:'2026-09-23T08:00:00.000Z'});
  const files=[];
  for(let id=301;id<=306;id++){
    const data=fixture(id,{messages:[message(id)]});
    importConversation(x.db,data,`prior/${id}.json`,initialDate);
    files.push(x.write(data));
  }
  updateApplicant(x.db,'chat:306',{notes:'Nota privada',favorite:true});
  const firstStart=await x.api('POST',sync);
  assert.equal(firstStart.status,202);
  assert.deepEqual([firstStart.body.job.requestedMode,firstStart.body.job.effectiveMode],
    ['incremental','full']);
  assert.equal(x.contexts[0].canEarlyStop,false);
  x.children[0].send(x.result(files,scanFields('incremental','full',6,6)));
  x.children[0].finish();
  const full=await x.settled();
  assert.equal(full.state,'succeeded');
  assert.equal(full.fullCoverage,true);
  assert.equal(x.db.prepare('SELECT count(*) AS n FROM sync_source_baselines').get().n,1);
  const firstSummary=(await x.api('GET',list+'?status=all')).body.lastSuccessfulSync;
  assert.deepEqual([firstSummary.requestedMode,firstSummary.effectiveMode,
    firstSummary.examined,firstSummary.fullCoverage],['incremental','full',6,true]);
  const nextStart=await x.api('POST',sync);
  assert.deepEqual([nextStart.body.job.requestedMode,nextStart.body.job.effectiveMode],
    ['incremental','incremental']);
  assert.equal(x.contexts[1].canEarlyStop,true);
  assert.equal(Object.keys(x.contexts[1].baselineById).length,6);
  assert.ok(Object.values(x.contexts[1].baselineById).every(value=>/^[a-f0-9]{64}$/.test(value)));
  x.children[1].send(x.result(files.slice(0,5),
    scanFields('incremental','incremental',5,6,true)));
  x.children[1].finish();
  const partial=await x.settled();
  assert.equal(partial.state,'succeeded');
  assert.deepEqual([partial.examined,partial.candidates,partial.earlyStopped,
    partial.stopReason,partial.fullCoverage],[5,6,true,'unchanged_streak',false]);
  const saved=x.db.prepare('SELECT raw_json FROM conversations WHERE external_chat_id=?').get('306');
  assert.equal(JSON.parse(saved.raw_json).messages.length,1);
  assert.deepEqual({ ...x.db.prepare('SELECT notes,favorite FROM applicants WHERE id=?').get('chat:306') },
    {notes:'Nota privada',favorite:1});
  assert.equal(x.db.prepare('SELECT count(*) AS n FROM sync_attention').get().n,0);
  assert.equal(x.db.prepare('SELECT batch_id FROM sync_source_baselines').get().batch_id,full.id,
    'a partial run never replaces the last full baseline');
  assert.equal((await x.api('GET',sync)).body.supportsSyncModes,true);
  const priorBatch=x.db.prepare('SELECT id FROM sync_batches WHERE period_id=?').get(periodId).id;
  await x.api('POST',sync);
  x.children[2].send(x.result(files.slice(0,4),
    scanFields('incremental','incremental',5,6,true)));
  x.children[2].finish();
  assert.equal((await x.settled()).state,'failed','partial result without five unchanged files is rejected');
  assert.equal(x.db.prepare('SELECT id FROM sync_batches WHERE period_id=?').get(periodId).id,priorBatch);
  assert.equal(x.db.prepare('SELECT batch_id FROM sync_source_baselines').get().batch_id,full.id);
  const forced=await x.api('POST',sync,{body:JSON.stringify({mode:'full'})});
  assert.deepEqual([forced.body.job.requestedMode,forced.body.job.effectiveMode],['full','full']);
  assert.equal(x.contexts[3].canEarlyStop,false);
  x.children[3].send(x.result(files,scanFields('full','full',6,6)));
  x.children[3].finish();
  assert.equal((await x.settled()).state,'succeeded');
  assert.notEqual(x.db.prepare('SELECT batch_id FROM sync_source_baselines').get().batch_id,full.id);
  assert.equal((await x.api('POST',sync,{body:JSON.stringify({mode:'fast'})})).status,400);
  const fallbackStart=await x.api('POST',sync);
  assert.equal(fallbackStart.body.job.effectiveMode,'incremental');
  x.children[4].send(x.result(files,{...scanFields('incremental','full',13,6),
    headRechecked:true}));
  x.children[4].finish();
  const fallback=await x.settled();
  assert.equal(fallback.state,'succeeded','head race may force full reread after starting incremental');
  assert.deepEqual([fallback.requestedMode,fallback.effectiveMode,fallback.examined,
    fallback.fullCoverage],['incremental','full',13,true]);
  updateProperty(x.db,'13579135',{idealistaUrl:'https://www.idealista.com/inmueble/12345678/'},date);
  const newSource=await x.api('POST',sync);
  assert.equal(newSource.body.job.effectiveMode,'full','another listing has no full baseline');
  assert.equal(x.contexts[5].canEarlyStop,false);
  x.children[5].send({type:'error',code:'TEST_FAILURE',message:'Test interruption'});
  x.children[5].finish(1);
  assert.equal((await x.settled()).state,'failed');
  updateProperty(x.db,'13579135',{idealistaUrl:'https://www.idealista.com/inmueble/13579135/',
    rentalSince:'2026-09-22'},date);
  const changedStart=await x.api('POST',sync);
  assert.equal(changedStart.body.job.effectiveMode,'full',
    'an older start date invalidates the previously complete coverage');
  assert.equal(x.contexts[6].canEarlyStop,false);
  x.children[6].send({type:'error',code:'TEST_FAILURE',message:'Test interruption'});
  x.children[6].finish(1);
  assert.equal((await x.settled()).state,'failed');
  assert.equal(x.db.prepare('SELECT count(*) AS n FROM sync_source_baselines').get().n,1,
    'failed jobs never create or replace a source baseline');
});

test('successful sync persists only new applicants and added received messages until read', async t => {
  const x=await setup(t), periodId='initial:13579135';
  const list=`/api/properties/13579135/periods/${encodeURIComponent(periodId)}/applicants`;
  const sync=`/api/properties/13579135/periods/${encodeURIComponent(periodId)}/sync`;
  const detail=id=>`${list}/${encodeURIComponent(id)}`;
  const received=(sequence,text,day='2026-09-23',instant='2026-09-23T08:00:00.000Z')=>
    ({sequence,direction:'received',author:'Persona',time:'10:00',dateLabel:'HOY',
      messageDate:day,occurredAt:instant,text,rawText:`10:00 ${text}`});
  const prior=fixture('201',{messages:[received(1,'Original')]});
  importConversation(x.db,prior,'manual-archive/201.json',initialDate);
  updateApplicant(x.db,'201',{favorite:true,notes:'Nota privada'});
  assert.equal((await x.api('GET',list+'?status=all')).body.lastSuccessfulSync,null);
  assert.equal((await x.api('GET',detail('chat:201'))).body.syncAttention,null);
  const changed=fixture('201',{exportedAt:'2026-09-24T13:00:00.000Z',
    messages:[received(1,'Original'),received(2,'Mensaje nuevo',date,'2026-09-24T10:00:00.000Z'),
      {sequence:3,direction:'sent',author:'Propietario',time:'12:00',text:'Contesté',rawText:'Contesté'}]});
  const newcomer=fixture('202',{messages:[received(1,'Hola')]});
  const files=[x.write(changed),x.write(newcomer)];
  await x.api('POST',sync);
  x.children[0].send(x.result(files));x.children[0].finish();
  const first=await x.settled();
  assert.equal(first.state,'succeeded');
  assert.equal(first.imported,1);assert.equal(first.updated,1);
  assert.equal(first.newIncomingApplicants,1);assert.equal(first.newIncomingMessages,1);
  let response=(await x.api('GET',list+'?status=all')).body;
  assert.equal(response.lastSuccessfulSync.newCount,1);
  assert.equal(response.lastSuccessfulSync.incomingApplicantCount,1);
  assert.equal(response.lastSuccessfulSync.incomingMessageCount,1);
  assert.equal(response.lastSuccessfulSync.refreshedCount,1);
  const existing=response.items.find(item=>item.applicant_id==='chat:201');
  const added=response.items.find(item=>item.applicant_id==='chat:202');
  assert.deepEqual([existing.syncAttention,existing.newIncomingCount],['message',1]);
  assert.deepEqual([added.syncAttention,added.newIncomingCount],['new',0]);
  assert.deepEqual({ ...x.db.prepare('SELECT favorite,notes FROM applicants WHERE id=?').get('chat:201') },
    {favorite:1,notes:'Nota privada'});
  const restartRead=new DatabaseSync(x.dbPath,{readOnly:true});
  assert.equal(restartRead.prepare('SELECT count(*) n FROM sync_attention').get().n,2);
  assert.equal(restartRead.prepare('SELECT new_count FROM sync_batches WHERE period_id=?').get(periodId).new_count,1);
  restartRead.close();
  await x.api('POST',sync);
  x.children[1].send(x.result([]));x.children[1].finish();
  assert.equal((await x.settled()).newIncomingMessages,0);
  response=(await x.api('GET',list+'?status=all')).body;
  assert.equal(response.lastSuccessfulSync.newCount,0);
  assert.equal(response.items.find(item=>item.applicant_id==='chat:201').syncAttention,'message');
  const revision=existing.attentionRevision;
  const ack=await x.api('POST',`${detail('chat:201')}/attention/read`,{
    body:JSON.stringify({revision})});
  assert.equal(ack.status,200);
  assert.deepEqual(ack.body,{syncAttention:null,newIncomingCount:0,attentionRevision:null});
  assert.equal((await x.api('GET',detail('chat:201'))).body.syncAttention,null);
});

test('attention revision protects new incoming messages from stale read and failed sync', async t => {
  const x=await setup(t),periodId='initial:13579135';
  const root=`/api/properties/13579135/periods/${encodeURIComponent(periodId)}`;
  const applicant=`${root}/applicants/chat%3A211`;
  const message=(sequence,text,instant)=>({sequence,direction:'received',author:'Persona',
    time:sequence===1?'10:00':sequence===2?'10:01':'10:02',text,rawText:text,
    messageDate:date,occurredAt:instant});
  const one=fixture('211',{messages:[message(1,'Uno','2026-09-24T08:00:00.000Z')]});
  const file=x.write(one);
  await x.api('POST',`${root}/sync`);x.children[0].send(x.result([file]));x.children[0].finish();
  assert.equal((await x.settled()).imported,1);
  const first=(await x.api('GET',applicant)).body;
  assert.equal(first.syncAttention,'new');
  const second=fixture('211',{exportedAt:'2026-09-24T13:00:00.000Z',messages:[
    ...one.messages,message(2,'Dos','2026-09-24T09:01:00.000Z')]});
  x.write(second);
  await x.api('POST',`${root}/sync`);x.children[1].send(x.result([file]));x.children[1].finish();
  assert.equal((await x.settled()).newIncomingMessages,1);
  const latest=(await x.api('GET',applicant)).body;
  assert.equal(latest.syncAttention,'new');assert.equal(latest.newIncomingCount,1);
  assert.notEqual(latest.attentionRevision,first.attentionRevision);
  const stale=await x.api('POST',`${applicant}/attention/read`,{
    body:JSON.stringify({revision:first.attentionRevision})});
  assert.equal(stale.status,409);
  assert.equal(stale.body.attentionRevision,latest.attentionRevision);
  const third=fixture('211',{exportedAt:'2026-09-24T17:00:00.000Z',messages:[
    ...second.messages,message(3,'Tres','2026-09-24T14:02:00.000Z')]});
  x.write(third);
  await x.api('POST',`${root}/sync`);
  x.children[2].send(x.result([file]));x.children[2].finish();
  assert.equal((await x.settled()).newIncomingMessages,1);
  const accumulated=(await x.api('GET',applicant)).body;
  assert.equal(accumulated.syncAttention,'new');
  assert.equal(accumulated.newIncomingCount,2);
  assert.notEqual(accumulated.attentionRevision,latest.attentionRevision);
  await x.api('POST',`${root}/sync`);
  x.children[3].send({type:'error',code:'CHROME_UNAVAILABLE',message:'Chrome no disponible'});
  x.children[3].finish(1);
  assert.equal((await x.settled()).state,'failed');
  assert.equal((await x.api('GET',applicant)).body.attentionRevision,accumulated.attentionRevision);
  assert.equal((await x.api('GET',`${root}/sync`)).body.lastSuccessfulSync.incomingMessageCount,1);
  const ack=await x.api('POST',`${applicant}/attention/read`,{
    body:JSON.stringify({revision:accumulated.attentionRevision})});
  assert.equal(ack.status,200);
  assert.equal((await x.api('GET',applicant)).body.syncAttention,null);
});

test('later import failure rolls back earlier attention and last-success summary', async t => {
  const x=await setup(t),periodId='initial:13579135';
  const root=`/api/properties/13579135/periods/${encodeURIComponent(periodId)}`;
  const one={sequence:1,direction:'received',author:'Persona',time:'10:00',
    messageDate:initialDate,occurredAt:'2026-09-23T08:00:00.000Z',text:'Original',rawText:'Original'};
  importConversation(x.db,fixture('221',{messages:[one]}),'archive/221.json',initialDate);
  await x.api('POST',`${root}/sync`);
  x.children[0].send(x.result([]));x.children[0].finish();
  assert.equal((await x.settled()).state,'succeeded');
  const before=(await x.api('GET',`${root}/sync`)).body.lastSuccessfulSync;
  const valid=x.write(fixture('221',{exportedAt:'2026-09-24T13:00:00.000Z',messages:[
    one,{...one,sequence:2,messageDate:date,occurredAt:'2026-09-24T09:00:00.000Z',
      time:'11:00',text:'Nuevo',rawText:'Nuevo'}]}));
  const invalid=x.write(fixture('222',{periodMessages:[]}));
  await x.api('POST',`${root}/sync`);
  x.children[1].send(x.result([valid,invalid]));x.children[1].finish();
  assert.equal((await x.settled()).state,'failed');
  assert.equal(x.db.prepare('SELECT count(*) n FROM sync_attention').get().n,0);
  assert.deepEqual((await x.api('GET',`${root}/sync`)).body.lastSuccessfulSync,before);
  assert.equal(x.db.prepare('SELECT count(*) n FROM conversations').get().n,1);
  assert.equal(x.db.prepare('SELECT count(*) n FROM messages').get().n,1);
});

test('attention stays scoped, closes read-only, and is removed with a purged housing', async t => {
  const x=await setup(t),periodId='initial:13579135';
  const root=`/api/properties/13579135/periods/${encodeURIComponent(periodId)}`;
  const file=x.write(fixture('231'));
  await x.api('POST',`${root}/sync`);
  x.children[0].send(x.result([file]));x.children[0].finish();
  assert.equal((await x.settled()).imported,1);
  const other=createProperty(x.db,{title:'Otra vivienda',rentalSince:initialDate},date);
  const otherRoot=`/api/properties/${encodeURIComponent(other.id)}/periods/${encodeURIComponent(other.activePeriodId)}`;
  assert.equal((await x.api('GET',`${otherRoot}/applicants/chat%3A231`)).status,404);
  assert.equal((await x.api('POST',`${otherRoot}/applicants/chat%3A231/attention/read`,{
    body:JSON.stringify({revision:(await x.api('GET',`${root}/applicants/chat%3A231`)).body.attentionRevision})
  })).status,404);
  closePeriod(x.db,'13579135',periodId,'chat:231');
  const closed=(await x.api('GET',`${root}/applicants?status=all`)).body;
  assert.equal(closed.items[0].syncAttention,null);
  assert.equal((await x.api('POST',`${root}/applicants/chat%3A231/attention/read`,{
    body:JSON.stringify({revision:'00000000-0000-4000-8000-000000000000'})})).status,409);
  deleteProperty(x.db,'13579135');
  assert.equal((await x.api('GET',`${root}/applicants?status=all`)).status,404);
  purgeProperty(x.db,'13579135');
  assert.equal(x.db.prepare('SELECT count(*) n FROM sync_attention').get().n,0);
  assert.equal(x.db.prepare('SELECT count(*) n FROM sync_batches').get().n,0);
  assert.deepEqual(x.db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal((await x.api('GET',`${otherRoot}/applicants?status=all`)).status,200);
});

test('idle, asynchronous progress, busy lock, and responsive list', async t => {
  const x = await setup(t);
  const idle = await x.api();
  assert.equal(idle.status, 200);
  assert.equal(idle.body.job.state, 'idle');
  assert.equal(idle.body.job.imported, 0);
  const accepted = await x.api('POST');
  assert.equal(accepted.status, 202);
  assert.equal(accepted.body.job.state, 'running');
  assert.equal(accepted.body.job.sinceDate, initialDate);
  assert.equal(accepted.body.job.untilDate, date);
  assert.equal(accepted.body.job.propertyId, '13579135');
  assert.deepEqual(x.known[0], { ids: [], sinceDate: initialDate, untilDate: date, propertyId: '13579135' });
  const child = x.children[0];
  child.send({ type: 'progress', phase: 'discovering', discovered: 3, candidates: 2 });
  assert.equal((await x.api()).body.job.phase, 'discovering');
  const busy = await x.api('POST');
  assert.equal(busy.status, 409);
  assert.equal(busy.body.error, 'Ya hay una sincronización en curso');
  assert.equal(busy.body.job.id, accepted.body.job.id);
  assert.equal((await x.api('GET', '/api/applicants')).status, 200);
  child.send(x.result([])); child.finish();
  const done = await x.settled();
  assert.equal(done.state, 'succeeded');
  assert.equal(done.imported, 0);
  assert.ok(done.endedAt);
});

test('imports only new IDs, preserves states and histories, and supports repeat sync', async t => {
  const x = await setup(t);
  const prior = fixture('10');
  importConversation(x.db, prior, 'initial/10.json', initialDate);
  updateApplicant(x.db, '10', { favorite: true, discarded: true });
  const files = [x.write(fixture('10', { exportedAt: '2026-09-24T13:00:00.000Z',
    messages: [{ sequence: 1, rawText: 'Replaced' }, { sequence: 2, rawText: 'New message' }] })),
    x.write(fixture('11')), x.write(fixture('12'))];
  assert.equal((await x.api('POST')).status, 202);
  assert.deepEqual(x.known[0], { ids: ['10'], sinceDate: initialDate, untilDate: date, propertyId: '13579135' });
  updateApplicant(x.db, '10', { favorite: false, notes: '  Nota privada\nsegunda línea  ' });
  x.children[0].send(x.result(files)); x.children[0].finish();
  const first = await x.settled();
  assert.equal(first.state, 'succeeded');
  assert.equal(first.imported, 2);
  assert.equal(first.updated, 1);
  assert.equal(x.db.prepare('SELECT count(*) n FROM conversations').get().n, 3);
  assert.equal(x.db.prepare('SELECT count(*) n FROM applicants WHERE display_name=?').get('Nombre compartido').n, 3);
  assert.deepEqual({ ...x.db.prepare('SELECT favorite,discarded FROM applicants WHERE id=?').get('chat:10') },
    { favorite: 0, discarded: 1 });
  assert.equal(x.db.prepare('SELECT notes FROM applicants WHERE id=?').get('chat:10').notes,
    '  Nota privada\nsegunda línea  ');
  assert.equal(x.db.prepare('SELECT count(*) n FROM messages WHERE conversation_id=?').get('10').n, 2);
  assert.equal(x.db.prepare('SELECT raw_text FROM messages WHERE conversation_id=? AND sequence=2').get('10').raw_text, 'New message');
  assert.equal((await x.api('POST')).status, 202);
  assert.deepEqual(x.known[1], { ids: ['10', '11', '12'], sinceDate: initialDate, untilDate: date, propertyId: '13579135' });
  x.children[1].send(x.result(files)); x.children[1].finish();
  assert.equal((await x.settled()).imported, 0);
});

test('refreshes an ID inserted after discovery and before import without duplication', async t => {
  const x = await setup(t);
  const source = x.write(fixture('20', { exportedAt: '2026-09-24T13:00:00.000Z' }));
  await x.api('POST');
  importConversation(x.db, fixture('20', { messages: [{ sequence: 1, rawText: 'From elsewhere' }] }),
    'elsewhere/20.json', date);
  x.children[0].send(x.result([source])); x.children[0].finish();
  assert.equal((await x.settled()).imported, 0);
  assert.equal(x.db.prepare('SELECT raw_text FROM messages WHERE conversation_id=?').get('20').raw_text, 'Original');
  assert.equal(x.db.prepare('SELECT count(*) n FROM conversations WHERE id=?').get('20').n, 1);
});

test('worker failure and malformed result release busy state without imports', async t => {
  const x = await setup(t);
  await x.api('POST');
  x.children[0].send({ type: 'error', code: 'CHROME_UNAVAILABLE', message: 'Abre Chrome e inténtalo de nuevo.' });
  x.children[0].finish(1);
  let job = await x.settled();
  assert.equal(job.state, 'failed');
  assert.equal(job.errorCode, 'CHROME_UNAVAILABLE');
  assert.equal((await x.api('POST')).status, 202);
  x.children[1].send({ type: 'result', date, files: ['/tmp/escape.json'], discovered: 1, candidates: 1, exported: 1 });
  x.children[1].finish();
  job = await x.settled();
  assert.equal(job.state, 'failed');
  assert.equal(x.db.prepare('SELECT count(*) n FROM conversations').get().n, 0);
  assert.equal((await x.api('POST')).status, 202);
  x.children[2].send(x.result([])); x.children[2].finish();
  assert.equal((await x.settled()).state, 'succeeded');
});

test('invalid later export leaves all records untouched', async t => {
  const x = await setup(t);
  const good = x.write(fixture('30'));
  const bad = x.write(fixture('31', { messages: [{ sequence: 1 }] }));
  await x.api('POST');
  x.children[0].send(x.result([good, bad])); x.children[0].finish();
  const job = await x.settled();
  assert.equal(job.state, 'failed');
  assert.equal(job.errorCode, 'INVALID_EXPORT');
  assert.equal(x.db.prepare('SELECT count(*) n FROM conversations').get().n, 0);
});

test('property rental range includes older activity and manual import retains actual date', async t => {
  const x = await setup(t);
  importConversation(x.db, fixture('40'), 'initial/40.json', initialDate);
  const current = fixture('41', { activityDate: initialDate });
  const source = x.write(current);
  const accepted = await x.api('POST');
  assert.equal(accepted.body.job.sinceDate, initialDate);
  assert.deepEqual(x.known[0], { ids: ['40'], sinceDate: initialDate, untilDate: date, propertyId: '13579135' });
  x.children[0].send(x.result([source])); x.children[0].finish();
  assert.equal((await x.settled()).state, 'succeeded');
  assert.equal(x.db.prepare('SELECT activity_date FROM conversations WHERE id=?').get('41').activity_date, initialDate);
  const newer = { ...current, activityDate: initialDate, exportedAt: '2026-09-24T13:00:00.000Z' };
  importConversation(x.db, newer, source, date);
  assert.equal(x.db.prepare('SELECT activity_date FROM conversations WHERE id=?').get('41').activity_date, initialDate);
});

test('activity date outside rental range rejects whole batch', async t => {
  const x = await setup(t);
  importConversation(x.db, fixture('50'), 'initial/50.json', initialDate);
  const inside = x.write(fixture('51', { activityDate: date }));
  const before = x.write(fixture('52', { activityDate: '2026-09-22' }));
  await x.api('POST');
  x.children[0].send(x.result([inside, before])); x.children[0].finish();
  assert.equal((await x.settled()).errorCode, 'INVALID_EXPORT');
  assert.equal(x.db.prepare('SELECT count(*) n FROM conversations').get().n, 1);
  assert.equal((await x.api('POST')).status, 202);
  const future = x.write(fixture('53', { activityDate: '2026-09-25' }));
  x.children[1].send(x.result([future])); x.children[1].finish();
  assert.equal((await x.settled()).errorCode, 'INVALID_EXPORT');
  assert.equal(x.db.prepare('SELECT count(*) n FROM conversations').get().n, 1);
  assert.throws(() => importConversation(x.db, fixture('54', { activityDate: null }),
    'manual/54.json', date), /Fecha de actividad/);
});

test('other-property export rejects whole batch', async t => {
  const x = await setup(t);
  const valid = x.write(fixture('55'));
  const other = x.write(fixture('56', { properties: [{ url: 'https://www.idealista.com/inmueble/99999999/' }] }));
  await x.api('POST');
  x.children[0].send(x.result([valid, other])); x.children[0].finish();
  assert.equal((await x.settled()).errorCode, 'INVALID_EXPORT');
  assert.equal(x.db.prepare('SELECT count(*) n FROM conversations').get().n, 0);
});

test('incomplete refresh preserves a longer stored history and rolls back new chats', async t => {
  const x = await setup(t);
  const original = fixture('57', { messages: [
    { sequence: 1, rawText: 'Primero' }, { sequence: 2, rawText: 'Segundo' }] });
  importConversation(x.db, original, 'initial/57.json', initialDate);
  const fresh = x.write(fixture('58'));
  const incomplete = x.write(fixture('57', { exportedAt: '2026-09-24T13:00:00.000Z',
    integrity: { profile: 'completo', history: 'parcial', notes: ['El contenido cambió al recorrer el historial; requiere revisión.'] },
    messages: [{ sequence: 1, rawText: 'Solo primero' }] }));
  await x.api('POST');
  x.children[0].send(x.result([fresh, incomplete])); x.children[0].finish();
  assert.equal((await x.settled()).errorCode, 'INCOMPLETE_HISTORY');
  assert.equal(x.db.prepare('SELECT count(*) n FROM conversations').get().n, 1);
  assert.equal(x.db.prepare('SELECT count(*) n FROM messages WHERE conversation_id=?').get('57').n, 2);
});

test('attachment-only partial status can refresh complete visible text', async t => {
  const x = await setup(t);
  importConversation(x.db, fixture('59'), 'initial/59.json', initialDate);
  const source = x.write(fixture('59', { exportedAt: '2026-09-24T13:00:00.000Z',
    integrity: { profile: 'completo', history: 'parcial',
      notes: ['Adjuntos detectados: contenido pendiente de revisión, no descargado.'] },
    messages: [{ sequence: 1, rawText: 'Texto visible con adjunto' }] }));
  await x.api('POST');
  x.children[0].send(x.result([source])); x.children[0].finish();
  const job = await x.settled();
  assert.equal(job.state, 'succeeded');
  assert.equal(job.updated, 1);
  assert.equal(x.db.prepare('SELECT raw_text FROM messages WHERE conversation_id=?').get('59').raw_text,
    'Texto visible con adjunto');
});

test('period metadata cannot change during a running sync', async t => {
  const x = await setup(t);
  const first = await x.api('POST');
  assert.equal(first.body.job.sinceDate, initialDate);
  const changed = await x.api('PATCH', '/api/property', { headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rentalSince: date }) });
  assert.equal(changed.status, 409);
  assert.equal((await x.api()).body.job.sinceDate, initialDate);
  x.children[0].send(x.result([])); x.children[0].finish();
  assert.equal((await x.settled()).state, 'succeeded');
  const later = await x.api('PATCH', '/api/property', { headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rentalSince: date }) });
  assert.equal(later.status,200);
  const second = await x.api('POST');
  assert.equal(second.body.job.sinceDate, date);
  assert.deepEqual(x.known[1], { ids: [], sinceDate: date, untilDate: date, propertyId: '13579135' });
  x.children[1].send(x.result([], { sinceDate: date })); x.children[1].finish();
  assert.equal((await x.settled()).state, 'succeeded');
});

test('midnight rollover keeps frozen rental window with next-day export folder', async t => {
  const x = await setup(t);
  const nextDay = '2026-09-25';
  const source = x.write(fixture('60', { activityDate: date }), nextDay);
  await x.api('POST');
  x.children[0].send(x.result([source], { date: nextDay })); x.children[0].finish();
  assert.equal((await x.settled()).state, 'succeeded');
  assert.equal(x.db.prepare('SELECT activity_date FROM conversations WHERE id=?').get('60').activity_date, date);
});

test('POST requires local origin, JSON, and an empty object', async t => {
  const x = await setup(t);
  assert.equal((await x.api('POST', '/api/sync', { headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' } })).status, 403);
  assert.equal((await x.api('POST', '/api/sync', { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await x.api('POST', '/api/sync', { body: '{bad' })).status, 400);
  assert.equal((await x.api('POST', '/api/sync', { body: '{"unexpected":true}' })).status, 400);
  assert.equal(x.children.length, 0);
});

test('scoped sync refreshes only its housing and preserves manual applicant', async t => {
  const x = await setup(t);
  const second = createProperty(x.db,{title:'Segundo piso',rentalSince:initialDate,
    idealistaUrl:'https://www.idealista.com/inmueble/12345678/'},date);
  const secondUrl = [{url:second.url}];
  importConversation(x.db,fixture('70'),'first/70.json',initialDate);
  importConversation(x.db,fixture('71',{properties:secondUrl}),
    'second/71.json',initialDate,second.id);
  updateApplicant(x.db,'71',{favorite:true,notes:'Nota local'},second.id);
  const manual = createManualApplicant(x.db,second.id,{name:'Manual',notes:'No es chat'});
  const existing = x.write(fixture('71',{properties:secondUrl,exportedAt:'2026-09-24T13:00:00.000Z',
    messages:[{sequence:1,rawText:'Actualizado'},{sequence:2,rawText:'Nuevo mensaje'}]}),date,'12345678',second.activePeriodId);
  const fresh = x.write(fixture('72',{properties:secondUrl}),date,'12345678',second.activePeriodId);
  const accepted = await x.api('POST',`/api/properties/${second.id}/sync`);
  assert.equal(accepted.status,202);
  assert.equal(accepted.body.job.propertyId,second.id);
  assert.equal(accepted.body.job.idealistaPropertyId,'12345678');
  assert.deepEqual(x.known[0],{ids:['71'],sinceDate:initialDate,untilDate:date,propertyId:'12345678'});
  x.children[0].send(x.result([existing,fresh],{propertyId:'12345678',periodId:second.activePeriodId})); x.children[0].finish();
  const job = await x.settled();
  assert.equal(job.state,'succeeded');
  assert.equal(job.imported,1);
  assert.equal(job.updated,1);
  assert.equal(x.db.prepare('SELECT count(*) n FROM conversations').get().n,3);
  const second71=x.db.prepare('SELECT id,applicant_id FROM conversations WHERE period_id=? AND external_chat_id=?')
    .get(second.activePeriodId,'71');
  assert.equal(x.db.prepare('SELECT count(*) n FROM messages WHERE conversation_id=?').get(second71.id).n,2);
  assert.deepEqual({ ...x.db.prepare('SELECT favorite,notes FROM applicants WHERE id=?').get(second71.applicant_id) },
    {favorite:1,notes:'Nota local'});
  assert.equal(x.db.prepare('SELECT notes FROM applicants WHERE id=?').get(manual.applicant_id).notes,'No es chat');
  assert.equal(x.db.prepare('SELECT property_id FROM applicants WHERE id=?').get('chat:70').property_id,'13579135');
  const second72=x.db.prepare('SELECT applicant_id FROM conversations WHERE period_id=? AND external_chat_id=?')
    .get(second.activePeriodId,'72');
  assert.equal(x.db.prepare('SELECT property_id FROM applicants WHERE id=?').get(second72.applicant_id).property_id,second.id);
});

test('running sync blocks closing and period metadata edits until import finishes', async t => {
  const x=await setup(t);
  importConversation(x.db,fixture('801'),'initial/801.json',initialDate);
  const periodId='initial:13579135';
  const base=`/api/properties/13579135/periods/${encodeURIComponent(periodId)}`;
  const start=await x.api('POST',`${base}/sync`);
  assert.equal(start.status,202);
  assert.equal(start.body.job.periodId,periodId);
  assert.equal((await x.api('POST',`${base}/close`,{body:JSON.stringify({chosenApplicantId:'chat:801'})})).status,409);
  assert.equal((await x.api('PATCH',base,{headers:{'Content-Type':'application/json'},
    body:JSON.stringify({rentalSince:date})})).status,409);
  assert.equal((await x.api('GET',`${base}/applicants?status=all`)).body.counts.total,1);
  x.children[0].send(x.result([]));x.children[0].finish();
  assert.equal((await x.settled()).state,'succeeded');
  const closed=await x.api('POST',`${base}/close`,{body:JSON.stringify({chosenApplicantId:'chat:801'})});
  assert.equal(closed.status,200);
  assert.equal(closed.body.period.status,'closed');
  assert.equal((await x.api('POST',`${base}/sync`)).status,409);
  const reopened=await x.api('POST',`${base}/reopen`);
  assert.equal(reopened.status,200);
  assert.equal(reopened.body.period.id,periodId);
  assert.equal((await x.api('POST',`${base}/sync`)).status,202);
  assert.equal((await x.api('POST',`${base}/reopen`)).status,409);
  assert.deepEqual(x.known[1].ids,['801']);
  const fresh=fixture('801',{exportedAt:'2026-09-24T12:00:00.000Z',messages:[
    ...fixture('801').messages,{sequence:2,direction:'received',rawText:'Después de reabrir',text:'Después de reabrir',
      messageDate:date,occurredAt:'2026-09-24T08:00:00.000Z'}]});
  x.children[1].send(x.result([x.write(fresh)]));x.children[1].finish();
  assert.equal((await x.settled()).state,'succeeded');
  assert.equal(x.db.prepare('SELECT count(*) AS n FROM conversations').get().n,1);
  assert.equal(x.db.prepare('SELECT count(*) AS n FROM messages').get().n,2);
});

test('sync known IDs follow the edited listing and deletion waits for the job', async t => {
  const x=await setup(t);
  importConversation(x.db,fixture('811'),'original/811.json',initialDate);
  const json={'Content-Type':'application/json'};
  const propertyPath='/api/properties/13579135';
  const newUrl='https://www.idealista.com/inmueble/12345678/';
  const switched=await x.api('PATCH',propertyPath,{headers:json,
    body:JSON.stringify({idealistaUrl:newUrl})});
  assert.equal(switched.status,200);
  assert.equal(switched.body.property.defaultIdealistaId,'12345678');
  assert.equal((await x.api('POST',`${propertyPath}/sync`)).status,202);
  assert.deepEqual(x.known[0],{ids:[],sinceDate:initialDate,untilDate:date,propertyId:'12345678'});
  assert.equal((await x.api('PATCH',propertyPath,{headers:json,
    body:JSON.stringify({idealistaUrl:'https://www.idealista.com/inmueble/13579135/'})})).status,409);
  assert.equal((await x.api('DELETE',propertyPath)).status,409);
  x.children[0].send(x.result([],{propertyId:'12345678'}));x.children[0].finish();
  assert.equal((await x.settled()).state,'succeeded');
  const back=await x.api('PATCH',propertyPath,{headers:json,
    body:JSON.stringify({idealistaUrl:'https://www.idealista.com/inmueble/13579135/'})});
  assert.equal(back.status,200);
  assert.equal((await x.api('POST',`${propertyPath}/sync`)).status,202);
  assert.deepEqual(x.known[1],{ids:['811'],sinceDate:initialDate,untilDate:date,propertyId:'13579135'});
  x.children[1].send(x.result([]));x.children[1].finish();
  assert.equal((await x.settled()).state,'succeeded');
  assert.equal((await x.api('DELETE',propertyPath)).status,200);
  assert.equal((await x.api('POST',`${propertyPath}/restore`,{headers:json,body:'{}'})).status,200);
  assert.equal(x.db.prepare('SELECT source_idealista_id FROM conversations WHERE external_chat_id=?').get('811')
    .source_idealista_id,'13579135');
});
