import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase, createProperty, createManualApplicant, deleteProperty,
  restoreProperty, purgeProperty, closePeriod, reopenPeriod } from '../app/database.mjs';
import { createVisit, updateVisit, getVisit, listVisits, listApplicantVisits,
  updateCalendarSettings } from '../app/visits.mjs';
import { normalizeTimeZone } from '../app/public/visit-time.mjs';

function setup(t) {
  const db=openDatabase(':memory:');
  t.after(()=>db.close());
  const make=(title)=>{
    const property=createProperty(db,{title,rentalSince:'2026-01-01'},'2026-09-24');
    const applicant=createManualApplicant(db,property.id,{name:`Interesado ${title}`});
    return {propertyId:property.id,periodId:property.activePeriodId,applicantId:applicant.applicant_id};
  };
  return {db,make};
}

const at=(startLocal,durationMinutes=30,extra={})=>({startLocal,durationMinutes,...extra});
const range=(from='2026-09-24',to=from,extra={})=>new URLSearchParams({from,to,...extra});

test('visits preserve identity, ownership and closed period protection',t=>{
  const {db,make}=setup(t),a=make('Primera'),b=make('Segunda');
  const one=createVisit(db,a.propertyId,a.periodId,a.applicantId,at('2027-09-24T10:00'));
  const two=createVisit(db,a.propertyId,a.periodId,a.applicantId,at('2027-09-24T11:00'));
  assert.notEqual(one.id,two.id);
  assert.equal(listApplicantVisits(db,a.propertyId,a.periodId,a.applicantId).length,2);
  assert.equal(updateVisit(db,one.id,at('2027-09-24T12:00')).id,one.id);
  assert.equal(getVisit(db,one.id).startsAt,'2027-09-24T10:00:00.000Z');
  assert.throws(()=>createVisit(db,b.propertyId,b.periodId,a.applicantId,at('2027-09-24T13:00')),
    {code:'APPLICANT_NOT_FOUND'});
  assert.throws(()=>db.prepare(`INSERT INTO visits
    (id,property_id,period_id,applicant_id,starts_at,ends_at,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run('wrong-owner',b.propertyId,b.periodId,a.applicantId,
    '2027-09-24T12:00:00.000Z','2027-09-24T12:30:00.000Z',
    'confirmed','2026-09-25T00:00:00.000Z','2026-09-25T00:00:00.000Z'),/FOREIGN KEY/);
  assert.throws(()=>closePeriod(db,a.propertyId,a.periodId,a.applicantId),{code:'UPCOMING_VISITS'});
  updateVisit(db,one.id,{status:'cancelled'});
  updateVisit(db,two.id,{status:'completed'});
  closePeriod(db,a.propertyId,a.periodId,a.applicantId);
  assert.throws(()=>updateVisit(db,one.id,{status:'confirmed'}),{code:'PERIOD_CLOSED'});
  assert.equal(listApplicantVisits(db,a.propertyId,a.periodId,a.applicantId).length,2);
  const saved=listApplicantVisits(db,a.propertyId,a.periodId,a.applicantId);
  reopenPeriod(db,a.propertyId,a.periodId);
  assert.deepEqual(listApplicantVisits(db,a.propertyId,a.periodId,a.applicantId),saved);
  assert.equal(updateVisit(db,one.id,{status:'confirmed'}).status,'confirmed');
});

test('local times validate spring gap, repeated hour and offset',t=>{
  const {db,make}=setup(t),a=make('Primera');
  assert.throws(()=>createVisit(db,a.propertyId,a.periodId,a.applicantId,at('2026-02-30T10:00')));
  assert.throws(()=>createVisit(db,a.propertyId,a.periodId,a.applicantId,at('2026-03-29T02:30')));
  assert.throws(()=>createVisit(db,a.propertyId,a.periodId,a.applicantId,at('2026-10-25T02:30')));
  assert.throws(()=>createVisit(db,a.propertyId,a.periodId,a.applicantId,
    at('2026-10-25T02:30',30,{utcOffsetMinutes:0})));
  const summer=createVisit(db,a.propertyId,a.periodId,a.applicantId,
    at('2026-10-25T02:30',30,{utcOffsetMinutes:120}));
  const winter=createVisit(db,a.propertyId,a.periodId,a.applicantId,
    at('2026-10-25T02:30',30,{utcOffsetMinutes:60}));
  assert.equal(summer.startsAt,'2026-10-25T00:30:00.000Z');
  assert.equal(winter.startsAt,'2026-10-25T01:30:00.000Z');
});

test('stored zones preserve UTC on edits and mixed-zone conflicts compare instants',t=>{
  const {db,make}=setup(t),a=make('Primera'),b=make('Segunda');
  assert.throws(()=>createVisit(db,a.propertyId,a.periodId,a.applicantId,
    at('2026-03-08T02:30',30,{timezone:'America/New_York'})));
  assert.throws(()=>createVisit(db,a.propertyId,a.periodId,a.applicantId,
    at('2026-11-01T01:30',30,{timezone:'America/New_York'})));
  const first=createVisit(db,a.propertyId,a.periodId,a.applicantId,
    at('2026-11-01T01:30',30,{timezone:'America/New_York',utcOffsetMinutes:-240}));
  assert.equal(first.startsAt,'2026-11-01T05:30:00.000Z');
  assert.equal(first.timezone,'America/New_York');
  assert.throws(()=>createVisit(db,b.propertyId,b.periodId,b.applicantId,
    at('2026-11-01T06:30',30,{timezone:'Europe/Madrid'})),{code:'VISIT_CONFLICT'});
  const statusOnly=updateVisit(db,first.id,{status:'confirmed'});
  assert.equal(statusOnly.startsAt,first.startsAt);
  assert.equal(statusOnly.timezone,first.timezone);
  assert.throws(()=>updateVisit(db,first.id,{timezone:'UTC'}));
  const utc=updateVisit(db,first.id,{timezone:'UTC',startLocal:'2026-11-01T05:30'});
  assert.equal(utc.id,first.id);
  assert.equal(utc.startsAt,first.startsAt);
  assert.equal(utc.timezone,'UTC');
  assert.throws(()=>updateVisit(db,first.id,{timezone:'Invalid/Zone',startLocal:'2026-11-01T05:30'}));
  assert.throws(()=>createVisit(db,a.propertyId,a.periodId,a.applicantId,
    at('2026-11-01T06:00',30,{timezone:'+01:00'})));
});

test('range uses selected civil timezone across local midnight and DST',t=>{
  const {db,make}=setup(t),a=make('Primera');
  const early=createVisit(db,a.propertyId,a.periodId,a.applicantId,
    at('2026-11-01T03:30',30,{timezone:'UTC',status:'completed'}));
  const later=createVisit(db,a.propertyId,a.periodId,a.applicantId,
    at('2026-11-01T06:30',30,{timezone:'UTC',status:'completed'}));
  assert.deepEqual(listVisits(db,range('2026-10-31','2026-10-31',
    {timezone:'America/New_York'})).map(v=>v.id),[early.id]);
  assert.deepEqual(listVisits(db,range('2026-11-01','2026-11-01',
    {timezone:'America/New_York'})).map(v=>v.id),[later.id]);
  const crossing=createVisit(db,a.propertyId,a.periodId,a.applicantId,
    at('2011-12-30T09:45',30,{timezone:'UTC',status:'completed'}));
  assert.ok(crossing.id);
  assert.equal(listVisits(db,range('2011-12-30','2011-12-30',
    {timezone:'Pacific/Apia'})).length,0);
  assert.throws(()=>listVisits(db,range('2026-11-01','2026-11-01',
    {timezone:'Invalid/Zone'})));
  assert.equal(listVisits(db,range('2026-11-01')).length,2,
    'legacy API defaults to Madrid civil dates');
});

test('global conflicts, margin, acknowledgements and inactive statuses',t=>{
  const {db,make}=setup(t),a=make('Primera'),b=make('Segunda');
  const first=createVisit(db,a.propertyId,a.periodId,a.applicantId,at('2026-09-24T10:00'));
  assert.throws(()=>createVisit(db,b.propertyId,b.periodId,b.applicantId,at('2026-09-24T10:15')),
    {code:'VISIT_CONFLICT'});
  const adjacent=createVisit(db,b.propertyId,b.periodId,b.applicantId,at('2026-09-24T10:30'));
  updateCalendarSettings(db,{travelBufferMinutes:15});
  let conflict;
  try { createVisit(db,b.propertyId,b.periodId,b.applicantId,at('2026-09-24T10:40')); }
  catch(error) { conflict=error; }
  assert.equal(conflict.code,'VISIT_CONFLICT');
  assert.equal(conflict.conflicts.length,2);
  const acknowledged=createVisit(db,b.propertyId,b.periodId,b.applicantId,
    at('2026-09-24T10:40',30,{acknowledgeConflicts:conflict.conflictFingerprint}));
  assert.ok(acknowledged.id);
  assert.throws(()=>createVisit(db,b.propertyId,b.periodId,b.applicantId,
    at('2026-09-24T10:40',30,{acknowledgeConflicts:conflict.conflictFingerprint})),
    {code:'VISIT_CONFLICT'});
  updateVisit(db,first.id,{status:'completed'});
  updateVisit(db,adjacent.id,{status:'cancelled'});
  assert.equal(getVisit(db,adjacent.id).status,'cancelled');
});

test('range overlap, filters, soft deletion, restoration and purge',t=>{
  const {db,make}=setup(t),a=make('Primera'),b=make('Segunda');
  const first=createVisit(db,a.propertyId,a.periodId,a.applicantId,at('2026-09-23T23:45',60));
  const second=createVisit(db,b.propertyId,b.periodId,b.applicantId,at('2026-09-24T11:00'));
  const cancelled=createVisit(db,a.propertyId,a.periodId,a.applicantId,
    at('2026-09-24T12:00',30,{status:'cancelled'}));
  assert.deepEqual(listVisits(db,range()).map(v=>v.id),[first.id,second.id,cancelled.id]);
  assert.deepEqual(listVisits(db,range('2026-09-24','2026-09-24',{status:'not_cancelled'})).map(v=>v.id),
    [first.id,second.id]);
  assert.equal(listVisits(db,range('2026-09-24','2026-09-24',{propertyId:b.propertyId})).length,1);
  assert.deepEqual(listVisits(db,range('2026-09-24','2026-09-24',{status:'cancelled'})).map(v=>v.id),[cancelled.id]);
  assert.throws(()=>listVisits(db,range('2026-01-01','2027-01-02')));
  assert.throws(()=>listVisits(db,range('2026-09-25','2026-09-24')));
  deleteProperty(db,a.propertyId);
  assert.equal(listVisits(db,range()).length,1);
  assert.equal(getVisit(db,first.id),null);
  restoreProperty(db,a.propertyId);
  assert.equal(listVisits(db,range()).length,3);
  deleteProperty(db,a.propertyId);
  purgeProperty(db,a.propertyId);
  assert.equal(db.prepare('SELECT count(*) AS n FROM visits WHERE id=?').get(first.id).n,0);
});

test('HTTP routes validate writes, expose settings and export private ICS',async t=>{
  const {createServer}=await import('../app/server.mjs');
  const {db,make}=setup(t),a=make('Vivienda de prueba');
  const server=createServer(db);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=(path,options={})=>fetch(base+path,options);
  const json={method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(at('2026-09-24T10:00'))};
  const scoped=`/api/properties/${a.propertyId}/periods/${a.periodId}/applicants/${encodeURIComponent(a.applicantId)}/visits`;
  let response=await request(scoped,{...json,headers:{...json.headers,Origin:'http://evil.example'}});
  assert.equal(response.status,403);
  response=await request(scoped,json);
  assert.equal(response.status,201);
  const created=await response.json();
  assert.equal(created.applicantName,'Interesado Vivienda de prueba');
  const b=make('Otra vivienda');
  const other=`/api/properties/${b.propertyId}/periods/${b.periodId}/applicants/${encodeURIComponent(b.applicantId)}/visits`;
  response=await request(other,json);
  assert.equal(response.status,409);
  const conflict=await response.json();
  assert.equal(conflict.code,'VISIT_CONFLICT');
  assert.equal(conflict.conflicts[0].id,created.id);
  assert.match(conflict.conflictFingerprint,/^sha256[0-9a-f]{64}$/);
  response=await request(other,{...json,body:JSON.stringify({...at('2026-09-24T10:00'),
    acknowledgeConflicts:conflict.conflictFingerprint})});
  assert.equal(response.status,201);
  response=await request(other,{...json,body:JSON.stringify(at('2026-09-25T10:00',30,
    {timezone:'UTC'}))});
  assert.equal(response.status,201);
  assert.equal((await response.json()).timezone,'UTC');
  response=await request(scoped,{...json,body:JSON.stringify(at('2026-09-24T14:00',30,
    {status:'cancelled'}))});
  assert.equal(response.status,201);
  const cancelled=await response.json();
  assert.equal((await (await request(scoped)).json()).visits.length,2);
  assert.equal((await (await request(`/api/visits?from=2026-09-24&to=2026-09-24`)).json()).visits.length,3,
    'an omitted status preserves calendar history');
  assert.equal((await (await request(`/api/visits?from=2026-09-24&to=2026-09-24&status=not_cancelled`)).json()).visits.length,2,
    'the read-only default-calendar filter excludes cancelled visits');
  assert.deepEqual((await (await request(`/api/visits?from=2026-09-24&to=2026-09-24&status=cancelled`)).json()).visits.map(visit=>visit.id),[cancelled.id]);
  response=await request(`/api/visits/${created.id}`,{method:'PATCH',headers:json.headers,
    body:JSON.stringify({status:'completed'})});
  assert.equal(response.status,200);
  response=await request('/api/calendar/settings',{method:'PATCH',headers:json.headers,
    body:JSON.stringify({travelBufferMinutes:20})});
  assert.deepEqual(await response.json(),{travelBufferMinutes:20});
  assert.equal((await request('/api/calendar/settings')).status,200);
  response=await request('/visit-time.mjs');
  assert.equal(response.status,200);
  assert.match(response.headers.get('content-type'),/^text\/javascript; charset=utf-8/);
  response=await request(`/api/visits/${created.id}.ics`);
  assert.equal(response.status,200);
  assert.match(response.headers.get('content-type'),/^text\/calendar; charset=utf-8/);
  assert.match(response.headers.get('content-disposition'),/^attachment/);
  assert.equal(response.headers.get('cache-control'),'no-store');
  const ics=await response.text();
  assert.match(ics,/BEGIN:VCALENDAR/);
  assert.doesNotMatch(ics,/Interesado Vivienda de prueba/);
  response=await request('/api/visits.ics?from=2026-09-24&to=2026-09-24');
  assert.equal(response.status,200);
  assert.match(await response.text(),/BEGIN:VCALENDAR/);
  response=await request('/api/visits.ics?from=2026-09-24&to=2026-09-24&status=not_cancelled');
  assert.equal(response.status,200);
  const filteredIcs=await response.text();
  assert.doesNotMatch(filteredIcs,new RegExp(`visita-${Buffer.from(cancelled.id).toString('base64url')}@morada\\.local`));
  assert.match(filteredIcs,/STATUS:(?:TENTATIVE|CONFIRMED)/);
  response=await request('/api/visits.ics?from=2026-09-24&to=2026-09-24&timezone=America%2FNew_York');
  assert.equal(response.status,200);
  assert.match(await response.text(),/BEGIN:VCALENDAR/);
  assert.equal((await request('/api/visits?from=bad&to=2026-09-24')).status,400);
  assert.equal((await request('/api/visits?from=2026-09-24&to=2026-09-24&timezone=Nope')).status,400);
  assert.equal((await request('/api/visits?from=2026-09-24&to=2026-09-24&status=all')).status,400);
  response=await request(scoped,{...json,body:JSON.stringify(at('2026-09-25T14:00',30,{status:'not_cancelled'}))});
  assert.equal(response.status,400,'the read-only filter is not a writable visit status');
});

test('Madrid-only visit table migrates atomically with identity, FKs and indexes intact',t=>{
  const directory=mkdtempSync(path.join(tmpdir(),'morada-visits-zone-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const filename=path.join(directory,'synthetic.sqlite');
  let db=openDatabase(filename);
  const property=createProperty(db,{title:'Vivienda sintética',rentalSince:'2026-01-01'},'2026-09-25');
  const applicant=createManualApplicant(db,property.id,{name:'Persona sintética'});
  const original=createVisit(db,property.id,property.activePeriodId,applicant.applicant_id,
    at('2026-09-25T10:00',45,{status:'confirmed'}));
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE visits_old (
      id TEXT PRIMARY KEY, property_id TEXT NOT NULL REFERENCES properties(id),
      period_id TEXT NOT NULL REFERENCES search_periods(id),
      applicant_id TEXT NOT NULL REFERENCES applicants(id),
      starts_at TEXT NOT NULL, ends_at TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'Europe/Madrid' CHECK(timezone='Europe/Madrid'),
      status TEXT NOT NULL CHECK(status IN ('pending_confirmation','confirmed','completed','cancelled')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY (period_id,property_id) REFERENCES search_periods(id,property_id),
      FOREIGN KEY (applicant_id,property_id,period_id) REFERENCES applicants(id,property_id,period_id),
      CHECK(ends_at>starts_at));
    INSERT INTO visits_old SELECT * FROM visits;
    DROP TABLE visits;
    ALTER TABLE visits_old RENAME TO visits;
    CREATE INDEX visits_period_applicant ON visits(property_id,period_id,applicant_id);
    CREATE INDEX visits_schedule ON visits(starts_at,ends_at,status);
    COMMIT;`);
  db.close();
  db=openDatabase(filename);
  t.after(()=>db.close());
  assert.deepEqual(getVisit(db,original.id),original);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name LIKE 'visits_%'").get().n,2);
  const changed=updateVisit(db,original.id,{timezone:'Asia/Kathmandu',startLocal:'2026-09-25T13:45'});
  assert.equal(changed.startsAt,original.startsAt);
  assert.equal(changed.timezone,normalizeTimeZone('Asia/Kathmandu'));
  db.close();
  db=openDatabase(filename);
  assert.equal(getVisit(db,original.id).timezone,normalizeTimeZone('Asia/Kathmandu'));
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
});
