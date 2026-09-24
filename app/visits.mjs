import { createHash, randomUUID } from 'node:crypto';
import { normalizeTimeZone, localTimeCandidates, civilDayBounds, addCivilDays }
  from './public/visit-time.mjs';

const ZONE='Europe/Madrid';
const ACTIVE=new Set(['pending_confirmation','confirmed']);
const STATUSES=new Set([...ACTIVE,'completed','cancelled']);
const fail=(message,status=400,code)=>{ throw Object.assign(new Error(message),{status,code}); };

function zone(value) {
  try { return normalizeTimeZone(value); }
  catch { fail('Zona horaria no válida'); }
}

function localInstant(value,timezone,offset) {
  let matches;
  try { matches=localTimeCandidates(value,timezone); }
  catch { fail('Fecha de visita no válida'); }
  if(offset!==undefined) {
    if(!Number.isInteger(offset)||offset < -840||offset > 840)
      fail('Desplazamiento UTC no válido');
    matches=matches.filter(item=>item.utcOffsetMinutes===offset);
  }
  if(!matches.length) fail('La hora local no existe o el desplazamiento UTC no coincide');
  if(matches.length>1) fail('Indica el desplazamiento UTC para esta hora ambigua');
  return matches[0].instant;
}

const fields=`v.*,a.display_name AS applicant_name,p.title AS property_title`;
const joins=`FROM visits v JOIN applicants a ON a.id=v.applicant_id
  JOIN properties p ON p.id=v.property_id`;
function visit(row) {
  if(!row) return null;
  return {id:row.id,propertyId:row.property_id,periodId:row.period_id,
    applicantId:row.applicant_id,applicantName:row.applicant_name,propertyTitle:row.property_title,
    startsAt:row.starts_at,endsAt:row.ends_at,timezone:row.timezone,
    durationMinutes:(Date.parse(row.ends_at)-Date.parse(row.starts_at))/60000,
    status:row.status,createdAt:row.created_at,updatedAt:row.updated_at};
}

export function getVisit(db,id) {
  return visit(db.prepare(`SELECT ${fields} ${joins} WHERE v.id=? AND p.deleted_at IS NULL`).get(id));
}

export function listApplicantVisits(db,propertyId,periodId,applicantId) {
  if(!db.prepare(`SELECT 1 FROM applicants a JOIN search_periods s ON s.id=a.period_id
    JOIN properties p ON p.id=a.property_id WHERE a.id=? AND a.period_id=? AND a.property_id=?
    AND s.property_id=? AND p.deleted_at IS NULL`).get(applicantId,periodId,propertyId,propertyId))
    fail('Interesado no encontrado',404,'APPLICANT_NOT_FOUND');
  return db.prepare(`SELECT ${fields} ${joins} WHERE v.property_id=? AND v.period_id=?
    AND v.applicant_id=? ORDER BY v.starts_at,v.id`).all(propertyId,periodId,applicantId).map(visit);
}

export function listVisits(db,params) {
  const allowed=new Set(['from','to','propertyId','status','timezone']);
  if([...params.keys()].some(k=>!allowed.has(k))||params.getAll('from').length!==1||
    params.getAll('to').length!==1||[...allowed].some(k=>params.getAll(k).length>1))
    fail('Rango de fechas no válido');
  const from=params.get('from'),to=params.get('to');
  try { addCivilDays(from,0);addCivilDays(to,1); }
  catch { fail('Rango de fechas no válido'); }
  const fromDay=Date.parse(`${from}T00:00:00Z`),toDay=Date.parse(`${to}T00:00:00Z`);
  if(toDay<fromDay||(toDay-fromDay)/86400000>=366) fail('Rango de fechas no válido');
  const timezone=zone(params.get('timezone')??ZONE);
  let start,end;
  try { start=civilDayBounds(from,timezone).startsAt;end=civilDayBounds(to,timezone).endsAt; }
  catch { fail('Rango de fechas no válido'); }
  const propertyId=params.get('propertyId'),status=params.get('status');
  if(propertyId!==null&&!propertyId) fail('Vivienda no válida');
  if(status!==null&&!STATUSES.has(status)) fail('Estado no válido');
  if(start===end) return [];
  return db.prepare(`SELECT ${fields} ${joins} WHERE p.deleted_at IS NULL
    AND v.starts_at<? AND v.ends_at>? ${propertyId!==null?'AND v.property_id=?':''}
    ${status!==null?'AND v.status=?':''} ORDER BY v.starts_at,v.id`)
    .all(end,start,...(propertyId!==null?[propertyId]:[]),...(status!==null?[status]:[])).map(visit);
}

export function getCalendarSettings(db) {
  return {travelBufferMinutes:db.prepare('SELECT travel_buffer_minutes FROM calendar_settings WHERE id=1')
    .get().travel_buffer_minutes};
}

export function updateCalendarSettings(db,input) {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||
    !Number.isInteger(input.travelBufferMinutes)||
    input.travelBufferMinutes<0||input.travelBufferMinutes>180) fail('Ajustes de calendario no válidos');
  db.prepare('UPDATE calendar_settings SET travel_buffer_minutes=? WHERE id=1')
    .run(input.travelBufferMinutes);
  return getCalendarSettings(db);
}

