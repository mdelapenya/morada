import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase, normalize, importConversation, importExports, listApplicants, applicantDetail,
  updateApplicant, getProperty, createProperty, updateProperty, createManualApplicant, getPeriod, getOpenPeriod,
  listPeriods, listProperties, createPeriod, closePeriod, reopenPeriod, deleteProperty, periodActivityStartsAt } from '../app/database.mjs';
import { createServer } from '../app/server.mjs';
import { importedArrival, manualArrival } from '../app/arrival.mjs';
import { importedHasReplied, importedAwaitingReply } from '../app/reply.mjs';

test('pending reply follows the last real in-period turn, including same-minute source order', () => {
  const start='2026-09-23T22:00:00.000Z';
  const incoming=(sequence,instant='2026-09-24T08:00:00.000Z')=>({sequence,direction:'received',
    text:'Hola',messageDate:'2026-09-24',occurredAt:instant});
  const sent=(sequence,instant='2026-09-24T08:00:00.000Z')=>({sequence,direction:'sent',
    text:'Respuesta',messageDate:'2026-09-24',occurredAt:instant});
  const state=(messages,history='completo',closedAt=null)=>importedAwaitingReply(messages,
    '2026-09-24',start,closedAt,history);
  assert.equal(state([incoming(1)]),true,'initial incoming requires attention');
  assert.equal(state([incoming(1),sent(2)]),false);
  assert.equal(state([incoming(1),sent(2),incoming(3)]),true);
  assert.equal(state([incoming(1),sent(2),incoming(3)],'parcial'),null);
  assert.equal(state([]),null);
  assert.equal(state([incoming(1),{sequence:2,direction:'sent',text:null,
    embeddedProfile:{text:'Changed'},media:[{tag:'IMG',alt:'avatar'}]}]),true);
  assert.equal(state([incoming(1),{sequence:2,direction:'sent',attachments:[{url:'file'}],
    messageDate:'2026-09-24',occurredAt:'2026-09-24T08:01:00.000Z'}]),false);
  assert.equal(state([{sequence:1,direction:'sent',text:'Old',messageDate:'2022-04-01',
    occurredAt:'2022-04-01T08:00:00.000Z'},incoming(2)]),true);
  assert.equal(state([incoming(1),sent(2,'2026-09-24T08:01:00.000Z')],
    'completo','2026-09-24T08:00:30.000Z'),null,
    'the close minute has uncertain ordering');
  assert.equal(state([incoming(1),sent(2,'2026-09-24T08:01:00.000Z')],
    'completo','2026-09-24T08:00:00.000Z'),null,
    'a message in the close minute cannot be assigned');
  assert.equal(state([incoming(1),sent(2,'2026-09-24T08:01:00.000Z')],
    'completo','2026-09-24T08:02:00.000Z'),false);
  assert.equal(state([incoming(1),sent(1)]),null,'duplicate source sequence is ambiguous');
  assert.equal(state([incoming(1),sent(2,'2026-09-24T07:59:00.000Z')]),null,
    'contradictory times cannot prove the final turn');
});

test('owner reply requires a real verified sent message inside this period', () => {
  const start='2026-09-23T22:30:00.000Z'; // 00:30 Madrid on 24 September.
  const sent=(day,instant,extra={})=>({direction:'sent',messageDate:day,occurredAt:instant,
    text:'He contestado',...extra});
  const received={direction:'received',messageDate:'2026-09-24',
    occurredAt:'2026-09-23T23:00:00.000Z',text:'Gracias'};
  assert.equal(importedHasReplied([sent('2022-04-01','2022-04-01T08:00:00.000Z'),received],
    '2026-09-24',start,null,'completo'),false);
  assert.equal(importedHasReplied([sent('2026-09-24','2026-09-23T22:20:00.000Z')],
    '2026-09-24',start,null,'completo'),false);
  assert.equal(importedHasReplied([sent('2026-09-24','2026-09-23T22:45:00.000Z'),received],
    '2026-09-24',start,null,'completo'),true,
    'a later incoming message does not erase the fact that the owner replied');
  assert.equal(importedHasReplied([sent('2026-09-24',null)],
    '2026-09-24',start,null,'completo'),null);
  assert.equal(importedHasReplied([received],'2026-09-24',start,null,'parcial'),null);
  assert.equal(importedHasReplied([sent('2026-09-24','2026-09-23T22:45:00.000Z')],
    '2026-09-24',start,null,'parcial'),true);
  assert.equal(importedHasReplied([sent('2026-09-24','2026-09-23T22:45:00.000Z',
    {text:null,embeddedProfile:{text:'Ficha'},media:[{tag:'IMG',alt:'avatar'}]})],
    '2026-09-24',start,null,'completo'),false);
  assert.equal(importedHasReplied([sent('2026-09-24','2026-09-23T22:45:00.000Z',
    {text:null,attachments:[{url:'https://example.test/file'}]})],
    '2026-09-24',start,null,'completo'),true);
  assert.equal(importedHasReplied([sent('2026-09-24','2026-09-23T22:45:00.000Z')],
    '2026-09-24',start,'2026-09-23T22:40:00.000Z','completo'),false,
    'a closed period cannot claim a later owner message');
  assert.equal(importedHasReplied([sent('2026-09-24','2026-09-23T22:45:00.000Z')],
    '2026-09-24',start,'2026-09-23T22:45:30.000Z','completo'),null,
    'the closure minute cannot prove whether the owner sent before closing');
});

test('arrival uses verified incoming contact, excludes old context and uncertain cutoff times', () => {
  const incoming=(day,instant,text='Hola')=>({direction:'received',messageDate:day,
    occurredAt:instant,text});
  const sent=(day,instant)=>({direction:'sent',messageDate:day,occurredAt:instant,text:'Saliente'});
  const start='2026-09-23T22:30:00.000Z'; // 00:30 Madrid on 24 September.
  assert.deepEqual(importedArrival([
    incoming('2022-04-01','2022-04-01T08:00:00.000Z'),
    sent('2026-09-24','2026-09-23T22:31:00.000Z'),
    incoming('2026-09-24','2026-09-23T22:20:00.000Z'),
    incoming('2026-09-24','2026-09-23T22:45:00.000Z'),
    incoming('2026-09-25','2026-09-25T08:00:00.000Z')
  ],'2026-09-24',start),{arrivalDate:'2026-09-24',arrivalAt:'2026-09-23T22:45:00.000Z'});
  assert.deepEqual(importedArrival([
    incoming('2026-09-24',null),
    incoming('2026-09-24','2026-09-23T22:45:00.000Z')
  ],'2026-09-24','2026-09-23T22:00:00.000Z'),
  {arrivalDate:'2026-09-24',arrivalAt:null});
  assert.deepEqual(importedArrival([incoming('2026-09-24',null)],
    '2026-09-24',start),{arrivalDate:null,arrivalAt:null});
  assert.deepEqual(importedArrival([sent('2026-09-24','2026-09-23T22:45:00.000Z')],
    '2026-09-24',start),{arrivalDate:null,arrivalAt:null});
  assert.deepEqual(importedArrival([incoming('2026-09-24','2026-09-23T22:45:37.000Z')],
    '2026-09-24',start),{arrivalDate:null,arrivalAt:null});
});

test('manual arrival uses valid creation date and matching instant only', () => {
  assert.deepEqual(manualArrival('2026-09-24','2026-09-24T08:00:00.000Z'),
    {arrivalDate:'2026-09-24',arrivalAt:'2026-09-24T08:00:00.000Z'});
  assert.deepEqual(manualArrival('2026-09-24','2026-09-23T21:00:00.000Z'),
    {arrivalDate:'2026-09-24',arrivalAt:null});
  assert.deepEqual(manualArrival('not-a-date','2026-09-24T08:00:00.000Z'),
    {arrivalDate:null,arrivalAt:null});
});

