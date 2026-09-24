import test from 'node:test';
import assert from 'node:assert/strict';
import { generateVisitCalendar } from '../app/visit-calendar.mjs';

const visit = (overrides = {}) => ({
  id: 'visit-1',
  startsAt: '2026-10-01T10:00:00Z',
  endsAt: '2026-10-01T10:30:00Z',
  status: 'pending_confirmation',
  createdAt: '2026-09-24T12:00:00Z',
  updatedAt: '2026-09-24T13:00:00Z',
  ...overrides
});

test('exports UTC event data and maps visit states', () => {
  const calendar = generateVisitCalendar([
    visit(),
    visit({ id: 'visit-2', status: 'confirmed' }),
    visit({ id: 'visit-3', status: 'completed' }),
    visit({ id: 'visit-4', status: 'cancelled' })
  ]);
  assert.match(calendar, /^BEGIN:VCALENDAR\r\nVERSION:2\.0\r\n/);
  assert.match(calendar, /DTSTART:20261001T100000Z\r\nDTEND:20261001T103000Z/);
  assert.match(calendar, /STATUS:TENTATIVE/);
  assert.equal((calendar.match(/STATUS:CONFIRMED/g) ?? []).length, 2);
  assert.match(calendar, /STATUS:CANCELLED/);
  assert.match(calendar, /DTSTAMP:20260924T130000Z\r\nCREATED:20260924T120000Z\r\nLAST-MODIFIED:20260924T130000Z/);
  assert.match(calendar, /SUMMARY:Visita de vivienda/);
  assert.ok(calendar.endsWith('END:VCALENDAR\r\n'));
  assert.ok(!/(^|[^\r])\n/.test(calendar));
});

test('keeps an opaque stable UID when a visit is rescheduled or cancelled', () => {
  const before = generateVisitCalendar([visit()]).match(/UID:(.+)/)?.[1];
  const after = generateVisitCalendar([visit({ startsAt: '2026-10-03T09:00:00Z', endsAt: '2026-10-03T09:30:00Z', status: 'cancelled' })]).match(/UID:(.+)/)?.[1];
  assert.equal(after, before);
  assert.match(before, /^visita-[A-Za-z0-9_-]+@morada\.local$/);
});

test('uses CRLF, folds at 75 UTF-8 octets without splitting Unicode', () => {
  const calendar = generateVisitCalendar([visit({ id: 'á'.repeat(40) })]);
  for (const line of calendar.slice(0, -2).split('\r\n')) assert.ok(Buffer.byteLength(line, 'utf8') <= 75);
  assert.ok(!/(^|[^\r])\n/.test(calendar));
  assert.match(calendar, /\r\n /);
});

test('exports an empty calendar and multiple events', () => {
  assert.equal(generateVisitCalendar([]), 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Morada//Calendario de visitas//ES\r\nCALSCALE:GREGORIAN\r\nEND:VCALENDAR\r\n');
  assert.equal((generateVisitCalendar([visit(), visit({ id: 'visit-2' })]).match(/BEGIN:VEVENT/g) ?? []).length, 2);
});

test('never exports private applicant, property, chat, or contact fields', () => {
  const calendar = generateVisitCalendar([visit({
    applicantName: 'Nombre privado', email: 'private@example.test', phone: '600000000',
    message: 'Mensaje privado', address: 'Dirección privada', property: 'Casa privada', chatId: 'chat-private'
  })]);
  for (const privateValue of ['Nombre privado', 'private@example.test', '600000000', 'Mensaje privado', 'Dirección privada', 'Casa privada', 'chat-private']) {
    assert.ok(!calendar.includes(privateValue));
  }
  for (const forbidden of ['DESCRIPTION:', 'LOCATION:', 'ATTENDEE:', 'ORGANIZER:', 'METHOD:']) assert.ok(!calendar.includes(forbidden));
});

test('rejects malformed ids, dates, intervals, and statuses', () => {
  assert.throws(() => generateVisitCalendar([visit({ id: 'bad\r\nSUMMARY:injected' })]), /id/);
  assert.throws(() => generateVisitCalendar([visit({ startsAt: 'tomorrow' })]), /startsAt/);
  assert.throws(() => generateVisitCalendar([visit({ startsAt: '2026-02-30T10:00:00Z' })]), /startsAt/);
  assert.throws(() => generateVisitCalendar([visit({ endsAt: '2026-10-01T09:00:00Z' })]), /posterior/);
  assert.throws(() => generateVisitCalendar([visit({ status: 'unknown' })]), /estado/);
  assert.throws(() => generateVisitCalendar([visit({ status: 'constructor' })]), /estado/);
  assert.throws(() => generateVisitCalendar([visit({ status: 'toString' })]), /estado/);
  assert.throws(() => generateVisitCalendar([visit({ status: 1 })]), /estado/);
});
