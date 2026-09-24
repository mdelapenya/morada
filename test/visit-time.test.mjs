import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTimeZone, localDateTimeParts, localTimeCandidates,
  civilDayBounds, addCivilDays } from '../app/public/visit-time.mjs';

test('IANA zones, fractional offsets and local time candidates',()=>{
  assert.equal(normalizeTimeZone('UTC'),'UTC');
  assert.throws(()=>normalizeTimeZone('+05:30'));
  assert.throws(()=>normalizeTimeZone('Unknown/Zone'));
  assert.throws(()=>normalizeTimeZone(60));
  assert.deepEqual(localDateTimeParts('2026-09-25T04:15:00.000Z','Asia/Kathmandu'),
    {date:'2026-09-25',time:'10:00',utcOffsetMinutes:345});
  assert.deepEqual(localTimeCandidates('2026-09-25T10:00','Asia/Kathmandu'),
    [{instant:'2026-09-25T04:15:00.000Z',utcOffsetMinutes:345}]);
  assert.deepEqual(localTimeCandidates('2026-09-25T10:00','Asia/Kolkata'),
    [{instant:'2026-09-25T04:30:00.000Z',utcOffsetMinutes:330}]);
  assert.deepEqual(localTimeCandidates('2026-09-25T10:00','UTC'),
    [{instant:'2026-09-25T10:00:00.000Z',utcOffsetMinutes:0}]);
});

test('DST gaps and folds include Madrid, New York and Lord Howe',()=>{
  assert.deepEqual(localTimeCandidates('2026-03-29T02:30','Europe/Madrid'),[]);
  assert.deepEqual(localTimeCandidates('2026-10-25T02:30','Europe/Madrid').map(x=>x.utcOffsetMinutes),[120,60]);
  assert.deepEqual(localTimeCandidates('2026-03-08T02:30','America/New_York'),[]);
  assert.deepEqual(localTimeCandidates('2026-11-01T01:30','America/New_York').map(x=>x.utcOffsetMinutes),[-240,-300]);
  assert.deepEqual(localTimeCandidates('2026-04-05T01:45','Australia/Lord_Howe').map(x=>x.utcOffsetMinutes),[660,630]);
  assert.deepEqual(localTimeCandidates('2026-10-04T02:15','Australia/Lord_Howe'),[]);
  for(const invalid of ['2026-02-30T10:00','2026-13-01T10:00','2026-09-25T24:00','2026-09-25T10:60'])
    assert.throws(()=>localTimeCandidates(invalid,'UTC'));
});

test('civil day bounds follow short, long, fractional and skipped days',()=>{
  const duration=(date,zone)=>{
    const bounds=civilDayBounds(date,zone);
    return (Date.parse(bounds.endsAt)-Date.parse(bounds.startsAt))/3600000;
  };
  assert.equal(duration('2026-03-29','Europe/Madrid'),23);
  assert.equal(duration('2026-10-25','Europe/Madrid'),25);
  assert.equal(duration('2026-04-05','Australia/Lord_Howe'),24.5);
  assert.equal(duration('2026-10-04','Australia/Lord_Howe'),23.5);
  assert.equal(duration('2011-12-30','Pacific/Apia'),0);
  assert.equal(civilDayBounds('2011-12-30','Pacific/Apia').startsAt,
    civilDayBounds('2011-12-30','Pacific/Apia').endsAt);
  assert.equal(addCivilDays('2024-02-28',1),'2024-02-29');
  assert.throws(()=>addCivilDays('2026-02-30',1));
});