test('arrival stays at first received contact when latest activity changes', async t => {
  const {db}=temporaryDb(t);
  const old={sequence:1,direction:'received',text:'Historia antigua',rawText:'Historia antigua',
    messageDate:'2022-04-01',occurredAt:'2022-04-01T08:00:00.000Z'};
  const first={sequence:2,direction:'received',text:'Primer contacto',rawText:'Primer contacto',
    messageDate:'2026-09-23',occurredAt:'2026-09-23T08:00:00.000Z'};
  importConversation(db,fixture(981,{messages:[old,first]}),'archive/981.json','2026-09-23');
  const manual=createManualApplicant(db,'13579135',{name:'Manual'});
  importConversation(db,fixture(982,{messages:[{sequence:1,direction:'received',
    text:'Fecha desconocida',rawText:'Fecha desconocida'}]}),'archive/982.json','2026-09-23');
  let items=listApplicants(db,new URLSearchParams({status:'all'}));
  let imported=items.find(item=>item.applicant_id==='chat:981');
  assert.deepEqual([imported.arrivalDate,imported.arrivalAt],
    ['2026-09-23','2026-09-23T08:00:00.000Z']);
  assert.deepEqual([items.find(item=>item.applicant_id==='chat:982').arrivalDate,
    items.find(item=>item.applicant_id==='chat:982').arrivalAt],[null,null]);
  const manualItem=items.find(item=>item.applicant_id===manual.applicant_id);
  assert.equal(manualItem.messageCount,0);
  assert.equal(applicantDetail(db,manual.applicant_id).messageCount,0);
  assert.equal(imported.messageCount,applicantDetail(db,imported.applicant_id).messages.length);
  assert.equal(manualItem.arrivalDate,manualItem.created_date);
  assert.equal(manualItem.arrivalAt,manualItem.created_at);
  const later={sequence:3,direction:'received',text:'Mensaje posterior',rawText:'Mensaje posterior',
    messageDate:'2026-09-24',occurredAt:'2026-09-24T09:00:00.000Z'};
  importConversation(db,fixture(981,{activityDate:'2026-09-24',exportedAt:'2026-09-24T12:00:00.000Z',
    messages:[old,first,later]}),'refresh/981.json','2026-09-24');
  items=listApplicants(db,new URLSearchParams({status:'all'}));
  imported=items.find(item=>item.applicant_id==='chat:981');
  assert.equal(imported.messageCount,3);
  assert.equal(imported.messageCount,applicantDetail(db,imported.applicant_id).messages.length);
  assert.equal(imported.activity_date,'2026-09-24');
  assert.deepEqual([imported.arrivalDate,imported.arrivalAt],
    ['2026-09-23','2026-09-23T08:00:00.000Z']);
  assert.equal(listApplicants(db,new URLSearchParams({status:'all',date:'2026-09-24'}))
    .some(item=>item.applicant_id==='chat:981'),true,'activity filter remains latest activity');
  const detail=applicantDetail(db,'chat:981');
  assert.equal(detail.arrivalDate,'2026-09-23');
  const server=createServer(db);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const response=await request(server,'/api/properties/13579135/periods/initial%3A13579135/applicants?status=all');
  assert.equal(response.status,200);
  assert.equal((await response.json()).items.find(item=>item.applicant_id==='chat:981').arrivalDate,
    '2026-09-23');
});

test('reply status is period-scoped in applicant list and detail, including unknown and manual', async t => {
  const {db}=temporaryDb(t);
  const received={sequence:1,direction:'received',text:'Hola',rawText:'Hola',
    messageDate:'2026-09-23',occurredAt:'2026-09-23T08:00:00.000Z'};
  const oldSent={sequence:2,direction:'sent',text:'Respuesta antigua',rawText:'Respuesta antigua',
    messageDate:'2022-04-01',occurredAt:'2022-04-01T08:00:00.000Z'};
  importConversation(db,fixture(991,{messages:[oldSent,received]}),'archive/991.json','2026-09-23');
  importConversation(db,fixture(992,{messages:[received,{sequence:2,direction:'sent',
    text:'Fecha desconocida',rawText:'Fecha desconocida'}]}),'archive/992.json','2026-09-23');
  const manual=createManualApplicant(db,'13579135',{name:'Manual'});
  let items=listApplicants(db,new URLSearchParams({status:'all'}));
  assert.equal(items.find(x=>x.applicant_id==='chat:991').hasReplied,false);
  assert.equal(items.find(x=>x.applicant_id==='chat:992').hasReplied,null);
  assert.equal(items.find(x=>x.applicant_id===manual.applicant_id).hasReplied,null);
  assert.equal(applicantDetail(db,'chat:991').hasReplied,false);
  const nowSent={sequence:3,direction:'sent',text:'Respuesta actual',rawText:'Respuesta actual',
    messageDate:'2026-09-23',occurredAt:'2026-09-23T10:00:00.000Z'};
  importConversation(db,fixture(991,{exportedAt:'2026-09-24T12:00:00.000Z',
    messages:[oldSent,received,nowSent]}),'refresh/991.json','2026-09-24');
  items=listApplicants(db,new URLSearchParams({status:'all'}));
  assert.equal(items.find(x=>x.applicant_id==='chat:991').hasReplied,true);
  assert.equal(applicantDetail(db,'chat:991').hasReplied,true);
  const server=createServer(db);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const response=await request(server,'/api/properties/13579135/periods/initial%3A13579135/applicants?status=all');
  assert.equal(response.status,200);
  const apiItems=(await response.json()).items;
  assert.equal(apiItems.find(x=>x.applicant_id==='chat:991').hasReplied,true);
  assert.equal(apiItems.find(x=>x.applicant_id==='chat:992').hasReplied,null);
  assert.equal(apiItems.find(x=>x.applicant_id==='chat:991').messageCount,
    applicantDetail(db,'chat:991').messages.length);
  assert.equal(apiItems.find(x=>x.applicant_id===manual.applicant_id).messageCount,0);
});

test('reply filter combines with existing filters and distinguishes no chat from unknown', async t => {
  const {db}=temporaryDb(t);
  const received={sequence:1,direction:'received',text:'Hola',rawText:'Hola',
    messageDate:'2026-09-23',occurredAt:'2026-09-23T08:00:00.000Z'};
  const sent={sequence:2,direction:'sent',text:'Respuesta',rawText:'Respuesta',
    messageDate:'2026-09-23',occurredAt:'2026-09-23T09:00:00.000Z'};
  importConversation(db,fixture(991,{name:'Ana',messages:[received,sent]}),'fixture/991.json','2026-09-23');
  importConversation(db,fixture(992,{name:'Berta',messages:[received]}),'fixture/992.json','2026-09-23');
  importConversation(db,fixture(993,{name:'Clara',messages:[received,{...sent,occurredAt:null,messageDate:null}]}),
    'fixture/993.json','2026-09-23');
  const manual=createManualApplicant(db,'13579135',{name:'Diana'});
  const params=reply=>new URLSearchParams({status:'all',reply});
  const ids=reply=>listApplicants(db,params(reply)).map(x=>x.applicant_id);
  assert.deepEqual(ids('all').sort(),['chat:991','chat:992','chat:993',manual.applicant_id].sort());
  assert.deepEqual(ids('replied'),['chat:991']);
  assert.deepEqual(ids('not_replied'),['chat:992']);
  assert.deepEqual(ids('unknown'),['chat:993']);
  assert.deepEqual(ids('no_chat'),[manual.applicant_id]);
  const pending=value=>listApplicants(db,new URLSearchParams({status:'all',pendingReply:value}))
    .map(x=>x.applicant_id);
  assert.deepEqual(pending('yes'),['chat:992']);
  assert.deepEqual(pending('no'),['chat:991']);
  assert.deepEqual(pending('unknown'),['chat:993']);
  assert.deepEqual(pending('no_chat'),[manual.applicant_id]);
  assert.deepEqual(listApplicants(db,new URLSearchParams({status:'all',reply:'not_replied',
    pendingReply:'yes'})).map(x=>x.applicant_id),['chat:992']);
  assert.deepEqual(listApplicants(db,new URLSearchParams({status:'all',reply:'replied',
    pendingReply:'yes'})),[]);
  assert.deepEqual(listApplicants(db,new URLSearchParams({status:'all',reply:'replied',name:'Berta'})),[]);
  assert.deepEqual(listApplicants(db,new URLSearchParams({status:'all',reply:'replied',name:'Ana'}))
    .map(x=>x.applicant_id),['chat:991']);
  assert.deepEqual(listApplicants(db,new URLSearchParams({status:'favorites',reply:'replied'})),[]);
  updateApplicant(db,'chat:991',{favorite:true});
  assert.deepEqual(listApplicants(db,new URLSearchParams({status:'favorites',reply:'replied'}))
    .map(x=>x.applicant_id),['chat:991']);
  assert.throws(()=>listApplicants(db,params('maybe')),/Filtro de respuesta/);
  assert.throws(()=>listApplicants(db,new URLSearchParams({pendingReply:'maybe'})),/Filtro de seguimiento/);
  const server=createServer(db);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  for(const route of ['/api/applicants','/api/properties/13579135/applicants',
    '/api/properties/13579135/periods/initial%3A13579135/applicants']) {
    const result=await request(server,`${route}?status=all&reply=replied`);
    assert.equal(result.status,200);
    const body=await result.json();
    assert.equal(body.supportsReplyFilter,true);
    assert.equal(body.supportsPendingReplyFilter,true);
    assert.deepEqual(body.items.map(x=>x.applicant_id),['chat:991']);
    assert.equal(body.counts.total,4,'period summary remains independent of filters');
    const empty=await (await request(server,`${route}?status=all&reply=replied&name=Nadie`)).json();
    assert.equal(empty.supportsReplyFilter,true);
    assert.equal(empty.supportsPendingReplyFilter,true);
    assert.deepEqual(empty.items,[]);
    assert.equal((await request(server,`${route}?reply=maybe`)).status,400);
    const pendingBody=await (await request(server,`${route}?status=all&pendingReply=yes`)).json();
    assert.deepEqual(pendingBody.items.map(x=>x.applicant_id),['chat:992']);
    assert.equal((await request(server,`${route}?pendingReply=maybe`)).status,400);
  }
});