function validatePayload(input,create) {
  const keys=new Set(['startLocal','utcOffsetMinutes','durationMinutes','status','timezone','acknowledgeConflicts']);
  if(!input||typeof input!=='object'||Array.isArray(input)||!Object.keys(input).length||
    Object.keys(input).some(k=>!keys.has(k))||
    (!create&&!['startLocal','durationMinutes','status'].some(k=>Object.hasOwn(input,k)))||
    (create&&!Object.hasOwn(input,'startLocal'))) fail('Datos de visita no válidos');
  if(Object.hasOwn(input,'durationMinutes')&&(!Number.isInteger(input.durationMinutes)||
    input.durationMinutes<5||input.durationMinutes>480)) fail('Duración no válida');
  if(Object.hasOwn(input,'status')&&!STATUSES.has(input.status)) fail('Estado no válido');
  if(Object.hasOwn(input,'utcOffsetMinutes')&&!Object.hasOwn(input,'startLocal'))
    fail('Fecha de visita requerida');
  if(Object.hasOwn(input,'timezone')) {
    zone(input.timezone);
    if(!create&&!Object.hasOwn(input,'startLocal')) fail('Fecha de visita requerida');
  }
  if(Object.hasOwn(input,'acknowledgeConflicts')&&input.acknowledgeConflicts!==null&&
    (typeof input.acknowledgeConflicts!=='string'||!/^sha256[0-9a-f]{64}$/.test(input.acknowledgeConflicts)))
    fail('Confirmación de conflictos no válida');
}

function assertOwner(db,propertyId,periodId,applicantId) {
  const row=db.prepare(`SELECT a.id,s.status,p.deleted_at FROM applicants a
    JOIN search_periods s ON s.id=a.period_id AND s.property_id=a.property_id
    JOIN properties p ON p.id=a.property_id
    WHERE a.id=? AND a.property_id=? AND a.period_id=?`).get(applicantId,propertyId,periodId);
  if(!row||row.deleted_at) fail('Interesado no encontrado',404,'APPLICANT_NOT_FOUND');
  if(row.status!=='open') fail('El periodo está cerrado',409,'PERIOD_CLOSED');
}

function conflictData(db,candidate,id,ack) {
  if(!ACTIVE.has(candidate.status)) return;
  const margin=getCalendarSettings(db).travelBufferMinutes;
  const rows=db.prepare(`SELECT ${fields} ${joins} WHERE p.deleted_at IS NULL AND v.id<>?
    AND v.status IN ('pending_confirmation','confirmed') AND
    ((v.property_id=? AND v.starts_at<? AND v.ends_at>?) OR
     (v.property_id<>? AND v.starts_at<? AND v.ends_at>?)) ORDER BY v.id`)
    .all(id||'',candidate.propertyId,candidate.endsAt,candidate.startsAt,candidate.propertyId,
      new Date(Date.parse(candidate.endsAt)+margin*60000).toISOString(),
      new Date(Date.parse(candidate.startsAt)-margin*60000).toISOString());
  if(!rows.length) return;
  const fingerprint='sha256'+createHash('sha256').update(JSON.stringify({
    candidate:{id:id||null,...candidate},margin,
    conflicts:rows.map(r=>({id:r.id,propertyId:r.property_id,startsAt:r.starts_at,
      endsAt:r.ends_at,status:r.status,updatedAt:r.updated_at}))})).digest('hex');
  if(ack===fingerprint) return;
  failConflict(rows,fingerprint);
}

function failConflict(rows,fingerprint) {
  throw Object.assign(new Error('La visita coincide con otra cita'),{status:409,code:'VISIT_CONFLICT',
    conflicts:rows.map(r=>({id:r.id,propertyId:r.property_id,propertyTitle:r.property_title,
      startsAt:r.starts_at,endsAt:r.ends_at})),conflictFingerprint:fingerprint});
}

function write(db,identity,input,id) {
  validatePayload(input,!id);
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing=id?getVisit(db,id):null;
    if(id&&!existing) fail('Visita no encontrada',404,'VISIT_NOT_FOUND');
    const owner=existing||identity;
    assertOwner(db,owner.propertyId,owner.periodId,owner.applicantId);
    const timezone=Object.hasOwn(input,'timezone')?zone(input.timezone):existing?.timezone??ZONE;
    const startsAt=Object.hasOwn(input,'startLocal')?
      localInstant(input.startLocal,timezone,input.utcOffsetMinutes):existing.startsAt;
    const durationMinutes=input.durationMinutes??existing?.durationMinutes??30;
    const endsAt=new Date(Date.parse(startsAt)+durationMinutes*60000).toISOString();
    const status=input.status??existing?.status??'pending_confirmation';
    conflictData(db,{propertyId:owner.propertyId,periodId:owner.periodId,
      applicantId:owner.applicantId,startsAt,endsAt,status,timezone},id,input.acknowledgeConflicts);
    const now=new Date().toISOString(),visitId=id||randomUUID();
    if(id) db.prepare(`UPDATE visits SET starts_at=?,ends_at=?,timezone=?,status=?,updated_at=? WHERE id=?`)
      .run(startsAt,endsAt,timezone,status,now,id);
    else db.prepare(`INSERT INTO visits(id,property_id,period_id,applicant_id,starts_at,ends_at,
      timezone,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(visitId,owner.propertyId,owner.periodId,owner.applicantId,startsAt,endsAt,timezone,status,now,now);
    db.exec('COMMIT');
    return getVisit(db,visitId);
  } catch(error) { db.exec('ROLLBACK'); throw error; }
}

export const createVisit=(db,propertyId,periodId,applicantId,input)=>
  write(db,{propertyId,periodId,applicantId},input,null);
export const updateVisit=(db,id,input)=>write(db,null,input,id);
