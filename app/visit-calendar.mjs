const STATUS_MAP = Object.freeze({
  pending_confirmation: 'TENTATIVE',
  confirmed: 'CONFIRMED',
  completed: 'CONFIRMED',
  cancelled: 'CANCELLED'
});

const CALENDAR_HEADER = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Morada//Calendario de visitas//ES',
  'CALSCALE:GREGORIAN'
];

function timestamp(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) {
    throw new TypeError(`${field} debe ser una fecha ISO UTC válida`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${field} debe ser una fecha ISO UTC válida`);
  const iso = date.toISOString();
  const canonicalInput = value.includes('.')
    ? value.replace(/\.(\d{1,3})Z$/, (_, fraction) => `.${fraction.padEnd(3, '0')}Z`)
    : value.replace(/Z$/, '.000Z');
  if (iso !== canonicalInput) throw new TypeError(`${field} debe ser una fecha ISO UTC válida`);
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function opaqueUid(id) {
  if (typeof id !== 'string' || id.length === 0 || id.length > 256 || [...id].some((character) => {
    const code = character.codePointAt(0);
    return code < 0x20 || code === 0x7f;
  })) {
    throw new TypeError('id de visita no válido');
  }
  return `visita-${Buffer.from(id, 'utf8').toString('base64url')}@morada.local`;
}

function foldLine(line) {
  const output = [];
  let current = '';
  let bytes = 0;
  for (const character of line) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > 75) {
      output.push(current);
      current = ` ${character}`;
      bytes = 1 + size;
    } else {
      current += character;
      bytes += size;
    }
  }
  output.push(current);
  return output.join('\r\n');
}

function eventLines(visit) {
  if (!visit || typeof visit !== 'object' || Array.isArray(visit)) throw new TypeError('visita no válida');
  if (typeof visit.status !== 'string' || !Object.hasOwn(STATUS_MAP, visit.status)) {
    throw new TypeError('estado de visita no válido');
  }
  const status = STATUS_MAP[visit.status];
  const start = timestamp(visit.startsAt, 'startsAt');
  const end = timestamp(visit.endsAt, 'endsAt');
  const created = timestamp(visit.createdAt, 'createdAt');
  const updated = timestamp(visit.updatedAt, 'updatedAt');
  if (end <= start) throw new TypeError('endsAt debe ser posterior a startsAt');
  return [
    'BEGIN:VEVENT',
    `UID:${opaqueUid(visit.id)}`,
    `DTSTAMP:${updated}`,
    `CREATED:${created}`,
    `LAST-MODIFIED:${updated}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    'SUMMARY:Visita de vivienda',
    `STATUS:${status}`,
    'END:VEVENT'
  ];
}

export function generateVisitCalendar(visits) {
  if (!Array.isArray(visits)) throw new TypeError('visits debe ser una lista');
  const lines = [...CALENDAR_HEADER];
  for (const visit of visits) lines.push(...eventLines(visit));
  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
