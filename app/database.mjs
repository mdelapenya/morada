import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { importedArrival, manualArrival } from './arrival.mjs';
import { importedHasReplied, importedAwaitingReply } from './reply.mjs';
import { legacyProperty, DEFAULT_PROPERTY_ID } from './legacy-property.mjs';

export { DEFAULT_PROPERTY_ID };

function localDay() {
  const fields = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: 'Europe/Madrid',
    year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
    .filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function madridDate(instant) {
  const fields = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone:'Europe/Madrid',
    year:'numeric',month:'2-digit',day:'2-digit' }).formatToParts(new Date(instant))
    .filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

export function openDatabase(filename) {
  if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS applicants (
      id TEXT PRIMARY KEY, display_name TEXT NOT NULL, people_count INTEGER CHECK(people_count>0),
      has_children INTEGER CHECK(has_children IN (0,1)), has_pets INTEGER CHECK(has_pets IN (0,1)),
      monthly_income_cents INTEGER CHECK(monthly_income_cents>=0), income_scope TEXT,
      profile_status TEXT NOT NULL, profile_text TEXT, evidence_json TEXT NOT NULL,
      favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0,1)),
      discarded INTEGER NOT NULL DEFAULT 0 CHECK(discarded IN (0,1))
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, applicant_id TEXT NOT NULL REFERENCES applicants(id), property_url TEXT,
      activity_date TEXT NOT NULL, listed_time TEXT, exported_at TEXT NOT NULL,
      history_status TEXT NOT NULL, source_path TEXT NOT NULL, raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      conversation_id TEXT NOT NULL REFERENCES conversations(id), sequence INTEGER NOT NULL,
      author TEXT, direction TEXT, date_label TEXT, time_label TEXT, text TEXT, raw_text TEXT NOT NULL,
      PRIMARY KEY(conversation_id,sequence)
    );
    CREATE TABLE IF NOT EXISTS profile_fields (
      applicant_id TEXT NOT NULL REFERENCES applicants(id), sequence INTEGER NOT NULL, original_text TEXT NOT NULL,
      PRIMARY KEY(applicant_id,sequence)
    );
    CREATE TABLE IF NOT EXISTS property_settings (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, url TEXT NOT NULL,
      rental_since TEXT NOT NULL, date_confirmed INTEGER NOT NULL CHECK(date_confirmed IN (0,1))
    );
    CREATE TABLE IF NOT EXISTS properties (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, address TEXT, monthly_rent_cents INTEGER CHECK(monthly_rent_cents>=0),
      rental_since TEXT NOT NULL, idealista_id TEXT UNIQUE, url TEXT,
      date_confirmed INTEGER NOT NULL DEFAULT 1 CHECK(date_confirmed IN (0,1)),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS purged_properties (
      id TEXT PRIMARY KEY, purged_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS purged_periods (
      id TEXT PRIMARY KEY, property_id TEXT NOT NULL REFERENCES purged_properties(id)
    );
    CREATE TABLE IF NOT EXISTS purged_export_sources (
      idealista_id TEXT NOT NULL, property_id TEXT NOT NULL REFERENCES purged_properties(id),
      PRIMARY KEY(idealista_id,property_id)
    );
    CREATE TABLE IF NOT EXISTS property_listing_history (
      property_id TEXT NOT NULL REFERENCES properties(id), idealista_id TEXT NOT NULL,
      PRIMARY KEY(property_id,idealista_id)
    );`);
  const columns = db.prepare('PRAGMA table_info(applicants)').all().map(c => c.name);
  for (const column of ['favorite', 'discarded']) {
    if (!columns.includes(column)) db.exec(`ALTER TABLE applicants ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0 CHECK(${column} IN (0,1))`);
  }
  if (!columns.includes('notes')) db.exec("ALTER TABLE applicants ADD COLUMN notes TEXT NOT NULL DEFAULT ''");
  if (!columns.includes('property_id')) db.exec('ALTER TABLE applicants ADD COLUMN property_id TEXT REFERENCES properties(id)');
  if (!columns.includes('source')) db.exec("ALTER TABLE applicants ADD COLUMN source TEXT NOT NULL DEFAULT 'idealista'");
  if (!columns.includes('phone')) db.exec('ALTER TABLE applicants ADD COLUMN phone TEXT');
  if (!columns.includes('email')) db.exec('ALTER TABLE applicants ADD COLUMN email TEXT');
  if (!columns.includes('created_at')) db.exec('ALTER TABLE applicants ADD COLUMN created_at TEXT');
  if (!columns.includes('created_date')) db.exec('ALTER TABLE applicants ADD COLUMN created_date TEXT');
  const defaultWasPurged=Boolean(db.prepare('SELECT 1 FROM purged_properties WHERE id=?')
    .get(DEFAULT_PROPERTY_ID));
  if (legacyProperty && !defaultWasPurged) db.prepare(`INSERT OR IGNORE INTO property_settings
    (id,title,url,rental_since,date_confirmed) VALUES (?,?,?,?,?)`)
    .run(DEFAULT_PROPERTY_ID, legacyProperty.title, `https://www.idealista.com/inmueble/${DEFAULT_PROPERTY_ID}/`,
      legacyProperty.rentalSince, 1);
  db.exec('BEGIN');
  try {
    const legacy = defaultWasPurged ? null : db.prepare('SELECT * FROM property_settings WHERE id=?').get(DEFAULT_PROPERTY_ID);
    if (legacy) db.prepare(`INSERT OR IGNORE INTO properties
      (id,title,address,monthly_rent_cents,rental_since,idealista_id,url,date_confirmed,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(DEFAULT_PROPERTY_ID, legacy.title, null, legacyProperty?.monthlyRentCents ?? null,
      legacy.rental_since, DEFAULT_PROPERTY_ID, legacy.url, legacy.date_confirmed, new Date().toISOString());
    const pending = db.prepare(`SELECT a.id,c.property_url,c.raw_json,c.activity_date FROM applicants a
      LEFT JOIN conversations c ON c.applicant_id=a.id WHERE a.property_id IS NULL`).all();
    const assign = db.prepare('UPDATE applicants SET property_id=?,created_at=coalesce(created_at,?),created_date=coalesce(created_date,?) WHERE id=?');
    const insertOther = db.prepare(`INSERT OR IGNORE INTO properties
      (id,title,address,monthly_rent_cents,rental_since,idealista_id,url,date_confirmed,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    for (const row of pending) {
      const observed = extractIdealistaId(row.property_url) || (() => {
        try { return JSON.parse(row.raw_json).properties?.map(p => extractIdealistaId(p.url)).find(Boolean); }
        catch { return null; }
      })();
      const id = observed || 'legacy-unassigned';
      if (id !== DEFAULT_PROPERTY_ID) insertOther.run(id, observed ? `Anuncio ${id}` : 'Sin anuncio identificado',
        null, null, validIsoDate(row.activity_date) ? row.activity_date : localDay(),
        observed, observed ? canonicalIdealistaUrl(observed) : null, 0, new Date().toISOString());
      assign.run(id, new Date().toISOString(), row.activity_date || localDay(), row.id);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  const propertyColumns=db.prepare('PRAGMA table_info(properties)').all().map(c=>c.name);
  if (!propertyColumns.includes('deleted_at')) db.exec('ALTER TABLE properties ADD COLUMN deleted_at TEXT');
  if (!propertyColumns.includes('deleted_default_idealista_id'))
    db.exec('ALTER TABLE properties ADD COLUMN deleted_default_idealista_id TEXT');
  if (!propertyColumns.includes('deleted_default_url'))
    db.exec('ALTER TABLE properties ADD COLUMN deleted_default_url TEXT');
  migratePeriods(db);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS period_owner_key ON search_periods(id,property_id);
    CREATE UNIQUE INDEX IF NOT EXISTS applicant_owner_key ON applicants(id,property_id,period_id);`);
  migrateVisits(db);
  db.exec(`CREATE TABLE IF NOT EXISTS calendar_settings (
      id INTEGER PRIMARY KEY CHECK(id=1),
      travel_buffer_minutes INTEGER NOT NULL DEFAULT 0 CHECK(travel_buffer_minutes BETWEEN 0 AND 180));
    INSERT OR IGNORE INTO calendar_settings(id,travel_buffer_minutes) VALUES (1,0);`);
  db.exec(`CREATE TABLE IF NOT EXISTS sync_batches (
      period_id TEXT PRIMARY KEY REFERENCES search_periods(id) ON DELETE CASCADE,
      id TEXT NOT NULL, completed_at TEXT NOT NULL, new_count INTEGER NOT NULL,
      incoming_applicant_count INTEGER NOT NULL, incoming_message_count INTEGER NOT NULL,
      refreshed_count INTEGER NOT NULL,
      requested_mode TEXT, effective_mode TEXT, examined INTEGER,
      candidates INTEGER, early_stopped INTEGER, stop_reason TEXT,
      unchanged_streak INTEGER, unchanged_threshold INTEGER,
      full_coverage INTEGER, head_rechecked INTEGER
    );
    CREATE TABLE IF NOT EXISTS sync_source_baselines (
      period_id TEXT NOT NULL REFERENCES search_periods(id) ON DELETE CASCADE,
      source_idealista_id TEXT NOT NULL, since_date TEXT NOT NULL,
      activity_starts_at TEXT NOT NULL, include_legacy_history INTEGER NOT NULL,
      completed_at TEXT NOT NULL, batch_id TEXT NOT NULL,
      PRIMARY KEY(period_id,source_idealista_id)
    );
    CREATE TABLE IF NOT EXISTS sync_attention (
      applicant_id TEXT PRIMARY KEY REFERENCES applicants(id) ON DELETE CASCADE,
      period_id TEXT NOT NULL REFERENCES search_periods(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('new','message')),
      new_incoming_count INTEGER NOT NULL DEFAULT 0,
      revision TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sync_attention_period ON sync_attention(period_id);`);
  const batchColumns=new Set(db.prepare('PRAGMA table_info(sync_batches)').all().map(column=>column.name));
  for(const [name,type] of [['requested_mode','TEXT'],['effective_mode','TEXT'],['examined','INTEGER'],
    ['candidates','INTEGER'],['early_stopped','INTEGER'],['stop_reason','TEXT'],
    ['unchanged_streak','INTEGER'],['unchanged_threshold','INTEGER'],
    ['full_coverage','INTEGER'],['head_rechecked','INTEGER']])
    if(!batchColumns.has(name)) db.exec(`ALTER TABLE sync_batches ADD COLUMN ${name} ${type}`);
  db.exec(`CREATE INDEX IF NOT EXISTS applicants_filters ON applicants(discarded, favorite, has_children, has_pets, people_count, monthly_income_cents);
    CREATE INDEX IF NOT EXISTS applicants_property ON applicants(property_id,discarded,favorite);
    DROP VIEW IF EXISTS interested;
    CREATE VIEW interested AS SELECT c.id AS conversation_id,c.external_chat_id,c.source_idealista_id,
      a.id AS applicant_id,a.property_id,a.period_id,a.source,
      a.display_name AS name,coalesce(c.activity_date,a.created_date) AS activity_date,c.listed_time,
      a.people_count,a.has_children,a.has_pets,a.monthly_income_cents/100.0 AS monthly_income_eur,a.income_scope,
      a.profile_status,c.history_status,c.property_url,a.favorite,a.discarded,a.notes,a.phone,a.email,
      a.created_at,a.created_date
      FROM applicants a LEFT JOIN conversations c ON c.applicant_id=a.id;`);
  return db;
}

function visitsTableSql(name) {
  return `CREATE TABLE ${name} (
    id TEXT PRIMARY KEY, property_id TEXT NOT NULL REFERENCES properties(id),
    period_id TEXT NOT NULL REFERENCES search_periods(id),
    applicant_id TEXT NOT NULL REFERENCES applicants(id),
    starts_at TEXT NOT NULL, ends_at TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'Europe/Madrid',
    status TEXT NOT NULL CHECK(status IN ('pending_confirmation','confirmed','completed','cancelled')),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    FOREIGN KEY (period_id,property_id) REFERENCES search_periods(id,property_id),
    FOREIGN KEY (applicant_id,property_id,period_id)
      REFERENCES applicants(id,property_id,period_id),
    CHECK(ends_at>starts_at))`;
}

function migrateVisits(db) {
  const existing=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='visits'").get();
  const madridOnly=existing&&/CHECK\s*\(\s*timezone\s*=\s*'Europe\/Madrid'\s*\)/i.test(existing.sql);
  if(!existing) db.exec(visitsTableSql('visits'));
  else if(madridOnly) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(visitsTableSql('visits_zone_migration'));
      db.exec(`INSERT INTO visits_zone_migration
        (id,property_id,period_id,applicant_id,starts_at,ends_at,timezone,status,created_at,updated_at)
        SELECT id,property_id,period_id,applicant_id,starts_at,ends_at,timezone,status,created_at,updated_at
        FROM visits`);
      db.exec('DROP TABLE visits');
      db.exec('ALTER TABLE visits_zone_migration RENAME TO visits');
      db.exec(`CREATE INDEX visits_period_applicant ON visits(property_id,period_id,applicant_id);
        CREATE INDEX visits_schedule ON visits(starts_at,ends_at,status);`);
      if(db.prepare('PRAGMA foreign_key_check').all().length)
        throw new Error('La migración de visitas no conserva las referencias');
      db.exec('COMMIT');
    } catch(error) { db.exec('ROLLBACK'); throw error; }
  }
  db.exec(`CREATE INDEX IF NOT EXISTS visits_period_applicant ON visits(property_id,period_id,applicant_id);
    CREATE INDEX IF NOT EXISTS visits_schedule ON visits(starts_at,ends_at,status);`);
}

function migratePeriods(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS search_periods (
    id TEXT PRIMARY KEY, property_id TEXT NOT NULL REFERENCES properties(id),
    status TEXT NOT NULL CHECK(status IN ('open','closed')),
    rental_since TEXT NOT NULL, monthly_rent_cents INTEGER CHECK(monthly_rent_cents>=0),
    idealista_id TEXT, url TEXT, date_confirmed INTEGER NOT NULL CHECK(date_confirmed IN (0,1)),
    chosen_applicant_id TEXT REFERENCES applicants(id), closed_at TEXT, created_at TEXT NOT NULL,
    housing_title TEXT, housing_address TEXT, original_idealista_id TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_period ON search_periods(property_id) WHERE status='open';
    CREATE INDEX IF NOT EXISTS periods_property ON search_periods(property_id,created_at);
  `);
  const periodColumns=db.prepare('PRAGMA table_info(search_periods)').all().map(c=>c.name);
  const addedOriginalColumn=!periodColumns.includes('original_idealista_id');
  if (addedOriginalColumn)
    db.exec('ALTER TABLE search_periods ADD COLUMN original_idealista_id TEXT');
  const applicantColumns = db.prepare('PRAGMA table_info(applicants)').all().map(c=>c.name);
  if (!applicantColumns.includes('period_id')) db.exec('ALTER TABLE applicants ADD COLUMN period_id TEXT REFERENCES search_periods(id)');
  const conversationColumns = db.prepare('PRAGMA table_info(conversations)').all().map(c=>c.name);
  if (!conversationColumns.includes('period_id')) db.exec('ALTER TABLE conversations ADD COLUMN period_id TEXT REFERENCES search_periods(id)');
  if (!conversationColumns.includes('external_chat_id')) db.exec('ALTER TABLE conversations ADD COLUMN external_chat_id TEXT');
  if (!conversationColumns.includes('source_idealista_id')) db.exec('ALTER TABLE conversations ADD COLUMN source_idealista_id TEXT');
  db.exec('BEGIN');
  try {
    const insert = db.prepare(`INSERT INTO search_periods
      (id,property_id,status,rental_since,monthly_rent_cents,idealista_id,url,date_confirmed,created_at,original_idealista_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    for (const row of db.prepare('SELECT * FROM properties').all()) {
      const existing = db.prepare('SELECT id FROM search_periods WHERE property_id=? LIMIT 1').get(row.id);
      if (!existing) insert.run(`initial:${row.id}`,row.id,'open',row.rental_since,row.monthly_rent_cents,
        row.idealista_id,row.url,row.date_confirmed,row.created_at,row.idealista_id);
    }
    if (addedOriginalColumn) db.exec('UPDATE search_periods SET original_idealista_id=idealista_id');
    db.exec(`UPDATE applicants SET period_id=(SELECT id FROM search_periods
      WHERE property_id=applicants.property_id AND status='open') WHERE period_id IS NULL`);
    db.exec(`UPDATE conversations SET period_id=(SELECT period_id FROM applicants WHERE id=conversations.applicant_id)
      WHERE period_id IS NULL`);
    db.exec('UPDATE conversations SET external_chat_id=id WHERE external_chat_id IS NULL');
    const assignSource=db.prepare('UPDATE conversations SET source_idealista_id=? WHERE id=?');
    for(const row of db.prepare(`SELECT c.id,c.raw_json,c.property_url,s.idealista_id
      FROM conversations c JOIN search_periods s ON s.id=c.period_id WHERE c.source_idealista_id IS NULL`).all()){
      let observed=[];
      try { observed=JSON.parse(row.raw_json).properties?.map(item=>extractIdealistaId(item?.url)).filter(Boolean)??[]; }
      catch { /* Legacy raw JSON may be incomplete; keep the recorded URL as evidence. */ }
      const urls=new Set([extractIdealistaId(row.property_url),...observed].filter(Boolean));
      if(row.idealista_id && observed.length && !observed.includes(row.idealista_id))
        throw new Error(`El chat ${row.id} no corresponde al anuncio guardado de su periodo`);
      const source=row.idealista_id ?? (urls.size===1?[...urls][0]:'');
      assignSource.run(source,row.id);
    }
    db.exec('COMMIT');
  } catch(error) { db.exec('ROLLBACK'); throw error; }
  db.exec(`DROP INDEX IF EXISTS conversation_period_external;
    CREATE UNIQUE INDEX IF NOT EXISTS conversation_period_source_external
    ON conversations(period_id,source_idealista_id,external_chat_id);
    CREATE INDEX IF NOT EXISTS applicants_period ON applicants(period_id,discarded,favorite);`);
  db.exec(`INSERT OR IGNORE INTO property_listing_history(property_id,idealista_id)
    SELECT id,idealista_id FROM properties WHERE idealista_id IS NOT NULL;
    INSERT OR IGNORE INTO property_listing_history(property_id,idealista_id)
    SELECT property_id,idealista_id FROM search_periods WHERE idealista_id IS NOT NULL;
    INSERT OR IGNORE INTO property_listing_history(property_id,idealista_id)
    SELECT property_id,original_idealista_id FROM search_periods WHERE original_idealista_id IS NOT NULL;
    INSERT OR IGNORE INTO property_listing_history(property_id,idealista_id)
    SELECT a.property_id,c.source_idealista_id FROM conversations c JOIN applicants a ON a.id=c.applicant_id
    WHERE c.source_idealista_id IS NOT NULL AND c.source_idealista_id<>'';`);
}

function periodResult(row) {
  if (!row) return null;
  return { id:row.id, propertyId:row.property_id, status:row.status,
    rentalSince:row.rental_since, monthlyRentCents:row.monthly_rent_cents,
    idealistaId:row.idealista_id, originalIdealistaId:row.original_idealista_id??null,
    url:row.url, syncEnabled:Boolean(row.idealista_id),
    dateConfirmed:Boolean(row.date_confirmed), chosenApplicantId:row.chosen_applicant_id,
    chosenApplicantName:row.chosen_applicant_name ?? null,
    closedAt:row.closed_at, createdAt:row.created_at,
    housingTitle:row.housing_title, housingAddress:row.housing_address };
}

export function getPeriod(db, propertyId, periodId) {
  return periodResult(db.prepare(`SELECT s.*,(SELECT display_name FROM applicants WHERE id=s.chosen_applicant_id)
    AS chosen_applicant_name FROM search_periods s WHERE property_id=? AND s.id=?`).get(propertyId,periodId));
}

export function getOpenPeriod(db, propertyId) {
  return periodResult(db.prepare("SELECT * FROM search_periods WHERE property_id=? AND status='open'").get(propertyId));
}

export function listPeriods(db, propertyId) {
  return db.prepare(`SELECT s.*,(SELECT display_name FROM applicants WHERE id=s.chosen_applicant_id)
    AS chosen_applicant_name FROM search_periods s WHERE property_id=? ORDER BY created_at DESC,s.rowid DESC`)
    .all(propertyId).map(periodResult);
}

export function assertOpenPeriod(db, propertyId, periodId) {
  const period = getPeriod(db,propertyId,periodId);
  if (!period) throw Object.assign(new Error('Periodo no encontrado'),{code:'PERIOD_NOT_FOUND'});
  if (period.status !== 'open') throw Object.assign(new Error('El periodo está cerrado'),{code:'PERIOD_CLOSED'});
  return period;
}

export function normalize(fields) {
  const values = { people_count: null, has_children: null, has_pets: null, monthly_income_cents: null, income_scope: null };
  const evidence = {};
  const set = (key, value, original) => { values[key] = value; evidence[key] = original; };
  for (const original of fields) {
    const field = original.trim();
    const people = field.match(/^(?:Somos una familia de |Somos )?(\d+) (?:personas?|amigos)$/);
    if (people) set('people_count', Number(people[1]), original);
    else if (field === 'Somos una pareja') set('people_count', 2, original);
    if (field.startsWith('Hay menores:')) set('has_children', 1, original);
    else if (['Sin menores', 'No hay menores'].includes(field)) set('has_children', 0, original);
    if (field.startsWith('Con mascota')) set('has_pets', 1, original);
    else if (field === 'Sin mascota') set('has_pets', 0, original);
    const money = field.match(/^(Ingreso mensual|Ingresos mensuales del grupo): (\d+(?:\.\d{3})*(?:,\d{1,2})?) €$/);
    if (money) {
      const [whole, decimal = ''] = money[2].replaceAll('.', '').split(',');
      set('monthly_income_cents', Number(whole) * 100 + Number(decimal.padEnd(2, '0')), original);
      values.income_scope = money[1].includes('grupo') ? 'grupo' : 'individual';
    }
  }
  return { values, evidence };
}

export function validIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function canonicalIdealistaUrl(id) { return `https://www.idealista.com/inmueble/${id}/`; }

export function extractIdealistaId(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['idealista.com', 'www.idealista.com'].includes(url.hostname) ||
      url.search || url.hash) return null;
    return url.pathname.match(/^\/inmueble\/(\d+)\/?$/)?.[1] ?? null;
  } catch { return null; }
}

export function hasProperty(data, propertyId) {
  return Array.isArray(data.properties) && data.properties.some(item => extractIdealistaId(item?.url) === propertyId);
}

export function matchesConversationProperty(db, data, propertyId, periodId) {
  if (hasProperty(data,propertyId)) return true;
  // Hidden listings can lose their DOM link. Only an existing, scoped identity
  // can replace that evidence; a conflicting or malformed link never can.
  return data.periodId===periodId && data.propertyId===propertyId &&
    Array.isArray(data.properties) && data.properties.length===0 &&
    Boolean(db.prepare(`SELECT 1 FROM conversations WHERE period_id=?
      AND source_idealista_id=? AND external_chat_id=?`).get(periodId,propertyId,String(data.id)));
}

export function importConversation(db, data, source, day, propertyId, periodId, untilDate = day,
  archivedSourceIdealistaId = null) {
  const activityDate = data.activityDate === undefined ? day : data.activityDate;
  if (!validIsoDate(activityDate)) throw new Error('Fecha de actividad no válida');
  const cid = String(data.id);
  const observedId = data.properties?.map(item => extractIdealistaId(item?.url)).find(Boolean) ?? null;
  if (!propertyId) {
    if (observedId && db.prepare('SELECT 1 FROM purged_export_sources WHERE idealista_id=?')
      .get(observedId)) throw new Error('El archivo pertenece a una vivienda eliminada; indica una vivienda nueva explícitamente');
    propertyId = observedId ?
      db.prepare('SELECT id FROM properties WHERE idealista_id=?').get(observedId)?.id ?? observedId :
      'legacy-unassigned';
    if (db.prepare('SELECT 1 FROM purged_properties WHERE id=?').get(propertyId))
      throw new Error('La vivienda fue eliminada permanentemente');
    if (!getProperty(db, propertyId)) {
      db.prepare(`INSERT OR IGNORE INTO properties
        (id,title,address,monthly_rent_cents,rental_since,idealista_id,url,date_confirmed,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(propertyId, observedId ? `Anuncio ${propertyId}` : 'Sin anuncio identificado',
          null, null, activityDate, observedId, observedId ? canonicalIdealistaUrl(observedId) : null,
          0, new Date().toISOString());
      db.prepare(`INSERT OR IGNORE INTO search_periods
        (id,property_id,status,rental_since,monthly_rent_cents,idealista_id,url,date_confirmed,created_at,original_idealista_id)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(`initial:${propertyId}`,propertyId,'open',activityDate,null,
          observedId,observedId ? canonicalIdealistaUrl(observedId) : null,0,new Date().toISOString(),observedId);
    }
  }
  const property = getProperty(db, propertyId);
  if (!property)
    throw new Error('El chat no corresponde al anuncio seleccionado');
  const period = assertOpenPeriod(db,propertyId,periodId ?? property.activePeriodId);
  const archived=archivedSourceIdealistaId!==null;
  const importListing=archived ? archivedSourceIdealistaId : period.idealistaId;
  if (importListing && !matchesConversationProperty(db,data,importListing,period.id))
    throw new Error('El chat no corresponde al anuncio seleccionado');
  if (archived && importListing!==period.idealistaId && importListing!==period.originalIdealistaId &&
    !db.prepare(`SELECT 1 FROM conversations WHERE period_id=? AND source_idealista_id=?
      AND external_chat_id=?`).get(period.id,importListing,cid))
    throw new Error('El archivo no corresponde a una fuente histórica de este periodo');
  const initial = period.id === `initial:${propertyId}`;
  const projected = initial ? data.messages : projectPeriodMessages(db,period,data.messages,untilDate);
  if (!initial && !projected.length) throw new Error('El chat no tiene mensajes verificables en este periodo');
  if (Array.isArray(data.periodMessages) && JSON.stringify(data.periodMessages)!==JSON.stringify(projected))
    throw new Error('La proyección de mensajes no corresponde al periodo');
  const effectiveActivityDate = initial ? activityDate : projected.map(m=>m.messageDate).sort().at(-1);
  const sourceIdealistaId=importListing ?? observedId ?? '';
  const existing=db.prepare(`SELECT id,applicant_id FROM conversations
    WHERE period_id=? AND source_idealista_id=? AND external_chat_id=?`).get(period.id,sourceIdealistaId,cid);
  const basicCid=initial ? cid : `${period.id}:${cid}`;
  const basicAid=initial ? `chat:${cid}` : `chat:${period.id}:${cid}`;
  const collision=!existing && (db.prepare('SELECT 1 FROM conversations WHERE id=?').get(basicCid) ||
    db.prepare('SELECT 1 FROM applicants WHERE id=?').get(basicAid));
  const qualifiedCid=`${period.id}:${sourceIdealistaId||'unassigned'}:${cid}`;
  const qualifiedAid=`chat:${period.id}:${sourceIdealistaId||'unassigned'}:${cid}`;
  const internalCid=existing?.id ?? (collision ? qualifiedCid : basicCid);
  const internalAid=existing?.applicant_id ?? (collision ? qualifiedAid : basicAid);
  const assigned = db.prepare('SELECT property_id,period_id,source FROM applicants WHERE id=?').get(internalAid);
  if (assigned && (assigned.property_id !== propertyId || assigned.period_id !== period.id || assigned.source !== 'idealista'))
    throw new Error('El chat ya pertenece a otra vivienda');
  const previous = db.prepare('SELECT exported_at FROM conversations WHERE id=?').get(internalCid);
  if (previous && previous.exported_at >= data.exportedAt) return false;
  if (previous) {
    const storedCount = db.prepare('SELECT count(*) AS n FROM messages WHERE conversation_id=?').get(internalCid).n;
    const notes = Array.isArray(data.integrity?.notes) ? data.integrity.notes : [];
    const unstable = notes.some(note => typeof note === 'string' &&
      /virtualiz|contenido cambió|controles en el historial|estabiliz|historial.*carg/i.test(note));
    const attachmentsOnly = data.integrity?.history === 'parcial' &&
      notes.some(note => typeof note === 'string' && /adjuntos detectados/i.test(note));
    if (projected.length < storedCount || unstable ||
      (data.integrity?.history !== 'completo' && !attachmentsOnly))
      throw new Error('El historial parece incompleto; se conservó la conversación anterior');
  }
  rememberListing(db,propertyId,sourceIdealistaId);
  const profile = data.profile ?? {}, fields = profile.fields ?? [];
  const { values: v, evidence } = normalize(fields);
  // Una ficha representa al interesado/grupo de un chat. No fusionar por nombre.
  db.prepare(`INSERT INTO applicants
    (id,property_id,period_id,source,display_name,people_count,has_children,has_pets,monthly_income_cents,income_scope,profile_status,profile_text,evidence_json,created_at,created_date)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    display_name=excluded.display_name,people_count=excluded.people_count,has_children=excluded.has_children,
    has_pets=excluded.has_pets,monthly_income_cents=excluded.monthly_income_cents,income_scope=excluded.income_scope,
    profile_status=excluded.profile_status,profile_text=excluded.profile_text,evidence_json=excluded.evidence_json`).run(
      internalAid, propertyId, period.id, 'idealista', data.name, v.people_count, v.has_children, v.has_pets,
      v.monthly_income_cents, v.income_scope, data.integrity.profile, profile.text ?? null,
      JSON.stringify(evidence), new Date().toISOString(), effectiveActivityDate);
  db.prepare(`INSERT INTO conversations
    (id,applicant_id,property_url,activity_date,listed_time,exported_at,history_status,source_path,raw_json,period_id,external_chat_id,source_idealista_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    applicant_id=excluded.applicant_id,property_url=excluded.property_url,activity_date=excluded.activity_date,
    listed_time=excluded.listed_time,exported_at=excluded.exported_at,history_status=excluded.history_status,
    source_path=excluded.source_path,raw_json=excluded.raw_json`).run(
      internalCid, internalAid, data.properties?.[0]?.url ?? null, effectiveActivityDate, data.listedDate ?? null, data.exportedAt,
      data.integrity.history, source, JSON.stringify({...data,messages:projected}),period.id,cid,sourceIdealistaId);
  db.prepare('DELETE FROM messages WHERE conversation_id=?').run(internalCid);
  const messageStatement = db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?)');
  for (const [index,m] of projected.entries()) messageStatement.run(internalCid, index+1, m.author ?? null, m.direction ?? null,
    m.dateLabel ?? null, m.time ?? null, m.text ?? null, m.rawText);
  db.prepare('DELETE FROM profile_fields WHERE applicant_id=?').run(internalAid);
  const fieldStatement = db.prepare('INSERT INTO profile_fields VALUES (?,?,?)');
  fields.forEach((field, i) => fieldStatement.run(internalAid, i + 1, field));
  return true;
}

export function periodActivityStartsAt(db,period) {
  const utc=Date.parse(`${period.rentalSince}T00:00:00.000Z`);
  const offsetAt=instant=>{
    const zone=new Intl.DateTimeFormat('en',{timeZone:'Europe/Madrid',timeZoneName:'shortOffset'})
      .formatToParts(new Date(instant)).find(part=>part.type==='timeZoneName')?.value;
    const offset=zone?.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
    if (!offset) throw new Error('No se pudo calcular el inicio del periodo');
    return (Number(offset[2])*60+Number(offset[3]||0))*(offset[1]==='+'?1:-1);
  };
  let candidate=utc-offsetAt(utc-3600000)*60000;
  candidate=utc-offsetAt(candidate)*60000;
  const midnight=new Date(candidate).toISOString();
  const previous = db.prepare(`SELECT closed_at FROM search_periods WHERE property_id=? AND status='closed'
    AND closed_at <= ? ORDER BY closed_at DESC LIMIT 1`).get(period.propertyId,period.createdAt)?.closed_at;
  return previous && previous>midnight ? previous : midnight;
}

function projectPeriodMessages(db,period,messages,untilDate) {
  const boundary = periodActivityStartsAt(db,period);
  const cutoffDay=madridDate(boundary);
  return messages.filter(message=>{
    if (!validIsoDate(message.messageDate) || message.messageDate < period.rentalSince ||
      message.messageDate > untilDate) return false;
    if (message.occurredAt != null) {
      const instant=Date.parse(message.occurredAt);
      if (typeof message.occurredAt!=='string' || !Number.isFinite(instant) ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/.test(message.occurredAt) ||
        madridDate(message.occurredAt)!==message.messageDate)
        throw new Error('La fecha de un mensaje no es coherente');
      if (typeof message.time==='string' && /^\d{1,2}:\d{2}$/.test(message.time)) {
        const clock=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Madrid',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})
          .format(new Date(instant));
        if (clock!==message.time.padStart(5,'0')) throw new Error('La hora de un mensaje no es coherente');
      }
    }
    if (message.messageDate > cutoffDay) return true;
    if (message.messageDate < cutoffDay) return false;
    if (typeof message.occurredAt !== 'string' || !Number.isFinite(Date.parse(message.occurredAt)))
      throw new Error('La hora de un mensaje puede coincidir con el inicio del periodo');
    const instant=Date.parse(message.occurredAt), cutoff=Date.parse(boundary);
    if (instant>cutoff) return true;
    if (instant+60000>cutoff) throw new Error('Un mensaje cae en el mismo minuto del cierre anterior');
    return false;
  });
}

export function importExports(db, directory, options = {}) {
  let imported = 0;
  let skippedClosed = 0;
  db.exec('BEGIN');
  try {
    for (const day of readdirSync(directory).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()) {
      const dayDir = path.join(directory,day);
      const propertyDirs = readdirSync(dayDir).filter(name => /^property-\d+$/.test(name))
        .map(name => path.join(dayDir,name));
      const locations = [dayDir,...propertyDirs,
        ...propertyDirs.flatMap(dir=>readdirSync(dir).filter(name=>name.startsWith('period-'))
          .map(name=>path.join(dir,name)))];
      for (const location of locations) {
        for (const file of readdirSync(location).filter(f => /^\d+\.json$/.test(f))) {
          const source = path.join(location, file);
          const namespace = path.basename(location).match(/^property-(\d+)$/)?.[1] ??
            path.basename(path.dirname(location)).match(/^property-(\d+)$/)?.[1];
          const data = JSON.parse(readFileSync(source, 'utf8'));
          const observedIds=[...new Set(data.properties?.map(item=>extractIdealistaId(item?.url)).filter(Boolean)??[])];
          const observed = namespace ?? (observedIds.length===1?observedIds[0]:null);
          const directoryPeriod = path.basename(location).startsWith('period-') ?
            decodeURIComponent(path.basename(location).slice('period-'.length)) : null;
          if (directoryPeriod && data.periodId!==directoryPeriod)
            throw new Error('El archivo pertenece a otro periodo');
          const metadataPeriod=data.periodId ?? directoryPeriod;
          if (metadataPeriod && db.prepare('SELECT 1 FROM purged_periods WHERE id=?').get(metadataPeriod))
            throw new Error('El archivo pertenece a una búsqueda eliminada permanentemente');
          if (data.periodId && options.periodId && data.periodId!==options.periodId)
            throw new Error('El archivo pertenece a otro periodo');
          let period;
          if (metadataPeriod) {
            const row=db.prepare('SELECT property_id FROM search_periods WHERE id=?').get(metadataPeriod);
            period=row && getPeriod(db,row.property_id,metadataPeriod);
          } else if (observed) {
            const candidates=db.prepare(`SELECT DISTINCT s.id,s.property_id FROM search_periods s
              JOIN properties p ON p.id=s.property_id WHERE p.deleted_at IS NULL AND
              (s.original_idealista_id=? OR s.idealista_id=? OR EXISTS
                (SELECT 1 FROM conversations c WHERE c.period_id=s.id AND c.source_idealista_id=?))`)
              .all(observed,observed,observed);
            const explicit=candidates.find(row=>row.id===options.periodId ||
              row.id===options.periodByProperty?.[row.property_id]);
            const legacy=candidates.filter(row=>row.id===`initial:${row.property_id}`);
            const selected=explicit ?? (legacy.length===1?legacy[0]:null);
            period=selected && getPeriod(db,selected.property_id,selected.id);
            if (!explicit && db.prepare('SELECT 1 FROM purged_export_sources WHERE idealista_id=?').get(observed))
              throw new Error('Este archivo histórico pertenece a una vivienda eliminada; indica un destino explícito');
          } else if (!observedIds.length) {
            period=getPeriod(db,DEFAULT_PROPERTY_ID,`initial:${DEFAULT_PROPERTY_ID}`);
          }
          if (!period)
            throw new Error('Indica explícitamente el periodo de destino; no se puede asignar este archivo');
          if (namespace && !matchesConversationProperty(db,data,namespace,period.id))
            throw new Error('El archivo no corresponde al anuncio de su carpeta');
          const targetProperty=period.propertyId,targetPeriod=period.id;
          if (!getProperty(db,targetProperty)) throw new Error('La vivienda de destino está eliminada');
          if (period.status==='closed') {
            if (options.periodId===targetPeriod || options.periodByProperty?.[targetProperty]===targetPeriod)
              throw new Error('El periodo de destino está cerrado; no se puede importar');
            skippedClosed++;
            continue;
          }
          const archivedSource=observed ?? (period.originalIdealistaId && hasProperty(data,period.originalIdealistaId) ?
            period.originalIdealistaId : null);
          if (importConversation(db, data, source, day, targetProperty,targetPeriod,day,archivedSource)) imported++;
        }
      }
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { imported, skippedClosed, conversations: db.prepare('SELECT count(*) AS n FROM conversations').get().n,
    messages: db.prepare('SELECT count(*) AS n FROM messages').get().n,
    profiles: db.prepare("SELECT count(*) AS n FROM applicants WHERE profile_status='completo'").get().n };
}

export function listApplicants(db, params = new URLSearchParams(), propertyId = DEFAULT_PROPERTY_ID, periodId) {
  const reply = params.get('reply') || 'all';
  if (!['all','replied','not_replied','no_chat','unknown'].includes(reply))
    throw new Error('Filtro de respuesta no válido');
  const pendingReply = params.get('pendingReply') || 'all';
  if (!['all','yes','no','no_chat','unknown'].includes(pendingReply))
    throw new Error('Filtro de seguimiento no válido');
  const clauses = [], bindings = [];
  const add = (sql, value) => { clauses.push(sql); if (value !== undefined) bindings.push(value); };
  add('property_id=?', propertyId);
  const selectedPeriodId = periodId ?? getOpenPeriod(db,propertyId)?.id;
  if (!selectedPeriodId) return [];
  add('period_id=?', selectedPeriodId);
  const status = params.get('status') || 'active';
  if (!['active', 'favorites', 'discarded', 'all'].includes(status)) throw new Error('Vista no válida');
  if (status === 'active') add('discarded=0');
  if (status === 'favorites') add('discarded=0 AND favorite=1');
  if (status === 'discarded') add('discarded=1');
  if (params.get('date')) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(params.get('date'))) throw new Error('Fecha no válida');
    add('activity_date=?', params.get('date'));
  }
  for (const [parameter, column] of [['children','has_children'], ['pets','has_pets']]) {
    const value = params.get(parameter);
    if (!value) continue;
    if (value === 'unknown') add(`${column} IS NULL`);
    else if (['0','1'].includes(value)) add(`${column}=?`, Number(value));
    else throw new Error('Filtro no válido');
  }
  const numbers = {};
  for (const [parameter, column, operator, integer] of [
    ['peopleMin','people_count','>=',true],['peopleMax','people_count','<=',true],
    ['incomeMin','monthly_income_eur','>=',false],['incomeMax','monthly_income_eur','<=',false]]) {
    const value = params.get(parameter);
    if (!value) continue;
    const n = Number(value);
    if (!Number.isFinite(n) || n < (integer ? 1 : 0) || (integer && !Number.isInteger(n))) throw new Error('Rango no válido');
    numbers[parameter] = n; add(`${column}${operator}?`, n);
  }
  if (numbers.peopleMin > numbers.peopleMax || numbers.incomeMin > numbers.incomeMax) throw new Error('El mínimo no puede superar el máximo');
  const scope = params.get('scope');
  if (scope === 'unknown') add('income_scope IS NULL');
  else if (scope) {
    if (!['grupo','individual'].includes(scope)) throw new Error('Ámbito no válido');
    add('income_scope=?', scope);
  }
  let items = db.prepare(`SELECT * FROM interested ${clauses.length ? 'WHERE '+clauses.join(' AND ') : ''}
    ORDER BY activity_date DESC,listed_time DESC,conversation_id DESC`).all(...bindings);
  const fold = s => s.normalize('NFD').replace(/\p{Diacritic}/gu,'').toLocaleLowerCase('es');
  if (params.get('name')) items = items.filter(item => fold(item.name).includes(fold(params.get('name'))));
  const rawQuery = params.get('messageQuery');
  if (rawQuery !== null) {
    if (Array.from(rawQuery).length > 500) throw new Error('Búsqueda demasiado larga');
    const query = foldMessage(rawQuery).trim();
    if (query) {
      const messageRows = db.prepare(`SELECT author,date_label,time_label,raw_text FROM messages
        WHERE conversation_id=? ORDER BY sequence`);
      items = items.flatMap(item => {
        if (!item.conversation_id) return [];
        for (const message of messageRows.all(item.conversation_id)) {
          const match = findMessageMatch(message.raw_text, query);
          if (match) return [{ ...item, messageMatch: { snippet: match,
            author: message.author, dateLabel: message.date_label, time: message.time_label } }];
        }
        return [];
      });
    }
  }
  const period=getPeriod(db,propertyId,selectedPeriodId);
  const cutoff=period ? periodActivityStartsAt(db,period) : null;
  const rawByConversation=new Map(db.prepare('SELECT id,raw_json FROM conversations WHERE period_id=?')
    .all(selectedPeriodId).map(row=>[row.id,row.raw_json]));
  const messageCountByConversation=new Map(db.prepare(`SELECT conversation_id,count(*) AS n FROM messages
    WHERE conversation_id IN (SELECT id FROM conversations WHERE period_id=?)
    GROUP BY conversation_id`).all(selectedPeriodId).map(row=>[row.conversation_id,row.n]));
  const attentionByApplicant=period?.status==='open' ? new Map(db.prepare(`SELECT * FROM sync_attention
    WHERE period_id=?`).all(selectedPeriodId).map(row=>[row.applicant_id,row])) : new Map();
  const enriched=items.map(item=>({...item,messageCount:messageCountByConversation.get(item.conversation_id)??0,
    ...messageMetadataForItem(item,period,cutoff,rawByConversation.get(item.conversation_id)),
    ...syncAttentionResult(attentionByApplicant.get(item.applicant_id))}));
  return enriched.filter(item=>(reply==='all' || (reply==='replied' ? item.hasReplied===true :
    reply==='not_replied' ? item.hasReplied===false :
    reply==='no_chat' ? item.hasReplied===null && !item.conversation_id :
    item.hasReplied===null && !!item.conversation_id)) &&
    (pendingReply==='all' || (pendingReply==='yes' ? item.awaitingReply===true :
      pendingReply==='no' ? item.awaitingReply===false :
      pendingReply==='no_chat' ? item.awaitingReply===null && !item.conversation_id :
      item.awaitingReply===null && !!item.conversation_id)));
}

const emptySyncAttention=()=>({syncAttention:null,newIncomingCount:0,attentionRevision:null});
const emptyArrival=()=>({arrivalDate:null,arrivalAt:null});

function importedMessageMetadata(messages,period,cutoff,historyStatus) {
  return {...importedArrival(messages,period.rentalSince,cutoff,period.closedAt),
    hasReplied:importedHasReplied(messages,period.rentalSince,cutoff,period.closedAt,historyStatus),
    awaitingReply:importedAwaitingReply(messages,period.rentalSince,cutoff,period.closedAt,historyStatus)};
}

function messageMetadataForItem(item,period,cutoff,raw) {
  if(item.source==='manual') return {...manualArrival(item.created_date,item.created_at),hasReplied:null,awaitingReply:null};
  if(!period || !raw) return {...emptyArrival(),hasReplied:null,awaitingReply:null};
  try { return importedMessageMetadata(JSON.parse(raw).messages,period,cutoff,item.history_status); }
  catch { return {...emptyArrival(),hasReplied:null,awaitingReply:null}; }
}

function syncAttentionResult(row) {
  return row ? {syncAttention:row.kind,newIncomingCount:row.new_incoming_count,
    attentionRevision:row.revision} : emptySyncAttention();
}

export function getSyncAttention(db,applicantId,periodId) {
  const row=db.prepare(`SELECT kind,new_incoming_count,revision FROM sync_attention
    WHERE applicant_id=? AND period_id=?`).get(applicantId,periodId);
  return syncAttentionResult(row);
}

export function recordSyncAttention(db,applicantId,periodId,kind,newIncomingCount=0) {
  const previous=db.prepare(`SELECT kind,new_incoming_count FROM sync_attention
    WHERE applicant_id=? AND period_id=?`).get(applicantId,periodId);
  if (kind==='message' && !newIncomingCount) return getSyncAttention(db,applicantId,periodId);
  const nextKind=previous?.kind==='new' ? 'new' : kind;
  const count=(previous?.new_incoming_count??0)+newIncomingCount;
  const revision=randomUUID();
  db.prepare(`INSERT INTO sync_attention(applicant_id,period_id,kind,new_incoming_count,revision)
    VALUES (?,?,?,?,?) ON CONFLICT(applicant_id) DO UPDATE SET
    period_id=excluded.period_id,kind=excluded.kind,new_incoming_count=excluded.new_incoming_count,
    revision=excluded.revision`).run(applicantId,periodId,nextKind,count,revision);
  return {syncAttention:nextKind,newIncomingCount:count,attentionRevision:revision};
}

export function getLastSuccessfulSync(db,periodId) {
  const row=db.prepare('SELECT * FROM sync_batches WHERE period_id=?').get(periodId);
  return row ? {id:row.id,completedAt:row.completed_at,newCount:row.new_count,
    incomingApplicantCount:row.incoming_applicant_count,
    incomingMessageCount:row.incoming_message_count,refreshedCount:row.refreshed_count,
    requestedMode:row.requested_mode,effectiveMode:row.effective_mode,
    examined:row.examined,candidates:row.candidates,earlyStopped:Boolean(row.early_stopped),
    stopReason:row.stop_reason,unchangedStreak:row.unchanged_streak,
    unchangedThreshold:row.unchanged_threshold,
    fullCoverage:Boolean(row.full_coverage),headRechecked:Boolean(row.head_rechecked)} : null;
}

export function recordSuccessfulSync(db,periodId,summary) {
  db.prepare(`INSERT INTO sync_batches(period_id,id,completed_at,new_count,
    incoming_applicant_count,incoming_message_count,refreshed_count,
    requested_mode,effective_mode,examined,candidates,early_stopped,stop_reason,
    unchanged_streak,unchanged_threshold,full_coverage,head_rechecked)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(period_id) DO UPDATE SET
    id=excluded.id,completed_at=excluded.completed_at,new_count=excluded.new_count,
    incoming_applicant_count=excluded.incoming_applicant_count,
    incoming_message_count=excluded.incoming_message_count,
    refreshed_count=excluded.refreshed_count,
    requested_mode=excluded.requested_mode,effective_mode=excluded.effective_mode,
    examined=excluded.examined,candidates=excluded.candidates,
    early_stopped=excluded.early_stopped,stop_reason=excluded.stop_reason,
    unchanged_streak=excluded.unchanged_streak,
    unchanged_threshold=excluded.unchanged_threshold,
    full_coverage=excluded.full_coverage,head_rechecked=excluded.head_rechecked`)
    .run(periodId,summary.id,summary.completedAt,
      summary.newCount,summary.incomingApplicantCount,summary.incomingMessageCount,
      summary.refreshedCount,summary.requestedMode,summary.effectiveMode,
      summary.examined,summary.candidates,Number(summary.earlyStopped),summary.stopReason,
      summary.unchangedStreak,summary.unchangedThreshold,
      Number(summary.fullCoverage),Number(summary.headRechecked));
}

export function hasSourceBaseline(db,periodId,sourceIdealistaId,sinceDate,activityStartsAt,includeLegacyHistory) {
  return Boolean(db.prepare(`SELECT 1 FROM sync_source_baselines WHERE period_id=? AND source_idealista_id=?
    AND since_date=? AND activity_starts_at=? AND include_legacy_history=?`)
    .get(periodId,sourceIdealistaId,sinceDate,activityStartsAt,Number(includeLegacyHistory)));
}

export function recordSourceBaseline(db,periodId,sourceIdealistaId,sinceDate,activityStartsAt,
  includeLegacyHistory,completedAt,batchId) {
  db.prepare(`INSERT INTO sync_source_baselines(period_id,source_idealista_id,since_date,
    activity_starts_at,include_legacy_history,completed_at,batch_id) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(period_id,source_idealista_id) DO UPDATE SET
    since_date=excluded.since_date,activity_starts_at=excluded.activity_starts_at,
    include_legacy_history=excluded.include_legacy_history,
    completed_at=excluded.completed_at,batch_id=excluded.batch_id`)
    .run(periodId,sourceIdealistaId,sinceDate,activityStartsAt,Number(includeLegacyHistory),
      completedAt,batchId);
}

export function markSyncAttentionRead(db,propertyId,periodId,applicantId,revision) {
  const scoped=db.prepare(`SELECT 1 FROM applicants WHERE id=? AND property_id=? AND period_id=?`)
    .get(applicantId,propertyId,periodId);
  if (!scoped) return null;
  const deleted=db.prepare(`DELETE FROM sync_attention WHERE applicant_id=? AND period_id=?
    AND revision=?`).run(applicantId,periodId,revision);
  const current=getSyncAttention(db,applicantId,periodId);
  return {acknowledged:deleted.changes>0 || !current.syncAttention,...current};
}

function foldMessage(value) {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('es')
    .replace(/\s+/gu, ' ');
}

function findMessageMatch(raw, query) {
  let folded = '';
  const offsets = [];
  for (let i = 0; i < raw.length;) {
    const point = raw.codePointAt(i);
    const character = String.fromCodePoint(point);
    const part = foldMessage(character);
    for (const letter of part) {
      if (letter === ' ' && folded.endsWith(' ')) continue;
      folded += letter;
      offsets.push(i);
    }
    i += character.length;
  }
  const index = folded.indexOf(query);
  if (index < 0) return null;
  const start = offsets[index];
  const end = offsets[index + query.length - 1] + 1;
  const left = Math.max(0, start - 70);
  const right = Math.min(raw.length, Math.max(end + 70, left + 180));
  const excerpt = raw.slice(left, Math.min(right, left + 700)).replace(/\s+/gu, ' ').trim();
  return `${left ? '…' : ''}${excerpt}${right < raw.length ? '…' : ''}`;
}

export function applicantDetail(db, id, propertyId = DEFAULT_PROPERTY_ID, periodId) {
  periodId ??= getOpenPeriod(db,propertyId)?.id;
  const matches=/^\d+$/.test(id) ? db.prepare(`SELECT applicant_id FROM conversations
    WHERE external_chat_id=? AND period_id=?`).all(id,periodId) : [];
  const applicantId = /^\d+$/.test(id) ? (matches.length===1?matches[0].applicant_id:null) : id;
  if (!applicantId) return null;
  const item = db.prepare('SELECT * FROM interested WHERE applicant_id=? AND property_id=? AND period_id=?')
    .get(applicantId,propertyId,periodId);
  if (!item) return null;
  const period=getPeriod(db,propertyId,periodId);
  const attention=period?.status==='open' ? getSyncAttention(db,applicantId,periodId) : emptySyncAttention();
  if (item.source === 'manual') return { ...item,...attention,
    ...manualArrival(item.created_date,item.created_at),hasReplied:null,awaitingReply:null,
    messageCount:0,profile: null, messages: [],
    integrity: null, properties: [] };
  const data = JSON.parse(db.prepare('SELECT raw_json FROM conversations WHERE id=?').get(item.conversation_id).raw_json);
  const messageCount=db.prepare('SELECT count(*) AS n FROM messages WHERE conversation_id=?').get(item.conversation_id).n;
  return { ...item,...attention,messageCount,
    ...importedMessageMetadata(data.messages,period,periodActivityStartsAt(db,period),item.history_status),
    profile: data.profile, messages: data.messages, integrity: data.integrity, properties: data.properties };
}

const manualColumns = { name:'display_name',phone:'phone',email:'email',peopleCount:'people_count',
  hasChildren:'has_children',hasPets:'has_pets',monthlyIncomeCents:'monthly_income_cents',
  incomeScope:'income_scope',notes:'notes',favorite:'favorite',discarded:'discarded' };

function manualValues(changes, create = false) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes) ||
    !Object.keys(changes).length || Object.keys(changes).some(key => !(key in manualColumns) ||
      (create && ['favorite','discarded'].includes(key)))) throw new Error('Datos del interesado no válidos');
  if (create && !('name' in changes)) throw new Error('El nombre es obligatorio');
  const values = {};
  for (const [key,value] of Object.entries(changes)) {
    if (key === 'name' && (typeof value !== 'string' || !value.trim() || Array.from(value).length > 200))
      throw new Error('El nombre no es válido');
    if (['phone','email'].includes(key) && value !== null &&
      (typeof value !== 'string' || Array.from(value).length > (key === 'phone' ? 100 : 320)))
      throw new Error('Datos de contacto no válidos');
    if (key === 'email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
      throw new Error('El correo no es válido');
    if (key === 'peopleCount' && value !== null &&
      (!Number.isSafeInteger(value) || value < 1 || value > 1000)) throw new Error('Número de personas no válido');
    if (['hasChildren','hasPets'].includes(key) && value !== null && typeof value !== 'boolean')
      throw new Error('Valor de menores o mascotas no válido');
    if (key === 'monthlyIncomeCents' && value !== null &&
      (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000_000))
      throw new Error('Ingreso mensual no válido');
    if (key === 'incomeScope' && value !== null && !['grupo','individual'].includes(value))
      throw new Error('Ámbito de ingreso no válido');
    if (key === 'notes' && (typeof value !== 'string' || Array.from(value).length > 10000))
      throw new Error('Notas no válidas');
    if (['favorite','discarded'].includes(key) && typeof value !== 'boolean')
      throw new Error('Cambios no válidos');
    values[manualColumns[key]] = key === 'name' ? value.trim() :
      ['hasChildren','hasPets','favorite','discarded'].includes(key) && value !== null ? Number(value) : value;
  }
  return values;
}

export function createManualApplicant(db, propertyId, input, periodId) {
  if (!getProperty(db,propertyId)) return null;
  const period = assertOpenPeriod(db,propertyId,periodId ?? getOpenPeriod(db,propertyId)?.id);
  const values = manualValues(input,true);
  const id = `manual:${randomUUID()}`;
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO applicants
    (id,property_id,period_id,source,display_name,people_count,has_children,has_pets,monthly_income_cents,
      income_scope,profile_status,profile_text,evidence_json,notes,phone,email,created_at,created_date)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,propertyId,period.id,'manual',values.display_name,
      values.people_count ?? null,values.has_children ?? null,values.has_pets ?? null,
      values.monthly_income_cents ?? null,values.income_scope ?? null,'manual',null,'{}',
      values.notes ?? '',values.phone ?? null,values.email ?? null,now,localDay());
  return applicantDetail(db,id,propertyId,period.id);
}

export function updateApplicant(db, id, changes, propertyId = DEFAULT_PROPERTY_ID, periodId) {
  periodId ??= getOpenPeriod(db,propertyId)?.id;
  assertOpenPeriod(db,propertyId,periodId);
  const matches=/^\d+$/.test(id) ? db.prepare(`SELECT applicant_id FROM conversations
    WHERE external_chat_id=? AND period_id=?`).all(id,periodId) : [];
  const applicantId = /^\d+$/.test(id) ? (matches.length===1?matches[0].applicant_id:null) : id;
  if (!applicantId) return false;
  const item = db.prepare('SELECT source FROM applicants WHERE id=? AND property_id=? AND period_id=?')
    .get(applicantId,propertyId,periodId);
  if (!item) return false;
  const values = item.source === 'manual' ? manualValues(changes) : (() => {
    const keys = Object.keys(changes);
    if (!keys.length || keys.some(k => !['favorite','discarded','notes'].includes(k) ||
      (k === 'notes' ? typeof changes[k] !== 'string' || Array.from(changes[k]).length > 10000 :
        typeof changes[k] !== 'boolean'))) throw new Error('Cambios no válidos');
    return Object.fromEntries(keys.map(key => [key,key === 'notes' ? changes[key] : Number(changes[key])]));
  })();
  const columns = Object.keys(values);
  return db.prepare(`UPDATE applicants SET ${columns.map(key=>`${key}=?`).join(',')} WHERE id=? AND property_id=? AND period_id=?`)
    .run(...columns.map(key=>values[key]), applicantId,propertyId,periodId).changes === 1;
}

function propertyResult(row) {
  if (!row) return null;
  return { id: row.id, title: row.title, address: row.address,
    monthlyRentCents: row.monthly_rent_cents, rentalSince: row.rental_since,
    idealistaId: row.idealista_id, url: row.url,
    defaultIdealistaId:row.default_idealista_id ?? null,
    defaultIdealistaUrl:row.default_url ?? null, canEditIdealistaUrl:true,
    canDeleteProperty:true, deletedAt:row.deleted_at ?? null,
    syncEnabled: Boolean(row.idealista_id), dateConfirmed: Boolean(row.date_confirmed),
    lastClosedPeriod:row.closed_period_id ? {id:row.closed_period_id,
      chosenApplicantId:row.chosen_applicant_id,chosenApplicantName:row.chosen_applicant_name} : null,
    activePeriodId:row.active_period_id ?? null, periodStatus:row.active_period_id ? 'open' : null };
}

const lastClosedPeriodJoin = `LEFT JOIN search_periods closed ON closed.id=(
  SELECT id FROM search_periods WHERE property_id=p.id AND status='closed'
  ORDER BY closed_at DESC,created_at DESC,rowid DESC LIMIT 1)
  LEFT JOIN applicants chosen ON chosen.id=closed.chosen_applicant_id
    AND chosen.period_id=closed.id AND chosen.property_id=p.id`;

export function getProperty(db, id = DEFAULT_PROPERTY_ID, includeDeleted = false) {
  return propertyResult(db.prepare(`SELECT p.id,p.title,p.address,p.deleted_at,
    coalesce(p.deleted_default_idealista_id,p.idealista_id) AS default_idealista_id,
    coalesce(p.deleted_default_url,p.url) AS default_url,s.id AS active_period_id,
    s.monthly_rent_cents,s.rental_since,s.idealista_id,s.url,s.date_confirmed,
    closed.id AS closed_period_id,closed.chosen_applicant_id,chosen.display_name AS chosen_applicant_name
    FROM properties p LEFT JOIN search_periods s ON s.property_id=p.id AND s.status='open'
    ${lastClosedPeriodJoin}
    WHERE p.id=? AND (? OR p.deleted_at IS NULL)`).get(id,Number(includeDeleted)));
}

export function listProperties(db, status = 'active') {
  if (!['active','deleted','all'].includes(status)) throw new Error('Vista no válida');
  return db.prepare(`SELECT p.id,p.title,p.address,p.created_at,p.deleted_at,
    coalesce(p.deleted_default_idealista_id,p.idealista_id) AS default_idealista_id,
    coalesce(p.deleted_default_url,p.url) AS default_url,s.id AS active_period_id,
    s.monthly_rent_cents,s.rental_since,s.idealista_id,s.url,s.date_confirmed,
    closed.id AS closed_period_id,closed.chosen_applicant_id,chosen.display_name AS chosen_applicant_name
    FROM properties p LEFT JOIN search_periods s ON s.property_id=p.id AND s.status='open'
    ${lastClosedPeriodJoin}
    WHERE (?='all' OR (?='deleted' AND p.deleted_at IS NOT NULL) OR (?='active' AND p.deleted_at IS NULL))
    ORDER BY p.id=? DESC,p.created_at,p.id`).all(status,status,status,DEFAULT_PROPERTY_ID)
    .map(propertyResult);
}

function propertyInput(input, today, previous = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length ||
    Object.keys(input).some(key => !['title','address','monthlyRentCents','rentalSince','idealistaUrl'].includes(key)))
    throw new Error('Datos de vivienda no válidos');
  const title = input.title === undefined ? previous?.title : input.title;
  const address = input.address === undefined ? previous?.address ?? null : input.address;
  const monthlyRentCents = input.monthlyRentCents === undefined ? previous?.monthlyRentCents ?? null : input.monthlyRentCents;
  const rentalSince = input.rentalSince === undefined ? previous?.rentalSince : input.rentalSince;
  const rawUrl = input.idealistaUrl === undefined ? previous?.url ?? null : input.idealistaUrl;
  if (typeof title !== 'string' || !title.trim() || Array.from(title).length > 200 ||
    (address !== null && (typeof address !== 'string' || Array.from(address).length > 300)) ||
    (monthlyRentCents !== null && (!Number.isSafeInteger(monthlyRentCents) || monthlyRentCents < 0)) ||
    !validIsoDate(rentalSince) || rentalSince > today ||
    (rawUrl !== null && (typeof rawUrl !== 'string' || !extractIdealistaId(rawUrl))))
    throw new Error('Datos de vivienda no válidos');
  const idealistaId = rawUrl === null ? null : extractIdealistaId(rawUrl);
  return { title: title.trim(), address, monthlyRentCents, rentalSince, idealistaId,
    url: idealistaId ? canonicalIdealistaUrl(idealistaId) : null };
}

function duplicateActiveListing(db,listingId,exceptPropertyId=null) {
  if (!listingId) return false;
  return Boolean(db.prepare(`SELECT p.id FROM properties p
    LEFT JOIN search_periods s ON s.property_id=p.id AND s.status='open'
    WHERE p.deleted_at IS NULL AND p.id<>? AND (p.idealista_id=? OR s.idealista_id=?) LIMIT 1`)
    .get(exceptPropertyId??'',listingId,listingId));
}

function rememberListing(db,propertyId,listingId) {
  if (listingId) db.prepare(`INSERT OR IGNORE INTO property_listing_history(property_id,idealista_id)
    VALUES (?,?)`).run(propertyId,listingId);
}

export function createProperty(db, input, today = localDay()) {
  const value = propertyInput(input, today);
  const duplicate = duplicateActiveListing(db,value.idealistaId);
  if (duplicate) throw Object.assign(new Error('Este anuncio ya está añadido'), { code: 'DUPLICATE_PROPERTY' });
  const id = randomUUID();
  db.exec('BEGIN');
  try {
  db.prepare(`INSERT INTO properties
    (id,title,address,monthly_rent_cents,rental_since,idealista_id,url,date_confirmed,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(id,value.title,value.address,value.monthlyRentCents,
    value.rentalSince,value.idealistaId,value.url,1,new Date().toISOString());
  rememberListing(db,id,value.idealistaId);
  db.prepare(`INSERT INTO search_periods
    (id,property_id,status,rental_since,monthly_rent_cents,idealista_id,url,date_confirmed,created_at,original_idealista_id)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(),id,'open',value.rentalSince,value.monthlyRentCents,
      value.idealistaId,value.url,1,new Date().toISOString(),value.idealistaId);
  db.exec('COMMIT');
  } catch(error) { db.exec('ROLLBACK'); throw error; }
  return getProperty(db,id);
}

export function updateProperty(db, id, changes, today = localDay()) {
  const previous = getProperty(db,id);
  if (!previous) return null;
  if (!previous.activePeriodId) {
    if (!changes || typeof changes!=='object' || Array.isArray(changes) || !Object.keys(changes).length ||
      Object.keys(changes).some(key=>!['title','address','idealistaUrl'].includes(key)))
      throw Object.assign(new Error('El periodo está cerrado'),{code:'PERIOD_CLOSED'});
    const title=changes.title ?? previous.title, address=changes.address === undefined ? previous.address : changes.address;
    const rawUrl=changes.idealistaUrl === undefined ? previous.defaultIdealistaUrl : changes.idealistaUrl;
    const idealistaId=rawUrl===null ? null : extractIdealistaId(rawUrl);
    if (typeof title!=='string' || !title.trim() || Array.from(title).length>200 ||
      (address!==null && (typeof address!=='string' || Array.from(address).length>300)) ||
      (rawUrl!==null && !idealistaId))
      throw new Error('Datos de vivienda no válidos');
    if (duplicateActiveListing(db,idealistaId,id))
      throw Object.assign(new Error('Este anuncio ya está añadido'),{code:'DUPLICATE_PROPERTY'});
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE properties SET title=?,address=?,idealista_id=?,url=? WHERE id=?')
        .run(title.trim(),address,idealistaId,idealistaId?canonicalIdealistaUrl(idealistaId):null,id);
      rememberListing(db,id,idealistaId);
      db.exec('COMMIT');
    } catch(error) { db.exec('ROLLBACK'); throw error; }
    return getProperty(db,id);
  }
  const value = propertyInput(changes,today,previous);
  const duplicate = duplicateActiveListing(db,value.idealistaId,id);
  if (duplicate) throw Object.assign(new Error('Este anuncio ya está añadido'), { code: 'DUPLICATE_PROPERTY' });
  const period = getOpenPeriod(db,id);
  const metadataKeys = ['monthlyRentCents','rentalSince','idealistaUrl'];
  if (!period && metadataKeys.some(key=>Object.hasOwn(changes,key)))
    throw Object.assign(new Error('El periodo está cerrado'),{code:'PERIOD_CLOSED'});
  if (period && value.rentalSince !== period.rentalSince) {
    const previous = db.prepare(`SELECT closed_at FROM search_periods WHERE property_id=? AND status='closed'
      AND closed_at<=? ORDER BY closed_at DESC LIMIT 1`).get(id,period.createdAt)?.closed_at;
    if (previous && value.rentalSince < madridDate(previous))
      throw Object.assign(new Error('El inicio no puede preceder al cierre anterior'),{code:'PERIOD_DATE'});
    const stored = db.prepare(`SELECT min(coalesce(c.activity_date,a.created_date)) AS earliest
      FROM applicants a LEFT JOIN conversations c ON c.applicant_id=a.id WHERE a.period_id=?`).get(period.id)?.earliest;
    if (stored && value.rentalSince > stored)
      throw Object.assign(new Error('La fecha dejaría fuera interesados guardados'),{code:'PERIOD_DATE'});
  }
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE properties SET title=?,address=?,monthly_rent_cents=?,rental_since=?,idealista_id=?,url=?,date_confirmed=1
      WHERE id=?`).run(value.title,value.address,value.monthlyRentCents,value.rentalSince,value.idealistaId,value.url,id);
    rememberListing(db,id,value.idealistaId);
    if (period) db.prepare(`UPDATE search_periods SET monthly_rent_cents=?,rental_since=?,idealista_id=?,url=?,date_confirmed=1
      WHERE id=? AND status='open'`).run(value.monthlyRentCents,value.rentalSince,value.idealistaId,value.url,period.id);
    db.exec('COMMIT');
  } catch(error) { db.exec('ROLLBACK'); throw error; }
  return getProperty(db,id);
}

export function createPeriod(db, propertyId, input, today = localDay()) {
  const property = getProperty(db,propertyId);
  if (!property) return null;
  if (getOpenPeriod(db,propertyId)) throw Object.assign(new Error('Ya hay un periodo abierto'),{code:'PERIOD_OPEN'});
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    Object.keys(input).some(k=>!['rentalSince','monthlyRentCents','idealistaUrl'].includes(k)))
    throw new Error('Datos del periodo no válidos');
  const value = propertyInput({title:property.title,address:property.address,
    idealistaUrl:property.defaultIdealistaUrl,...input},today);
  if (duplicateActiveListing(db,value.idealistaId,propertyId))
    throw Object.assign(new Error('Este anuncio ya está añadido'),{code:'DUPLICATE_PROPERTY'});
  const last = db.prepare("SELECT closed_at FROM search_periods WHERE property_id=? AND status='closed' ORDER BY closed_at DESC LIMIT 1").get(propertyId);
  if (last && value.rentalSince < madridDate(last.closed_at))
    throw new Error('El inicio no puede preceder al cierre anterior');
  const id = randomUUID();
  db.exec('BEGIN');
  try {
    db.prepare(`INSERT INTO search_periods
      (id,property_id,status,rental_since,monthly_rent_cents,idealista_id,url,date_confirmed,created_at,original_idealista_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id,propertyId,'open',value.rentalSince,value.monthlyRentCents,
        value.idealistaId,value.url,1,new Date().toISOString(),value.idealistaId);
    db.prepare(`UPDATE properties SET monthly_rent_cents=?,rental_since=?,idealista_id=?,url=?,date_confirmed=1
      WHERE id=?`).run(value.monthlyRentCents,value.rentalSince,value.idealistaId,value.url,propertyId);
    rememberListing(db,propertyId,value.idealistaId);
    db.exec('COMMIT');
  } catch(error) { db.exec('ROLLBACK'); throw error; }
  return getPeriod(db,propertyId,id);
}