function fixture(id, overrides = {}) {
  return {
    id: String(id), name: `Solicitante ${id}`, listedDate: '10:30', exportedAt: '2026-09-23T12:00:00.000Z',
    properties: [{ url: 'https://www.idealista.com/inmueble/13579135/' }],
    profile: { text: 'Perfil de prueba', fields: [], paragraphs: [] },
    integrity: { profile: 'completo', history: 'completo' },
    messages: [{ sequence: 1, author: 'Solicitante', direction: 'incoming', dateLabel: '23 sept.', time: '10:00',
      messageDate:'2026-09-23',occurredAt:'2026-09-23T08:00:00.000Z',text: 'Hola', rawText: 'Hola' }],
    ...overrides,
  };
}

function temporaryDb(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'idealista-backend-'));
  const filename = path.join(dir, 'app.sqlite');
  const db = openDatabase(filename);
  t.after(() => { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  return { db, filename };
}

function add(db, id, fields, overrides = {}) {
  return importConversation(db, fixture(id, { profile: { text: 'Perfil de prueba', fields }, ...overrides }), `fixture/${id}.json`, '2026-09-23');
}

test('normaliza lo conocido, conserva desconocidos como null y acepta importe español', () => {
  const unknown = normalize(['Campo sin formato']);
  assert.deepEqual(unknown.values, { people_count: null, has_children: null, has_pets: null, monthly_income_cents: null, income_scope: null });
  assert.deepEqual(unknown.evidence, {});
  const parsed = normalize(['Somos una pareja', 'Sin menores', 'Con mascota: perro', 'Ingresos mensuales del grupo: 1.234,5 €']);
  assert.deepEqual(parsed.values, { people_count: 2, has_children: 0, has_pets: 1, monthly_income_cents: 123450, income_scope: 'grupo' });
  assert.equal(parsed.evidence.monthly_income_cents, 'Ingresos mensuales del grupo: 1.234,5 €');
});

test('filtra rangos inclusivos y combina menores, mascotas y personas', (t) => {
  const { db } = temporaryDb(t);
  add(db, 1, ['Somos 2 personas', 'Sin menores', 'Sin mascota', 'Ingreso mensual: 1.200 €']);
  add(db, 2, ['Somos 3 personas', 'Hay menores: sí', 'Con mascota: gato', 'Ingreso mensual: 1.500 €']);
  add(db, 3, ['Somos 4 personas', 'Hay menores: sí', 'Con mascota: perro', 'Ingreso mensual: 2.000 €']);
  const results = listApplicants(db, new URLSearchParams({ children: '1', pets: '1', peopleMin: '3', peopleMax: '3', incomeMin: '1500', incomeMax: '1500' }));
  assert.deepEqual(results.map(x => x.conversation_id), ['2']);
  assert.throws(() => listApplicants(db, new URLSearchParams({ peopleMin: '4', peopleMax: '3' })), /mínimo/);
  assert.throws(() => listApplicants(db, new URLSearchParams({ incomeMin: '-1' })), /Rango/);
  assert.throws(() => listApplicants(db, new URLSearchParams({ peopleMin: '1.5' })), /Rango/);
});

test('conserva chats con el mismo nombre, estado local y mensajes al reimportar', (t) => {
  const { db, filename } = temporaryDb(t);
  const sameName = { name: 'Nombre compartido' };
  add(db, 10, ['Somos una pareja'], sameName);
  add(db, 11, ['Somos una pareja'], sameName);
  assert.equal(listApplicants(db, new URLSearchParams({ status: 'all' })).length, 2);
  assert.equal(updateApplicant(db, '10', { favorite: true, discarded: true }), true);
  const newer = fixture(10, { ...sameName, exportedAt: '2026-09-23T13:00:00.000Z', messages: [
    { sequence: 1, rawText: 'Actualizado' }, { sequence: 2, rawText: 'Segundo' },
  ] });
  assert.equal(importConversation(db, newer, 'fixture/10.json', '2026-09-23'), true);
  assert.equal(db.prepare('select count(*) n from messages where conversation_id=?').get('10').n, 2);
  assert.deepEqual({ ...db.prepare('select favorite,discarded from applicants where id=?').get('chat:10') }, { favorite: 1, discarded: 1 });
  db.close();
  const reopened = openDatabase(filename);
  assert.deepEqual({ ...reopened.prepare('select favorite,discarded from applicants where id=?').get('chat:10') }, { favorite: 1, discarded: 1 });
  reopened.close();
});

test('detalle y cambios distinguen esquemas inválidos y conversaciones inexistentes', (t) => {
  const { db } = temporaryDb(t);
  add(db, 20, ['Somos 1 persona']);
  assert.equal(applicantDetail(db, '20').messages.length, 1);
  assert.equal(applicantDetail(db, '404'), null);
  assert.equal(updateApplicant(db, '404', { favorite: true }), false);
  assert.throws(() => updateApplicant(db, '20', {}), /Cambios/);
  assert.throws(() => updateApplicant(db, '20', { favorite: 1 }), /Cambios/);
  assert.throws(() => updateApplicant(db, '20', { other: true }), /Cambios/);
});

async function request(server, pathname, options = {}) {
  const address = server.address();
  return fetch(`http://127.0.0.1:${address.port}${pathname}`, options);
}

test('HTTP sirve la marca Morada como SVG con un tipo seguro', async t => {
  const { db } = temporaryDb(t);
  const server = createServer(db);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await request(server, '/morada-mark.svg');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
  assert.match(await response.text(), /<svg\b/);
});

test('HTTP sirve lista, detalle, validación PATCH y rechaza origen ajeno', async (t) => {
  const { db } = temporaryDb(t);
  add(db, 30, ['Somos 2 personas', 'Sin menores', 'Sin mascota']);
  const server = createServer(db);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  let response = await request(server, '/api/applicants?peopleMin=2');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).items.length, 1);
  response = await request(server, '/api/applicants/30');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).conversation_id, '30');
  response = await request(server, '/api/applicants/404');
  assert.equal(response.status, 404);
  response = await request(server, '/api/applicants/30', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: JSON.stringify({ favorite: true }) });
  assert.equal(response.status, 403);
  response = await request(server, '/api/applicants/30', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ favorite: true }) });
  assert.equal(response.status, 200);
  response = await request(server, '/api/applicants/30', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ favorite: 'true' }) });
  assert.equal(response.status, 400);
  response = await request(server, '/api/applicants/404', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ favorite: true }) });
  assert.equal(response.status, 404);
});

