import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, open, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const demoNow = '2026-10-15T10:00:00.000Z';
const root = fileURLToPath(new URL('../', import.meta.url));

// Always allocate a new database. Never accept a database path or inherit runtime settings.
export async function createDemo() {
  process.umask(0o077);
  const parent = path.join(root, '.demo');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  assert.ok((await lstat(parent)).isDirectory(), '.demo debe ser un directorio propio, no un enlace simbólico');
  const directory = await mkdtemp(path.join(parent, 'session-'));
  const legacy = path.join(directory, 'empty-legacy.json');
  await writeFile(legacy, 'null\n', { flag: 'wx', mode: 0o600 });
  // The legacy module otherwise reads .local/legacy-property.json even without an env override.
  process.env.IDEALISTA_LEGACY_PROPERTY_FILE = legacy;
  const filename = path.join(directory, 'synthetic.sqlite');
  const handle = await open(filename, 'wx', 0o600);
  await handle.close();
  const database = await import('../app/database.mjs');
  const { createServer } = await import('../app/server.mjs');
  const { createVisit, updateCalendarSettings } = await import('../app/visits.mjs');
  const db = database.openDatabase(filename);
  assert.equal(db.prepare('SELECT count(*) AS n FROM properties').get().n, 0);
  const { createProperty, createPeriod, closePeriod, createManualApplicant, importConversation,
    updateApplicant, recordSyncAttention, deleteProperty } = database;
  const property = (title, address, rent, listing) => createProperty(db, { title, address,
    monthlyRentCents: rent * 100, rentalSince: '2026-10-01',
    idealistaUrl: listing ? `https://www.idealista.com/inmueble/${listing}/` : null }, '2026-10-15');
  const homes = {
    garden: property('Piso del Jardín', 'Calle del Ejemplo, 12 · Ciudad Demo', 950, '99000001'),
    terrace: property('Ático de la Terraza', 'Plaza Imaginaria, 4 · Ciudad Demo', 1200, '99000002'),
    rented: property('Estudio del Mirador', 'Avenida de la Muestra, 8 · Ciudad Demo', 720, '99000003'),
    empty: property('Apartamento del Lago', 'Paseo Ficticio, 3 · Ciudad Demo', 850, null),
    deleted: property('Loft del Taller', 'Calle de la Maqueta, 6 · Ciudad Demo', 800, null),
  };
  const people = {};
  let serial = 99000100;
  function chat(home, name, fields, texts, options = {}) {
    const id = String(++serial), day = options.day ?? '2026-10-14';
    const messages = texts.map(([direction, text], i) => ({ sequence: i + 1, direction, text,
      rawText: text, author: direction === 'received' ? name : 'Propietario (tu cuenta)',
      dateLabel: day, messageDate: day, time: `10:${String(15 + i * 5).padStart(2, '0')}`,
      occurredAt: `${day}T08:${String(15 + i * 5).padStart(2, '0')}:00.000Z` }));
    const data = { id, name, activityDate: day, listedDate: messages.at(-1).time, exportedAt: demoNow,
      properties: [{ url: home.url, text: home.title }], messages,
      profile: { text: fields.join('\n'), fields },
      integrity: { history: 'completo', profile: fields.length ? 'completo' : 'no disponible', notes: ['Conversación ficticia para documentación.'] } };
    importConversation(db, data, `synthetic/${id}.json`, day, home.id, home.activePeriodId, '2026-10-15');
    const applicant = db.prepare('SELECT applicant_id FROM conversations WHERE external_chat_id=?').get(id).applicant_id;
    updateApplicant(db, applicant, { favorite: !!options.favorite, discarded: !!options.discarded,
      notes: options.notes ?? '' }, home.id, home.activePeriodId);
    if (options.attention) recordSyncAttention(db, applicant, home.activePeriodId, options.attention, options.attention === 'message' ? 1 : 0);
    return { id: applicant, name, home };
  }
  people.ana = chat(homes.garden, 'Ana Ejemplo', ['Somos una pareja', 'Sin menores', 'Con mascota', 'Ingresos mensuales del grupo: 3.600 €'], [
    ['received', 'Hola, nos interesa el piso. Buscamos una vivienda luminosa para una estancia larga.'],
    ['sent', 'Hola, Ana. Podemos organizar una visita el jueves a las 17:00.'],
    ['received', 'Nos encaja. ¿Podemos ver también el espacio para guardar las bicicletas?'],
  ], { favorite: true, attention: 'message', notes: 'Visita prevista para el jueves. Preguntar por la fecha de entrada y enseñar el trastero.' });
  people.bruno = chat(homes.garden, 'Bruno Muestra', ['1 persona', 'Sin menores', 'Sin mascota', 'Ingreso mensual: 2.400 €'], [
    ['received', 'Buenas tardes. ¿Sigue disponible? Me gustaría visitarlo la próxima semana.'],
  ], { attention: 'new', day: '2026-10-15' });
  people.celia = chat(homes.garden, 'Celia Ilustración', ['Somos 3 personas', 'Hay menores: sí', 'Sin mascota', 'Ingresos mensuales del grupo: 4.200 €'], [
    ['received', 'Estamos buscando casa cerca del colegio. ¿Hay ascensor?'],
    ['sent', 'Sí, el edificio tiene ascensor. Tengo disponibilidad el viernes por la tarde.'],
  ], { favorite: true });
  people.dario = chat(homes.garden, 'Darío Modelo', ['1 persona', 'Sin menores', 'Sin mascota', 'Ingreso mensual: 2.100 €'], [
    ['received', 'Gracias por la información. Finalmente he encontrado otra vivienda.'],
  ], { discarded: true, notes: 'Ha encontrado otra vivienda. Conservar la conversación como referencia.' });
  people.elena = chat(homes.garden, 'Elena Ficción', [], [['received', 'Hola, ¿cuál es la fecha de entrada disponible?']]);
  people.felix = chat(homes.garden, 'Félix Prototipo', ['Somos una pareja', 'Sin menores', 'Sin mascota', 'Ingresos mensuales del grupo: 3.100 €'], [
    ['received', 'Nos interesa entrar el mes que viene.'], ['sent', 'Gracias. ¿Qué día os viene bien para visitar el piso?'],
  ]);
  const manual = createManualApplicant(db, homes.garden.id, { name: 'Gloria Demostración',
    email: 'gloria@example.test', peopleCount: 2, hasChildren: false, hasPets: true,
    monthlyIncomeCents: 320000, incomeScope: 'grupo', notes: 'Contacto ficticio añadido durante una jornada de puertas abiertas.' }, homes.garden.activePeriodId);
  people.gloria = { id: manual.applicant_id, name: manual.name, home: homes.garden };
  people.hugo = chat(homes.terrace, 'Hugo Boceto', ['Somos una pareja', 'Sin menores', 'Sin mascota', 'Ingresos mensuales del grupo: 4.500 €'], [['received', 'Nos gustaría conocer la terraza y la orientación del ático.']], { favorite: true });
  people.ines = chat(homes.rented, 'Inés Ensayo', ['1 persona', 'Sin menores', 'Sin mascota', 'Ingreso mensual: 2.800 €'], [['received', 'La vivienda nos encaja. Podemos confirmar la fecha de entrada.']], { favorite: true, day: '2026-10-09', notes: 'Persona elegida en esta búsqueda ficticia.' });
  closePeriod(db, homes.rented.id, homes.rented.activePeriodId, people.ines.id);
  db.prepare('UPDATE search_periods SET closed_at=? WHERE id=?').run('2026-10-10T10:00:00.000Z', homes.rented.activePeriodId);
  // A second housing also demonstrates a historical period followed by an open search.
  const former = createManualApplicant(db, homes.empty.id, { name: 'Jorge Simulación' }, homes.empty.activePeriodId);
  closePeriod(db, homes.empty.id, homes.empty.activePeriodId, former.applicant_id);
  db.prepare('UPDATE search_periods SET rental_since=?,closed_at=? WHERE id=?')
    .run('2026-08-01', '2026-09-01T10:00:00.000Z', homes.empty.activePeriodId);
  const next = createPeriod(db, homes.empty.id, { rentalSince: '2026-10-01', monthlyRentCents: 85000 }, '2026-10-15');
  homes.empty.activePeriodId = next.id;
  createManualApplicant(db, homes.deleted.id, { name: 'Lola Plantilla', notes: 'Ficha sintética recuperable con la vivienda.' }, homes.deleted.activePeriodId);
  deleteProperty(db, homes.deleted.id);
  updateCalendarSettings(db, { travelBufferMinutes: 30 });
  const visits = {};
  for (const [key, person, day, time, status] of [
    ['ana', people.ana, '15', '17:00', 'confirmed'],
    ['bruno', people.bruno, '15', '18:00', 'pending_confirmation'],
    ['hugo', people.hugo, '15', '19:00', 'confirmed'],
    ['celia', people.celia, '16', '17:30', 'confirmed'],
    ['felix', people.felix, '13', '12:00', 'completed'],
    ['gloria', people.gloria, '15', '16:00', 'cancelled'],
  ]) visits[key] = createVisit(db, person.home.id, person.home.activePeriodId, person.id,
    { startLocal: `2026-10-${day}T${time}`, timezone: 'Europe/Madrid', durationMinutes: 30, status });
  // Normalize synthetic creation times only; real databases are never opened by this module.
  for (const table of ['properties', 'applicants', 'search_periods', 'visits']) db.prepare(`UPDATE ${table} SET created_at=?`).run('2026-10-01T08:00:00.000Z');
  db.exec(`UPDATE search_periods SET created_at=rental_since||'T08:00:00.000Z';
    UPDATE properties SET created_at=(SELECT min(created_at) FROM search_periods WHERE property_id=properties.id);
    UPDATE applicants SET created_at=(SELECT created_at FROM search_periods WHERE id=applicants.period_id),
      created_date=(SELECT rental_since FROM search_periods WHERE id=applicants.period_id);`);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ synthetic: true, referenceDate: demoNow,
    database: 'synthetic.sqlite', homes, people, visits }, null, 2) + '\n', { flag: 'wx' });
  const server = createServer(db, { today: () => '2026-10-15', exportsRoot: path.join(directory, 'exports'),
    spawnWorker: () => { throw new Error('La sincronización con Chrome está desactivada en la demostración.'); } });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { db, server, directory, filename, homes, people, visits,
    url: `http://127.0.0.1:${server.address().port}`,
    close: async () => { await new Promise(resolve => server.close(resolve)); db.close(); } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const demo = await createDemo();
  console.log(`Morada · demostración con datos ficticios · ${demo.url}`);
  console.log('Base nueva e independiente. Chrome y la sincronización real están desactivados. Ctrl+C para cerrar.');
  const stop = async () => { await demo.close(); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