export function updatePeriod(db, propertyId, periodId, changes, today = localDay()) {
  assertOpenPeriod(db,propertyId,periodId);
  if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length ||
    Object.keys(changes).some(k=>!['rentalSince','monthlyRentCents','idealistaUrl'].includes(k)))
    throw new Error('Datos del periodo no válidos');
  updateProperty(db,propertyId,changes,today);
  return getPeriod(db,propertyId,periodId);
}

export function deleteProperty(db,id) {
  const property=getProperty(db,id,true);
  if (!property) return null;
  if (property.deletedAt) return {deleted:true,id};
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE properties SET deleted_at=?,deleted_default_idealista_id=idealista_id,
      deleted_default_url=url,idealista_id=NULL,url=NULL WHERE id=? AND deleted_at IS NULL`)
      .run(new Date().toISOString(),id);
    db.exec('COMMIT');
  } catch(error) { db.exec('ROLLBACK'); throw error; }
  return {deleted:true,id};
}

export function restoreProperty(db,id) {
  const property=getProperty(db,id,true);
  if (!property) return null;
  if (!property.deletedAt) return property;
  const ids=[property.defaultIdealistaId,getOpenPeriod(db,id)?.idealistaId].filter(Boolean);
  for(const listingId of ids) {
    const duplicate=db.prepare(`SELECT p.id FROM properties p
      LEFT JOIN search_periods s ON s.property_id=p.id AND s.status='open'
      WHERE p.id<>? AND p.deleted_at IS NULL AND (p.idealista_id=? OR s.idealista_id=?) LIMIT 1`)
      .get(id,listingId,listingId);
    if (duplicate) throw Object.assign(new Error('El anuncio ya está vinculado a otra vivienda activa'),
      {code:'DUPLICATE_PROPERTY'});
  }
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE properties SET idealista_id=deleted_default_idealista_id,
      url=deleted_default_url,deleted_default_idealista_id=NULL,deleted_default_url=NULL,
      deleted_at=NULL WHERE id=? AND deleted_at IS NOT NULL`).run(id);
    db.exec('COMMIT');
  } catch(error) { db.exec('ROLLBACK'); throw error; }
  return getProperty(db,id);
}