test('property date and private notes persist, validate input, and appear in detail', async t => {
  const { db, filename } = temporaryDb(t);
  add(db, 80, []);
  const server = createServer(db, { today: () => '2026-09-24' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  let response = await request(server, '/api/property');
  assert.deepEqual((await response.json()).property, { id: '13579135', title: 'Piso de prueba',
    address: null, monthlyRentCents: 82500, idealistaId: '13579135', syncEnabled: true,
    url: 'https://www.idealista.com/inmueble/13579135/', rentalSince: '2026-09-23', dateConfirmed: true,
    activePeriodId:'initial:13579135',periodStatus:'open',lastClosedPeriod:null,
    defaultIdealistaId:'13579135',defaultIdealistaUrl:'https://www.idealista.com/inmueble/13579135/',
    canEditIdealistaUrl:true,canDeleteProperty:true,deletedAt:null });
  const json = { 'Content-Type': 'application/json' };
  response = await request(server, '/api/property', { method: 'PATCH', headers: json,
    body: JSON.stringify({ rentalSince: '2026-09-22' }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).property.rentalSince, '2026-09-22');
  for (const rentalSince of ['2026-02-30', '2026-09-25', 'no-date']) {
    response = await request(server, '/api/property', { method: 'PATCH', headers: json,
      body: JSON.stringify({ rentalSince }) });
    assert.equal(response.status, 400);
  }
  response = await request(server, '/api/property', { method: 'PATCH',
    headers: { ...json, Origin: 'http://evil.example' }, body: '{"rentalSince":"2026-09-23"}' });
  assert.equal(response.status, 403);
  response = await request(server, '/api/property', { method: 'PATCH',
    headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(response.status, 415);
  const note = '  Prefiere visitar por la tarde.\nLlamar después de las 18:00.  ';
  response = await request(server, '/api/applicants/80', { method: 'PATCH', headers: json,
    body: JSON.stringify({ notes: note }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).notes, note);
  assert.equal((await (await request(server, '/api/applicants/80')).json()).notes, note);
  assert.equal((await (await request(server, '/api/applicants')).json()).items[0].notes, note);
  for (const notes of [1, 'x'.repeat(10001)]) {
    response = await request(server, '/api/applicants/80', { method: 'PATCH', headers: json,
      body: JSON.stringify({ notes }) });
    assert.equal(response.status, 400);
  }
  response = await request(server, '/api/applicants/80', { method: 'PATCH', headers: json,
    body: JSON.stringify({ notes: '' }) });
  assert.equal(response.status, 200);
  assert.equal((await (await request(server, '/api/applicants/80')).json()).notes, '');
  const reopened = openDatabase(filename);
  assert.equal(getProperty(reopened).rentalSince, '2026-09-22');
  assert.equal(getProperty(reopened).dateConfirmed, true);
  assert.equal(reopened.prepare('SELECT notes FROM applicants WHERE id=?').get('chat:80').notes, '');
  reopened.close();
});

test('notes migration preserves existing favorite and discard flags', t => {
  const { db, filename } = temporaryDb(t);
  add(db, 90, []);
  updateApplicant(db, '90', { favorite: true, discarded: true });
  db.exec('DROP VIEW interested');
  db.exec('ALTER TABLE applicants DROP COLUMN notes');
  db.close();
  const reopened = openDatabase(filename);
  assert.deepEqual({ ...reopened.prepare('SELECT favorite,discarded,notes FROM applicants WHERE id=?').get('chat:90') },
    { favorite: 1, discarded: 1, notes: '' });
  reopened.close();
});

test('message phrase search combines filters and returns original matching context', async t => {
  const { db } = temporaryDb(t);
  const property = [{ url: 'https://www.idealista.com/inmueble/13579135/' }];
  const message = (rawText, author = 'Solicitante', direction = 'incoming') =>
    ({ sequence: 1, author, direction, dateLabel: '24 sept.', time: '10:30', rawText, text: rawText });
  add(db, 101, [], { properties: property, messages: [message(`${'antes '.repeat(90)}HOSPITÁL\nCentral${' después'.repeat(90)}`)] });
  add(db, 102, [], { properties: property, messages: [message('¿Uso %_ como código? Cerca del hospital.', 'Propietario', 'sent')] });
  add(db, 103, [], { properties: property, messages: [message('Hola')] });
  add(db, 104, [], { properties: [{ url: 'https://www.idealista.com/inmueble/99999999/' }], messages: [message('Hospital central')] });
  updateApplicant(db, '101', { favorite: true });
  updateApplicant(db, '103', { notes: 'Hospital central' });
  let rows = listApplicants(db, new URLSearchParams({ messageQuery: 'hospital  central' }));
  assert.deepEqual(rows.map(row => row.conversation_id), ['101']);
  assert.match(rows[0].messageMatch.snippet, /HOSPITÁL Central/);
  assert.ok(rows[0].messageMatch.snippet.length <= 702);
  assert.equal(rows[0].messageMatch.author, 'Solicitante');
  assert.equal(rows[0].messageMatch.dateLabel, '24 sept.');
  assert.equal(rows[0].messageMatch.time, '10:30');
  rows = listApplicants(db, new URLSearchParams({ messageQuery: 'hospital', status: 'favorites' }));
  assert.deepEqual(rows.map(row => row.conversation_id), ['101']);
  rows = listApplicants(db, new URLSearchParams({ messageQuery: '%_' }));
  assert.deepEqual(rows.map(row => row.conversation_id), ['102']);
  assert.equal(rows[0].messageMatch.author, 'Propietario');
  rows = listApplicants(db, new URLSearchParams({ messageQuery: '   ' }));
  assert.equal(rows.length, 3);
  assert.throws(() => listApplicants(db, new URLSearchParams({ messageQuery: 'x'.repeat(501) })), /larga/);
  importConversation(db, fixture(103, { exportedAt: '2026-09-24T13:00:00.000Z', properties: property,
    messages: [message('Visita al hospital')] }), 'updated/103.json', '2026-09-24');
  rows = listApplicants(db, new URLSearchParams({ messageQuery: 'hospital' }));
  assert.deepEqual(rows.map(row => row.conversation_id).sort(), ['101', '102', '103']);
  assert.equal(rows.filter(row => row.conversation_id === '103').length, 1);
  const server = createServer(db);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await request(server, '/api/applicants?messageQuery=hospital');
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).items.map(row => row.conversation_id).sort(), ['101', '102', '103']);
  assert.equal((await request(server, `/api/applicants?messageQuery=${'x'.repeat(501)}`)).status, 400);
});

test('housing and manual applicant APIs keep filters, notes, and mutations scoped', async t => {
  const { db } = temporaryDb(t);
  add(db, 201, [], { messages: [{ sequence: 1, rawText: 'Hospital central' }] });
  const server = createServer(db, { today: () => '2026-09-24' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const json = { 'Content-Type': 'application/json' };
  const created = await request(server, '/api/properties', { method:'POST',headers:json,
    body:JSON.stringify({ title:'Segundo piso', address:'Otra calle', monthlyRentCents:120000,
      rentalSince:'2026-09-23',idealistaUrl:'https://idealista.com/inmueble/12345678' }) });
  assert.equal(created.status,201);
  const property = (await created.json()).property;
  assert.equal(property.idealistaId,'12345678');
  assert.equal(property.url,'https://www.idealista.com/inmueble/12345678/');
  assert.equal(property.monthlyRentCents,120000);
  assert.equal((await (await request(server,'/api/properties')).json()).properties.length,2);
  const duplicate = await request(server,'/api/properties',{method:'POST',headers:json,
    body:JSON.stringify({title:'Duplicado',rentalSince:'2026-09-23',idealistaUrl:property.url})});
  assert.equal(duplicate.status,409);
  const manual = await request(server,`/api/properties/${property.id}/applicants`,{method:'POST',headers:json,
    body:JSON.stringify({name:'Ana',phone:'600123456',email:'ana@example.test',peopleCount:2,
      hasChildren:null,hasPets:false,monthlyIncomeCents:250000,incomeScope:'grupo',notes:'Llamar'})});
  assert.equal(manual.status,201);
  const applicant = (await manual.json()).applicant;
  assert.match(applicant.applicant_id,/^manual:/);
  assert.equal(applicant.conversation_id,null);
  assert.equal(db.prepare('SELECT count(*) n FROM conversations').get().n,1);
  assert.equal((await (await request(server,`/api/properties/${property.id}/applicants?status=all`)).json()).counts.total,1);
  assert.equal((await (await request(server,'/api/properties/13579135/applicants?status=all')).json()).counts.total,1);
  assert.equal((await request(server,`/api/properties/13579135/applicants/${encodeURIComponent(applicant.applicant_id)}`)).status,404);
  assert.equal((await request(server,`/api/properties/13579135/applicants/${encodeURIComponent(applicant.applicant_id)}`,
    {method:'PATCH',headers:json,body:'{"notes":"wrong property"}'})).status,404);
  const changed = await request(server,`/api/properties/${property.id}/applicants/${encodeURIComponent(applicant.applicant_id)}`,
    {method:'PATCH',headers:json,body:JSON.stringify({name:'Ana Dos',hasChildren:true,notes:'  texto\nnuevo '})});
  assert.equal(changed.status,200);
  const detail = await request(server,`/api/properties/${property.id}/applicants/${encodeURIComponent(applicant.applicant_id)}`);
  assert.equal((await detail.json()).notes,'  texto\nnuevo ');
  assert.equal((await (await request(server,`/api/properties/${property.id}/applicants?messageQuery=hospital&status=all`)).json()).items.length,0);
  assert.equal((await (await request(server,'/api/properties/13579135/applicants?messageQuery=hospital&status=all')).json()).items.length,1);
  const sameName = await request(server,`/api/properties/${property.id}/applicants`,{method:'POST',headers:json,
    body:JSON.stringify({name:'Ana'})});
  assert.equal(sameName.status,201);
  assert.notEqual((await sameName.json()).applicant.applicant_id,applicant.applicant_id);
  assert.equal((await (await request(server,`/api/properties/${property.id}/applicants?status=all`)).json()).counts.total,2);
  assert.equal((await request(server,`/api/properties/${property.id}/sync`,{method:'GET'})).status,200);
  assert.equal((await request(server,`/api/properties/${property.id}`,{method:'PATCH',headers:json,
    body:JSON.stringify({idealistaUrl:null})})).status,200);
  assert.equal((await request(server,`/api/properties/${property.id}/sync`,{method:'POST',headers:json,body:'{}'})).status,422);
  const edited = await request(server,`/api/properties/${property.id}`,{method:'PATCH',headers:json,
    body:JSON.stringify({title:'Segundo editado',address:null,monthlyRentCents:null,rentalSince:'2026-09-22'})});
  assert.equal(edited.status,200);
  assert.deepEqual((await edited.json()).property,{...property,title:'Segundo editado',address:null,
    monthlyRentCents:null,rentalSince:'2026-09-22',idealistaId:null,url:null,syncEnabled:false,
    defaultIdealistaId:null,defaultIdealistaUrl:null});
  assert.equal((await (await request(server,`/api/properties/${property.id}`)).json()).property.title,'Segundo editado');
});

test('housing validation and imported chat identity never reparent existing data', t => {
  const { db } = temporaryDb(t);
  const second = createProperty(db,{title:'Dos',rentalSince:'2026-09-23',
    idealistaUrl:'https://www.idealista.com/inmueble/12345678/'},'2026-09-24');
  const data = fixture(301,{properties:[{url:second.url}]});
  importConversation(db,data,'second/301.json','2026-09-24',second.id);
  const secondApplicant = applicantDetail(db,'301',second.id).applicant_id;
  assert.equal(db.prepare('SELECT property_id FROM applicants WHERE id=?').get(secondApplicant).property_id,second.id);
  const metadata = {title:'Personalizado',address:'Calle guardada',monthlyRentCents:72500,rentalSince:'2026-09-22'};
  const updated = updateProperty(db,second.id,metadata,'2026-09-24');
  assert.equal(updated.id,second.id);
  importConversation(db,fixture(301,{exportedAt:'2026-09-24T14:00:00.000Z',
    properties:[{url:second.url}],messages:[...data.messages,{sequence:2,rawText:'Mensaje nuevo'}]}),
    'second/301-new.json','2026-09-24',second.id);
  assert.deepEqual(getProperty(db,second.id),{...second,...metadata});
  assert.equal(listApplicants(db,new URLSearchParams({status:'all'})).length,0);
  assert.equal(listApplicants(db,new URLSearchParams({status:'all'}),second.id).length,1);
  assert.equal(importConversation(db,fixture(301,{exportedAt:'2026-09-24T14:00:00.000Z'}),
    'default/301.json','2026-09-24','13579135'),true);
  assert.equal(applicantDetail(db,'301','13579135').source_idealista_id,'13579135');
  assert.equal(db.prepare('SELECT property_id FROM applicants WHERE id=?').get(secondApplicant).property_id,second.id);
  assert.throws(() => createProperty(db,{title:'Duplicado',rentalSince:'2026-09-23',
    idealistaUrl:second.url},'2026-09-24'),/ya está añadido/);
});

test('housing and manual fields reject invalid data without creating records', async t => {
  const { db } = temporaryDb(t);
  const server = createServer(db,{today:()=> '2026-09-24'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const json={'Content-Type':'application/json'};
  for(const payload of [
    {title:'',rentalSince:'2026-09-23'},
    {title:'Piso',rentalSince:'2026-02-30'},
    {title:'Piso',rentalSince:'2026-09-25'},
    {title:'Piso',rentalSince:'2026-09-23',monthlyRentCents:-1},
    {title:'Piso',rentalSince:'2026-09-23',idealistaUrl:'https://example.test/inmueble/1/'},
  ]) assert.equal((await request(server,'/api/properties',{method:'POST',headers:json,
    body:JSON.stringify(payload)})).status,400);
  const property=(await (await request(server,'/api/properties',{method:'POST',headers:json,
    body:JSON.stringify({title:'Manual',rentalSince:'2026-09-23'})})).json()).property;
  assert.equal(property.syncEnabled,false);
  for(const payload of [
    {name:' '},{name:'Persona',hasChildren:'unknown'},
    {name:'Persona',peopleCount:0},{name:'Persona',monthlyIncomeCents:-1},
    {name:'Persona',email:'not-an-email'},{name:'Persona',notes:'x'.repeat(10001)},
    {name:'Persona',unknown:true},
  ]) assert.equal((await request(server,`/api/properties/${property.id}/applicants`,{
    method:'POST',headers:json,body:JSON.stringify(payload)})).status,400);
  assert.equal(db.prepare('SELECT count(*) n FROM applicants WHERE property_id=?').get(property.id).n,0);
  add(db,303,[]);
  assert.equal((await request(server,'/api/properties/13579135/applicants/chat%3A303',{method:'PATCH',headers:json,
    body:JSON.stringify({name:'Manual override'})})).status,400);
  const changed=await request(server,'/api/properties/13579135',{method:'PATCH',headers:json,
    body:JSON.stringify({idealistaUrl:'https://www.idealista.com/inmueble/12345678/'})});
  assert.equal(changed.status,200);
  assert.equal((await changed.json()).property.defaultIdealistaId,'12345678');
});

test('CLI import reads legacy and property namespaces without duplicating or clearing flags', t => {
  const { db, filename } = temporaryDb(t);
  const root = path.join(path.dirname(filename),'exports');
  const legacy = path.join(root,'2026-09-23');
  const nested = path.join(root,'2026-09-24','property-12345678');
  mkdirSync(legacy,{recursive:true}); mkdirSync(nested,{recursive:true});
  const second = createProperty(db,{title:'Dos',rentalSince:'2026-09-23',
    idealistaUrl:'https://www.idealista.com/inmueble/12345678/'},'2026-09-24');
  writeFileSync(path.join(legacy,'401.json'),JSON.stringify(fixture(401)));
  writeFileSync(path.join(nested,'402.json'),JSON.stringify(fixture(402,{properties:[{url:second.url}],
    activityDate:'2026-09-23'})));
  assert.throws(()=>importExports(db,root),/explícitamente/);
  const mapping={periodByProperty:{[second.id]:second.activePeriodId}};
  assert.equal(importExports(db,root,mapping).imported,2);
  updateApplicant(db,'402',{favorite:true,notes:'Privado'},second.id);
  assert.equal(importExports(db,root,mapping).conversations,2);
  assert.equal(db.prepare('SELECT count(*) n FROM conversations').get().n,2);
  assert.deepEqual({ ...db.prepare('SELECT favorite,notes,property_id FROM applicants WHERE id=?')
    .get(applicantDetail(db,'402',second.id).applicant_id) },
    {favorite:1,notes:'Privado',property_id:second.id});
});

test('housing returns the latest chosen tenant scoped to its own closed search', t => {
  const {db}=temporaryDb(t);
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  assert.equal(getProperty(db).lastClosedPeriod,null);
  add(db,591,[]);
  const original=getOpenPeriod(db,'13579135');
  closePeriod(db,'13579135',original.id,'chat:591');
  const expected={id:original.id,chosenApplicantId:'chat:591',chosenApplicantName:'Solicitante 591'};
  assert.deepEqual(getProperty(db).lastClosedPeriod,expected);
  assert.deepEqual(listProperties(db).find(p=>p.id==='13579135').lastClosedPeriod,expected);
  const other=createProperty(db,{title:'Otra vivienda',rentalSince:today});
  const otherTenant=createManualApplicant(db,other.id,{name:'Otra persona'},other.activePeriodId);
  closePeriod(db,other.id,other.activePeriodId,otherTenant.applicant_id);
  const next=createPeriod(db,'13579135',{rentalSince:today},today);
  assert.equal(getProperty(db).activePeriodId,next.id);
  assert.deepEqual(getProperty(db).lastClosedPeriod,expected);
  const tenant=createManualApplicant(db,'13579135',{name:'Inquilino más reciente'},next.id);
  closePeriod(db,'13579135',next.id,tenant.applicant_id);
  assert.deepEqual(getProperty(db).lastClosedPeriod,{id:next.id,
    chosenApplicantId:tenant.applicant_id,chosenApplicantName:'Inquilino más reciente'});
  assert.equal(listProperties(db).find(p=>p.id===other.id).lastClosedPeriod.chosenApplicantName,'Otra persona');
  assert.equal(getPeriod(db,'13579135',original.id).chosenApplicantName,'Solicitante 591');
});

test('reopening clears the choice and keeps the same search, messages and private state', async t => {
  const {db}=temporaryDb(t);
  add(db,601,[]);add(db,602,[]);
  updateApplicant(db,'601',{favorite:true,notes:'Nota conservada'});
  updateApplicant(db,'602',{discarded:true});
  const original=getOpenPeriod(db,'13579135'),boundary=periodActivityStartsAt(db,original);
  closePeriod(db,'13579135',original.id,'chat:601');
  const saved=()=>JSON.stringify(['applicants','conversations','messages','profile_fields','visits']
    .map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  const before=saved();
  const server=createServer(db);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`/api/properties/13579135/periods/${encodeURIComponent(original.id)}/reopen`;
  const post={method:'POST',headers:{'Content-Type':'application/json'},body:'{}'};
  assert.equal((await request(server,url,{...post,headers:{...post.headers,Origin:'http://evil.example'}})).status,403);
  for(const body of ['null','[]','{"chosenApplicantId":"chat:602"}','{'])
    assert.equal((await request(server,url,{...post,body})).status,400);
  assert.equal(getPeriod(db,'13579135',original.id).status,'closed');
  const response=await request(server,url,post);
  assert.equal(response.status,200);
  const reopened=(await response.json()).period;
  assert.deepEqual(reopened,{...original,status:'open',chosenApplicantId:null,chosenApplicantName:null,
    closedAt:null,housingTitle:null,housingAddress:null});
  assert.equal(periodActivityStartsAt(db,reopened),boundary);
  assert.equal(saved(),before);
  assert.equal(getProperty(db).activePeriodId,original.id);
  assert.equal(getProperty(db).lastClosedPeriod,null);
  assert.equal(listPeriods(db,'13579135').length,1);
  assert.equal((await request(server,url,post)).status,409);
  assert.equal((await request(server,url.replace('13579135','unknown'),post)).status,404);
  assert.equal((await request(server,url.replace(encodeURIComponent(original.id),'unknown'),post)).status,404);
  updateApplicant(db,'601',{notes:'Se puede editar de nuevo'});
  closePeriod(db,'13579135',original.id,'chat:602');
  assert.equal(getPeriod(db,'13579135',original.id).chosenApplicantName,'Solicitante 602');
});

test('reopening cannot cross later searches, deleted housing or conflicting listing ownership', t => {
  const {db}=temporaryDb(t);
  add(db,611,[]);
  const original=getOpenPeriod(db,'13579135');
  closePeriod(db,'13579135',original.id,'chat:611');
  updateProperty(db,'13579135',{idealistaUrl:null});
  const other=createProperty(db,{title:'Otra vivienda',rentalSince:'2026-09-23',
    idealistaUrl:original.url});
  assert.throws(()=>reopenPeriod(db,other.id,original.id),{code:'PERIOD_NOT_FOUND'});
  assert.throws(()=>reopenPeriod(db,'13579135',original.id),{code:'DUPLICATE_PROPERTY'});
  assert.equal(getPeriod(db,'13579135',original.id).chosenApplicantId,'chat:611');
  assert.equal(getProperty(db).defaultIdealistaId,null);
  updateProperty(db,other.id,{idealistaUrl:null});
  reopenPeriod(db,'13579135',original.id);
  assert.equal(getProperty(db).defaultIdealistaUrl,original.url);
  closePeriod(db,'13579135',original.id,'chat:611');
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const next=createPeriod(db,'13579135',{rentalSince:today},today);
  assert.throws(()=>reopenPeriod(db,'13579135',original.id),{code:'PERIOD_OPEN'});
  const selected=createManualApplicant(db,'13579135',{name:'Otra elección'},next.id);
  closePeriod(db,'13579135',next.id,selected.applicant_id);
  assert.throws(()=>reopenPeriod(db,'13579135',original.id),{code:'PERIOD_NOT_LATEST'});
  const boundary=periodActivityStartsAt(db,next);
  const latest=reopenPeriod(db,'13579135',next.id);
  assert.equal(periodActivityStartsAt(db,latest),boundary);
  assert.equal(getPeriod(db,'13579135',original.id).chosenApplicantId,'chat:611');
  closePeriod(db,'13579135',next.id,selected.applicant_id);
  deleteProperty(db,'13579135');
  assert.throws(()=>reopenPeriod(db,'13579135',next.id),{code:'PROPERTY_NOT_FOUND'});
  assert.equal(getPeriod(db,'13579135',next.id).status,'closed');
});

test('closed search period preserves history and reused chat starts independent data', async t => {
  const {db}=temporaryDb(t);
  add(db,501,[]);
  updateApplicant(db,'501',{favorite:true,notes:'Histórico'});
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Madrid',year:'numeric',
    month:'2-digit',day:'2-digit'}).format(new Date());
  const server=createServer(db,{today:()=>today});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const root='/api/properties/13579135/periods';
  const json={'Content-Type':'application/json'};
  const original=getOpenPeriod(db,'13579135');
  let response=await request(server,`${root}/${encodeURIComponent(original.id)}/close`,{
    method:'POST',headers:json,body:JSON.stringify({chosenApplicantId:'chat:501'})});
  assert.equal(response.status,200);
  const closed=(await response.json()).period;
  assert.equal(closed.status,'closed');
  assert.equal(closed.chosenApplicantName,'Solicitante 501');
  assert.equal(closed.housingTitle,'Piso de prueba');
  assert.equal(getProperty(db).activePeriodId,null);
  const home=(await (await request(server,'/api/properties')).json()).properties;
  assert.deepEqual(home.find(p=>p.id==='13579135').lastClosedPeriod,
    {id:original.id,chosenApplicantId:'chat:501',chosenApplicantName:'Solicitante 501'});
  assert.equal((await request(server,`${root}/${encodeURIComponent(original.id)}/applicants?status=all`)).status,200);
  assert.equal((await request(server,`${root}/${encodeURIComponent(original.id)}/applicants/chat%3A501`,{
    method:'PATCH',headers:json,body:'{"notes":"changed"}'})).status,409);
  assert.equal((await request(server,`${root}/${encodeURIComponent(original.id)}/sync`,{
    method:'POST',headers:json,body:'{}'})).status,409);
  response=await request(server,root,{method:'POST',headers:json,
    body:JSON.stringify({rentalSince:today,monthlyRentCents:90000,
      idealistaUrl:'https://www.idealista.com/inmueble/13579135/'})});
  assert.equal(response.status,201);
  const next=(await response.json()).period;
  assert.equal(next.status,'open');
  assert.notEqual(next.id,original.id);
  assert.equal(listApplicants(db,new URLSearchParams({status:'all'})).length,0);
  const boundary=periodActivityStartsAt(db,next);
  const after=new Date(Math.floor(Date.parse(boundary)/60000)*60000+120000).toISOString();
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit'})
    .format(new Date(after));
  const old=fxtureMessage('Anterior','2026-09-23','2026-09-23T08:00:00.000Z',1);
  const fresh=fxtureMessage('Nuevo periodo',day,after,2);
  importConversation(db,fixture(501,{activityDate:day,exportedAt:after,messages:[old,fresh]}),
    'new/501.json',day,'13579135',next.id);
  const newer=listApplicants(db,new URLSearchParams({status:'all'}),'13579135',next.id);
  assert.equal(newer.length,1);
  assert.notEqual(newer[0].applicant_id,'chat:501');
  assert.equal(newer[0].favorite,0);
  assert.equal(newer[0].notes,'');
  assert.equal(applicantDetail(db,newer[0].applicant_id,'13579135',next.id).messages.length,1);
  assert.equal(newer[0].messageCount,1);
  assert.equal(listApplicants(db,new URLSearchParams({status:'all'}),'13579135',original.id)[0].messageCount,1);
  assert.equal(applicantDetail(db,'chat:501','13579135',next.id),null);
  assert.equal(applicantDetail(db,'chat:501','13579135',original.id).notes,'Histórico');
  const nextDay=new Date(Date.parse(`${day}T00:00:00.000Z`)+86400000).toISOString().slice(0,10);
  const nextDayAt=`${nextDay}T08:00:00.000Z`;
  const tomorrow=fxtureMessage('Fuera de la ventana',nextDay,nextDayAt,2);
  importConversation(db,fixture(502,{activityDate:day,exportedAt:nextDayAt,
    messages:[fresh,tomorrow]}),
    'run-next-day/502.json',nextDay,'13579135',next.id,day);
  assert.equal(applicantDetail(db,'502','13579135',next.id).messages.length,1);
  assert.equal(listPeriods(db,'13579135').length,2);
  assert.equal(getPeriod(db,'13579135',original.id).chosenApplicantId,'chat:501');
});

function fxtureMessage(rawText,messageDate,occurredAt,sequence) {
  const time=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Madrid',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})
    .format(new Date(occurredAt));
  return {sequence,rawText,text:rawText,author:'Solicitante',direction:'incoming',
    messageDate,occurredAt,dateLabel:messageDate,time};
}

test('period cutoff uses Madrid midnight on both daylight saving transitions', t => {
  const {db}=temporaryDb(t);
  const base={propertyId:'13579135',createdAt:'2026-01-01T00:00:00.000Z'};
  assert.equal(periodActivityStartsAt(db,{...base,rentalSince:'2026-03-29'}),
    '2026-03-28T23:00:00.000Z');
  assert.equal(periodActivityStartsAt(db,{...base,rentalSince:'2026-10-25'}),
    '2026-10-24T22:00:00.000Z');
});

test('changing an imported listing keeps old chat source and separates the same external chat on the new listing', t => {
  const {db}=temporaryDb(t);
  const oldUrl='https://www.idealista.com/inmueble/13579135/';
  const newUrl='https://www.idealista.com/inmueble/12345678/';
  importConversation(db,fixture(901,{properties:[{url:oldUrl}],messages:[
    fxtureMessage('Mensaje del anuncio antiguo','2026-09-23','2026-09-23T08:00:00.000Z',1)]}),
    'old/901.json','2026-09-23');
  updateApplicant(db,'901',{favorite:true,notes:'Nota antigua'});
  const changed=updateProperty(db,'13579135',{idealistaUrl:newUrl},'2026-09-24');
  assert.equal(changed.idealistaId,'12345678');
  assert.equal(changed.defaultIdealistaUrl,newUrl);
  assert.equal(getPeriod(db,'13579135',changed.activePeriodId).idealistaId,'12345678');
  importConversation(db,fixture(901,{properties:[{url:newUrl}],exportedAt:'2026-09-24T11:00:00.000Z',
    messages:[fxtureMessage('Mensaje del anuncio nuevo','2026-09-23','2026-09-23T09:00:00.000Z',1)]}),
    'new/901.json','2026-09-24');
  const chats=db.prepare('SELECT id,applicant_id,source_idealista_id FROM conversations WHERE external_chat_id=? ORDER BY source_idealista_id').all('901');
  assert.equal(chats.length,2);
  assert.notEqual(chats[0].id,chats[1].id);
  assert.equal(chats[0].source_idealista_id,'12345678');
  assert.equal(chats[1].source_idealista_id,'13579135');
  assert.equal(db.prepare('SELECT favorite,notes FROM applicants WHERE id=?').get(chats[1].applicant_id).notes,'Nota antigua');
  assert.deepEqual({ ...db.prepare('SELECT favorite,notes FROM applicants WHERE id=?').get(chats[0].applicant_id) },
    {favorite:0,notes:''});
  assert.equal(listApplicants(db,new URLSearchParams({status:'all',messageQuery:'antiguo'})).length,1);
  assert.equal(listApplicants(db,new URLSearchParams({status:'all',messageQuery:'nuevo'})).length,1);
  assert.equal(applicantDetail(db,'901'),null);
  updateProperty(db,'13579135',{idealistaUrl:oldUrl},'2026-09-24');
  importConversation(db,fixture(901,{properties:[{url:oldUrl}],exportedAt:'2026-09-25T11:00:00.000Z',
    messages:[fxtureMessage('Mensaje del anuncio antiguo','2026-09-23','2026-09-23T08:00:00.000Z',1),
      fxtureMessage('Actualización antigua','2026-09-24','2026-09-24T08:00:00.000Z',2)]}),
    'old/901-updated.json','2026-09-24');
  assert.equal(db.prepare('SELECT count(*) n FROM messages WHERE conversation_id=?').get(chats[1].id).n,2);
  assert.equal(db.prepare('SELECT count(*) n FROM messages WHERE conversation_id=?').get(chats[0].id).n,1);
  const sourceCounts=Object.fromEntries(listApplicants(db,new URLSearchParams({status:'all'}))
    .map(item=>[item.source_idealista_id,item.messageCount]));
  assert.deepEqual(sourceCounts,{'13579135':2,'12345678':1});
  for(const item of listApplicants(db,new URLSearchParams({status:'all'})))
    assert.equal(item.messageCount,applicantDetail(db,item.applicant_id).messages.length);
  updateApplicant(db,chats[0].applicant_id,{notes:'Otra nota privada'});
  assert.equal(listApplicants(db,new URLSearchParams({status:'all'}))
    .find(item=>item.applicant_id===chats[0].applicant_id).messageCount,1);
  assert.deepEqual({ ...db.prepare('SELECT favorite,notes FROM applicants WHERE id=?').get(chats[1].applicant_id) },
    {favorite:1,notes:'Nota antigua'});
});

test('recoverable housing deletion hides every route and restores exact periods and private state', async t => {
  const {db}=temporaryDb(t);
  add(db,902,[]);
  updateApplicant(db,'902',{favorite:true,notes:'Se conserva'});
  const second=createProperty(db,{title:'Otra vivienda',rentalSince:'2026-09-23'},'2026-09-24');
  const server=createServer(db,{today:()=> '2026-09-24'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const firstId='13579135',periodId='initial:13579135';
  let response=await request(server,`/api/properties/${firstId}`,{method:'DELETE'});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{deleted:true,id:firstId});
  assert.equal((await request(server,`/api/properties/${firstId}`,{method:'DELETE'})).status,200);
  response=await request(server,'/api/properties');
  assert.equal((await response.json()).properties.length,1);
  response=await request(server,'/api/properties?status=deleted');
  const deleted=await response.json();
  assert.equal(deleted.supportsDeletedProperties,true);
  assert.equal(deleted.properties.length,1);
  assert.equal(deleted.properties[0].deletedAt!==null,true);
  assert.equal((await request(server,`/api/properties/${firstId}`)).status,404);
  assert.equal((await request(server,`/api/properties/${firstId}/periods`)).status,404);
  assert.equal((await request(server,`/api/properties/${firstId}/applicants`)).status,404);
  assert.equal((await request(server,`/api/properties/${firstId}/sync`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,404);
  assert.equal((await request(server,'/api/applicants')).status,404);
  assert.throws(()=>importConversation(db,fixture(903),'deleted/903.json','2026-09-23',firstId),/corresponde/);
  assert.equal(getPeriod(db,firstId,periodId).status,'open');
  const json={'Content-Type':'application/json'};
  const contender=await request(server,'/api/properties',{method:'POST',headers:json,
    body:JSON.stringify({title:'Nuevo anuncio',rentalSince:'2026-09-23',
      idealistaUrl:'https://www.idealista.com/inmueble/13579135/'})});
  assert.equal(contender.status,201);
  assert.equal((await request(server,`/api/properties/${firstId}/restore`,{method:'POST',headers:json,body:'{}'})).status,409);
  const contenderId=(await contender.json()).property.id;
  assert.equal((await request(server,`/api/properties/${contenderId}`,{method:'DELETE'})).status,200);
  const restored=await request(server,`/api/properties/${firstId}/restore`,{method:'POST',headers:json,body:'{}'});
  assert.equal(restored.status,200);
  assert.equal((await restored.json()).property.defaultIdealistaId,'13579135');
  assert.equal(applicantDetail(db,'902').notes,'Se conserva');
  assert.equal(applicantDetail(db,'902').favorite,1);
  assert.equal(getPeriod(db,firstId,periodId).status,'open');
  assert.equal(getProperty(db,second.id).id,second.id);
});

test('archive replay keeps historical source after URL change and never routes by current default', t => {
  const {db,filename}=temporaryDb(t);
  const root=path.join(path.dirname(filename),'archive');
  const old='https://www.idealista.com/inmueble/13579135/';
  const newer='https://www.idealista.com/inmueble/12345678/';
  const oldFolder=path.join(root,'2026-09-24','property-13579135');
  mkdirSync(oldFolder,{recursive:true});
  const saved=fixture(915,{properties:[{url:old}],exportedAt:'2026-09-24T10:00:00.000Z'});
  importConversation(db,saved,'live/915.json','2026-09-24');
  updateProperty(db,'13579135',{idealistaUrl:newer},'2026-09-24');
  writeFileSync(path.join(oldFolder,'915.json'),JSON.stringify({...saved,
    exportedAt:'2026-09-23T10:00:00.000Z',messages:[fxtureMessage('Antiguo','2026-09-23','2026-09-23T08:00:00.000Z',1)]}));
  assert.equal(importExports(db,root).imported,0);
  assert.equal(db.prepare('SELECT raw_text FROM messages WHERE conversation_id=?').get('915').raw_text,'Hola');
  const refreshed={...saved,exportedAt:'2026-09-25T10:00:00.000Z',messages:[...saved.messages,
    fxtureMessage('Actualización guardada','2026-09-24','2026-09-24T08:00:00.000Z',2)]};
  writeFileSync(path.join(oldFolder,'915.json'),JSON.stringify(refreshed));
  assert.equal(importExports(db,root).imported,1);
  assert.equal(db.prepare('SELECT count(*) n FROM messages WHERE conversation_id=?').get('915').n,2);
  assert.equal(db.prepare('SELECT source_idealista_id FROM conversations WHERE id=?').get('915')
    .source_idealista_id,'13579135');
  assert.equal(getProperty(db).idealistaId,'12345678');
  const second=createProperty(db,{title:'Vivienda UUID',rentalSince:'2026-09-23',
    idealistaUrl:'https://www.idealista.com/inmueble/44444444/'},'2026-09-24');
  const secondFolder=path.join(root,'2026-09-25','property-44444444');
  mkdirSync(secondFolder,{recursive:true});
  const secondData=fixture(916,{properties:[{url:'https://www.idealista.com/inmueble/44444444/'}]});
  importConversation(db,secondData,'live/916.json','2026-09-24',second.id);
  updateProperty(db,second.id,{idealistaUrl:'https://www.idealista.com/inmueble/55555555/'},'2026-09-24');
  writeFileSync(path.join(secondFolder,'916.json'),JSON.stringify({...secondData,
    exportedAt:'2026-09-22T10:00:00.000Z'}));
  assert.throws(()=>importExports(db,root),/explícitamente/);
  assert.equal(importExports(db,root,{periodByProperty:{[second.id]:second.activePeriodId}}).imported,0);
  assert.equal(db.prepare('SELECT source_idealista_id FROM conversations WHERE external_chat_id=?').get('916')
    .source_idealista_id,'44444444');
});

test('confirmed permanent purge removes only deleted housing and tombstones prevent replay after restart', async t => {
  const {db,filename}=temporaryDb(t);
  const second=createProperty(db,{title:'Se conserva',rentalSince:'2026-09-23'},'2026-09-24');
  const secondManual=createManualApplicant(db,second.id,{name:'Ajeno',notes:'Intacto'});
  add(db,917,[]);
  updateApplicant(db,'917',{favorite:true,notes:'Borrar'});
  createManualApplicant(db,'13579135',{name:'Manual borrar',notes:'Borrar'});
  updateProperty(db,'13579135',{idealistaUrl:'https://www.idealista.com/inmueble/22222222/'},'2026-09-24');
  updateProperty(db,'13579135',{idealistaUrl:'https://www.idealista.com/inmueble/33333333/'},'2026-09-24');
  assert.deepEqual(db.prepare('SELECT idealista_id FROM property_listing_history WHERE property_id=? ORDER BY idealista_id')
    .all('13579135').map(row=>row.idealista_id),['13579135','22222222','33333333']);
  const source=path.join(path.dirname(filename),'archive','2026-09-23','property-13579135');
  mkdirSync(source,{recursive:true});
  writeFileSync(path.join(source,'917.json'),JSON.stringify(fixture(917)));
  const middle=path.join(path.dirname(filename),'archive','2026-09-24','property-22222222');
  mkdirSync(middle,{recursive:true});
  writeFileSync(path.join(middle,'918.json'),JSON.stringify(fixture(918,{properties:[{
    url:'https://www.idealista.com/inmueble/22222222/'}]})));
  const server=createServer(db,{today:()=> '2026-09-24'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const endpoint='/api/properties/13579135/permanent',json={'Content-Type':'application/json'};
  const confirmation=JSON.stringify({confirmPropertyId:'13579135'});
  assert.equal((await request(server,endpoint,{method:'DELETE',headers:json,body:confirmation})).status,409);
  assert.equal((await request(server,'/api/properties/13579135',{method:'DELETE'})).status,200);
  assert.equal((await request(server,endpoint,{method:'DELETE',headers:json,
    body:JSON.stringify({confirmPropertyId:'wrong'})})).status,400);
  assert.equal((await request(server,endpoint,{method:'DELETE',headers:{...json,Origin:'http://evil.example'},
    body:confirmation})).status,403);
  const purged=await request(server,endpoint,{method:'DELETE',headers:json,body:confirmation});
  assert.equal(purged.status,200);
  assert.deepEqual(await purged.json(),{purged:true,id:'13579135'});
  for(const table of ['properties','search_periods','applicants','conversations','messages','profile_fields']){
    const count=db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
    assert.equal(count,table==='properties'||table==='search_periods'||table==='applicants'?1:0);
  }
  assert.equal(db.prepare('SELECT count(*) n FROM property_settings WHERE id=?').get('13579135').n,0);
  assert.equal(db.prepare('SELECT count(*) n FROM purged_properties WHERE id=?').get('13579135').n,1);
  assert.equal(db.prepare('SELECT count(*) n FROM purged_periods WHERE id=?').get('initial:13579135').n,1);
  assert.equal(db.prepare('SELECT count(*) n FROM purged_export_sources WHERE property_id=?').get('13579135').n,3);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
  assert.equal((await request(server,'/api/properties/13579135/restore',{method:'POST',headers:json,body:'{}'})).status,404);
  assert.equal(db.prepare('SELECT notes FROM applicants WHERE id=?').get(secondManual.applicant_id).notes,'Intacto');
  db.close();
  const reopened=openDatabase(filename);
  assert.equal(getProperty(reopened,'13579135'),null);
  assert.equal(reopened.prepare('SELECT count(*) n FROM property_settings WHERE id=?').get('13579135').n,0);
  assert.throws(()=>importExports(reopened,path.join(path.dirname(filename),'archive')),/eliminad/);
  assert.throws(()=>importConversation(reopened,fixture(917),'old/917.json','2026-09-23'),/eliminad/);
  assert.throws(()=>importConversation(reopened,fixture(918,{properties:[{
    url:'https://www.idealista.com/inmueble/22222222/'}]}),'middle/918.json','2026-09-24'),/eliminad/);
  const fresh=createProperty(reopened,{title:'Nueva vivienda',rentalSince:'2026-09-23',
    idealistaUrl:'https://www.idealista.com/inmueble/13579135/'},'2026-09-24');
  assert.ok(fresh.id!== '13579135');
  assert.throws(()=>importExports(reopened,path.join(path.dirname(filename),'archive')),/eliminad/);
  reopened.close();
});