export function purgeProperty(db,id) {
  const property=getProperty(db,id,true);
  if (!property) return null;
  if (!property.deletedAt)
    throw Object.assign(new Error('Elimina primero la vivienda de forma recuperable'),{code:'PROPERTY_ACTIVE'});
  const periodIds=db.prepare('SELECT id,idealista_id,original_idealista_id FROM search_periods WHERE property_id=?').all(id);
  const sourceIds=new Set([property.defaultIdealistaId,
    ...periodIds.flatMap(row=>[row.idealista_id,row.original_idealista_id]),
    ...db.prepare('SELECT idealista_id FROM property_listing_history WHERE property_id=?')
      .all(id).map(row=>row.idealista_id),
    ...db.prepare('SELECT DISTINCT source_idealista_id FROM conversations WHERE period_id IN (SELECT id FROM search_periods WHERE property_id=?)')
      .all(id).map(row=>row.source_idealista_id),
    ...db.prepare('SELECT DISTINCT source_idealista_id FROM sync_source_baselines WHERE period_id IN (SELECT id FROM search_periods WHERE property_id=?)')
      .all(id).map(row=>row.source_idealista_id)].filter(Boolean));
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO purged_properties(id,purged_at) VALUES (?,?)').run(id,new Date().toISOString());
    const tombstonePeriod=db.prepare('INSERT INTO purged_periods(id,property_id) VALUES (?,?)');
    for(const row of periodIds) tombstonePeriod.run(row.id,id);
    const tombstoneSource=db.prepare('INSERT INTO purged_export_sources(idealista_id,property_id) VALUES (?,?)');
    for(const sourceId of sourceIds) tombstoneSource.run(sourceId,id);
    db.prepare('UPDATE search_periods SET chosen_applicant_id=NULL WHERE property_id=?').run(id);
    db.prepare(`DELETE FROM messages WHERE conversation_id IN
      (SELECT id FROM conversations WHERE period_id IN (SELECT id FROM search_periods WHERE property_id=?))`).run(id);
    db.prepare(`DELETE FROM profile_fields WHERE applicant_id IN
      (SELECT id FROM applicants WHERE property_id=?)`).run(id);
    db.prepare(`DELETE FROM sync_attention WHERE period_id IN
      (SELECT id FROM search_periods WHERE property_id=?)`).run(id);
    db.prepare(`DELETE FROM sync_batches WHERE period_id IN
      (SELECT id FROM search_periods WHERE property_id=?)`).run(id);
    db.prepare(`DELETE FROM sync_source_baselines WHERE period_id IN
      (SELECT id FROM search_periods WHERE property_id=?)`).run(id);
    db.prepare(`DELETE FROM conversations WHERE period_id IN
      (SELECT id FROM search_periods WHERE property_id=?)`).run(id);
    db.prepare('DELETE FROM visits WHERE property_id=?').run(id);
    db.prepare('DELETE FROM applicants WHERE property_id=?').run(id);
    db.prepare('DELETE FROM search_periods WHERE property_id=?').run(id);
    db.prepare('DELETE FROM property_listing_history WHERE property_id=?').run(id);
    db.prepare('DELETE FROM properties WHERE id=?').run(id);
    db.prepare('DELETE FROM property_settings WHERE id=?').run(id);
    db.exec('COMMIT');
  } catch(error) { db.exec('ROLLBACK'); throw error; }
  return {purged:true,id};
}

export function reopenPeriod(db, propertyId, periodId) {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!getProperty(db,propertyId))
      throw Object.assign(new Error('Vivienda no encontrada'),{code:'PROPERTY_NOT_FOUND'});
    const period=getPeriod(db,propertyId,periodId);
    if (!period) throw Object.assign(new Error('Periodo no encontrado'),{code:'PERIOD_NOT_FOUND'});
    if (period.status!=='closed')
      throw Object.assign(new Error('La búsqueda ya está abierta'),{code:'PERIOD_NOT_CLOSED'});
    if (getOpenPeriod(db,propertyId))
      throw Object.assign(new Error('Ya hay otra búsqueda abierta en esta vivienda'),{code:'PERIOD_OPEN'});
    const latest=db.prepare(`SELECT id FROM search_periods WHERE property_id=?
      ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(propertyId);
    if (latest.id!==periodId)
      throw Object.assign(new Error('No se puede reabrir una búsqueda con búsquedas posteriores'),{code:'PERIOD_NOT_LATEST'});
    if (duplicateActiveListing(db,period.idealistaId,propertyId))
      throw Object.assign(new Error('El anuncio de esta búsqueda ya está vinculado a otra vivienda activa'),{code:'DUPLICATE_PROPERTY'});
    db.prepare(`UPDATE search_periods SET status='open',chosen_applicant_id=NULL,closed_at=NULL,
      housing_title=NULL,housing_address=NULL WHERE id=? AND property_id=? AND status='closed'`)
      .run(periodId,propertyId);
    db.prepare(`UPDATE properties SET monthly_rent_cents=?,rental_since=?,idealista_id=?,url=?,date_confirmed=?
      WHERE id=?`).run(period.monthlyRentCents,period.rentalSince,period.idealistaId,period.url,
        Number(period.dateConfirmed),propertyId);
    db.exec('COMMIT');
  } catch(error) { db.exec('ROLLBACK'); throw error; }
  return getPeriod(db,propertyId,periodId);
}

export function closePeriod(db, propertyId, periodId, chosenApplicantId) {
  assertOpenPeriod(db,propertyId,periodId);
  if (typeof chosenApplicantId !== 'string' || !chosenApplicantId)
    throw new Error('Selecciona un interesado');
  db.exec('BEGIN');
  try {
    if (db.prepare(`SELECT 1 FROM visits WHERE period_id=? AND status IN
      ('pending_confirmation','confirmed') AND ends_at>? LIMIT 1`)
      .get(periodId,new Date().toISOString()))
      throw Object.assign(new Error('Hay visitas próximas en este periodo'),{code:'UPCOMING_VISITS'});
    const chosen = db.prepare('SELECT id FROM applicants WHERE id=? AND property_id=? AND period_id=?')
      .get(chosenApplicantId,propertyId,periodId);
    if (!chosen) throw Object.assign(new Error('Interesado no encontrado en este periodo'),{code:'APPLICANT_NOT_FOUND'});
    const housing = db.prepare('SELECT title,address FROM properties WHERE id=?').get(propertyId);
    const changed = db.prepare(`UPDATE search_periods SET status='closed',chosen_applicant_id=?,closed_at=?,
      housing_title=?,housing_address=? WHERE id=? AND property_id=? AND status='open'`)
      .run(chosenApplicantId,new Date().toISOString(),housing.title,housing.address,periodId,propertyId).changes;
    if (!changed) throw Object.assign(new Error('El periodo está cerrado'),{code:'PERIOD_CLOSED'});
    db.exec('COMMIT');
  } catch(error) { db.exec('ROLLBACK'); throw error; }
  return getPeriod(db,propertyId,periodId);
}
